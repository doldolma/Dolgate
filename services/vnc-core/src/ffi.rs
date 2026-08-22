//! 모바일 FFI 세션 계층 (C ABI).
//!
//! iOS(staticlib → XCFramework)와 Android(cdylib → JNI)가 호출할 수 있는 opaque-handle API.
//!
//! # 수명 계약
//!
//! - `dvnc_session_create` → opaque handle(process-local token) 반환. caller가 소유한다.
//! - `dvnc_session_start` → 워커 스레드를 띄운다. 콜백은 워커 스레드에서 호출된다.
//! - `dvnc_session_disconnect` → 워커에게 종료를 요청한다(비동기). closed 콜백이 와야 완료.
//! - `dvnc_session_destroy` → handle을 해제하고 워커를 join한다. disconnect가 먼저 불려야 한다.
//!   워커 콜백 안에서 호출하면 종료만 요청하고 **`DVNC_ERR_CALLBACK_THREAD`**(-7)를 반환한다.
//!   그때 registry 소유권은 유지되므로 **caller는 user_data를 해제해서는 안 되고**, 콜백 밖의
//!   다른 스레드에서 다시 destroy해야 한다. 이 코드를 일반 실패로 다루면 워커가 살아 있는
//!   상태에서 user_data가 사라져 use-after-free가 된다.
//!   이미 destroy된 handle로 호출하면 `DVNC_ERR_INVALID_HANDLE`.
//!
//! # Handle 안전성
//!
//! opaque pointer 값은 **절대 역참조하지 않는다**. process-local monotonic token을
//! `*mut c_void`로 캐스팅해 반환할 뿐이고, 내부 registry(`OnceLock<Mutex<HashMap>>`)가
//! token → `Arc<Session>`을 소유한다. destroy는 registry에서 제거한 뒤 Arc drop으로
//! worker join을 보장하며, 이후 같은 token으로의 호출은 `DVNC_ERR_INVALID_HANDLE`이다.
//! double-destroy와 concurrent destroy는 모두 안전하다(registry lookup이 실패할 뿐).
//!
//! # 스레드 안전
//!
//! 모든 `dvnc_session_*` 함수는 같은 handle에 대해 어느 스레드에서든 호출해도 안전하다.
//! registry Mutex가 보호한다.
//!
//! # 콜백 수명
//!
//! 프레임·커서 콜백의 `pixels`/`rgba` 포인터는 **콜백 호출 중에만 유효**하다. caller는
//! 콜백 안에서 복사하거나 렌더 커맨드에 넘겨야 한다. 콜백에서 반환하면 포인터가 무효화된다.
//!
//! # user_data
//!
//! callback table의 `user_data`는 caller가 관리하는 불투명 포인터다. 모든 콜백에 그대로
//! 전달된다. Rust 쪽에서 해제하지 않는다. caller가 destroy 전후로 직접 해제해야 한다.
//!
//! # Panic 정책
//!
//! Rust panic은 ABI를 넘지 않는다. 모든 `#[no_mangle]` 함수는 `catch_unwind`로 감싸며,
//! panic 발생 시 `DVNC_ERR_PANIC`을 반환한다.

use std::collections::HashMap;
use std::ffi::{c_char, c_void, CStr};
use std::io;
use std::panic::catch_unwind;
use std::ptr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

use crate::protocol::ConnectPayload;
use crate::session;
use crate::session::SessionHandle;
use crate::sink::{CursorShape, FrameRect, VncEvent, VncSink};

// ────────────────────────────────────────────────────────────────────
// 에러 코드
// ────────────────────────────────────────────────────────────────────

/// 성공.
pub const DVNC_OK: i32 = 0;
/// null 포인터가 전달되었다.
pub const DVNC_ERR_NULL: i32 = -1;
/// 잘못된 UTF-8 문자열.
pub const DVNC_ERR_INVALID_UTF8: i32 = -2;
/// 세션이 이미 시작되었다.
pub const DVNC_ERR_ALREADY_STARTED: i32 = -3;
/// 세션이 이미 파괴되었거나 유효하지 않다.
pub const DVNC_ERR_INVALID_HANDLE: i32 = -4;
/// 숫자 인수나 열거형 값이 유효 범위를 벗어났다.
pub const DVNC_ERR_INVALID_ARGUMENT: i32 = -6;
/// 내부 패닉이 잡혔다.
pub const DVNC_ERR_PANIC: i32 = -99;
/// 내부 오류(스레드 생성 실패, channel failure, poisoned mutex 등).
pub const DVNC_ERR_INTERNAL: i32 = -5;
/// 워커 콜백 스레드에서 destroy 를 불렀다. 종료는 요청됐고, 다른 스레드에서 다시 불러야 한다.
/// rdp-core 의 `DRDP_ERR_CALLBACK_THREAD` 와 같은 뜻·같은 값이다.
pub const DVNC_ERR_CALLBACK_THREAD: i32 = -7;

// ────────────────────────────────────────────────────────────────────
// 콜백 함수 타입
// ────────────────────────────────────────────────────────────────────

/// 연결 성공 콜백.
/// `name`은 null-terminated UTF-8이고 콜백 수명 동안 유효하다.
pub type DvncOnConnected = unsafe extern "C" fn(
    user_data: *mut c_void,
    desktop_width: u16,
    desktop_height: u16,
    name: *const c_char,
);

/// 화면 크기 변경 콜백.
pub type DvncOnResized =
    unsafe extern "C" fn(user_data: *mut c_void, desktop_width: u16, desktop_height: u16);

/// capabilities 변경 콜백. JSON으로 전달된다(작은 control 이벤트).
/// `json`은 null-terminated UTF-8이고 콜백 수명 동안 유효하다.
pub type DvncOnCapabilities = unsafe extern "C" fn(user_data: *mut c_void, json: *const c_char);

/// 클립보드 텍스트 수신 콜백.
/// `text`는 null-terminated UTF-8이고 콜백 수명 동안 유효하다.
pub type DvncOnClipboard = unsafe extern "C" fn(user_data: *mut c_void, text: *const c_char);

/// 에러 콜백.
/// `message`는 null-terminated UTF-8이고 콜백 수명 동안 유효하다.
pub type DvncOnError = unsafe extern "C" fn(user_data: *mut c_void, message: *const c_char);

/// 세션 종료 콜백. 이 뒤로는 더 이상 콜백이 오지 않는다.
pub type DvncOnClosed = unsafe extern "C" fn(user_data: *mut c_void);

/// RGBA 프레임 콜백.
/// `pixels`는 `width * height * 4` 바이트이고 **콜백 반환 전까지만 유효**하다.
pub type DvncOnFrame = unsafe extern "C" fn(
    user_data: *mut c_void,
    x: u16,
    y: u16,
    width: u16,
    height: u16,
    pixels: *const u8,
    pixels_len: u32,
);

/// 커서 모양 콜백.
/// `rgba`는 `width * height * 4` 바이트이고 **콜백 반환 전까지만 유효**하다.
/// width/height가 0이면 커서를 숨기라는 뜻이다.
pub type DvncOnCursor = unsafe extern "C" fn(
    user_data: *mut c_void,
    hotspot_x: u16,
    hotspot_y: u16,
    width: u16,
    height: u16,
    rgba: *const u8,
    rgba_len: u32,
);

/// 콜백 테이블.
///
/// 모든 콜백은 워커 스레드에서 호출된다. null인 콜백은 무시된다(optional).
/// `user_data`는 모든 콜백에 그대로 전달된다.
#[repr(C)]
pub struct DvncCallbacks {
    pub user_data: *mut c_void,
    pub on_connected: Option<DvncOnConnected>,
    pub on_resized: Option<DvncOnResized>,
    pub on_capabilities: Option<DvncOnCapabilities>,
    pub on_clipboard: Option<DvncOnClipboard>,
    pub on_error: Option<DvncOnError>,
    pub on_closed: Option<DvncOnClosed>,
    pub on_frame: Option<DvncOnFrame>,
    pub on_cursor: Option<DvncOnCursor>,
}

// user_data는 caller가 Send+Sync를 보장한다(C 계약).
unsafe impl Send for DvncCallbacks {}
unsafe impl Sync for DvncCallbacks {}

// ────────────────────────────────────────────────────────────────────
// 연결 구성
// ────────────────────────────────────────────────────────────────────

/// 연결 구성. C에서 채워 `dvnc_session_start`에 넘긴다.
#[repr(C)]
pub struct DvncConnectConfig {
    /// 호스트명. null-terminated UTF-8.
    pub host: *const c_char,
    /// 포트. 0이면 5900.
    pub port: u16,
    /// 비밀번호. null-terminated UTF-8. null이면 빈 문자열.
    pub password: *const c_char,
    /// 유저명(VeNCrypt Plain용). null이면 빈 문자열.
    pub username: *const c_char,
    /// 화질: "lossless", "balanced", "fast". null이면 lossless.
    pub image_quality: *const c_char,
    /// 다른 클라이언트와 공유할지. 0=exclusive, 1=shared.
    pub shared: u8,
    /// Go mobile loopback tunnel token. null/empty means direct TCP.
    pub tunnel_auth_token: *const c_char,
}

// ────────────────────────────────────────────────────────────────────
// Process-local token registry
// ────────────────────────────────────────────────────────────────────

/// 단조 증가 token 생성기. 0은 유효하지 않은 값으로 예약한다.
static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);

/// 전역 세션 registry. token → Arc<DvncSessionInner>.
fn registry() -> &'static Mutex<HashMap<u64, Arc<DvncSessionInner>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<u64, Arc<DvncSessionInner>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 세션 상태.
enum SessionState {
    /// 생성됨. 아직 시작 안 됨.
    Created,
    /// 워커 스레드가 돌고 있다.
    Running {
        handle: SessionHandle,
        thread: Option<thread::JoinHandle<()>>,
    },
    /// 파괴됨(registry에서 제거됨). 정상적으로는 도달 불가능.
    Destroyed,
}

/// 내부 세션 데이터. Arc로 감싸 registry가 소유한다.
struct DvncSessionInner {
    state: Mutex<SessionState>,
    callbacks: Arc<DvncCallbacks>,
}

/// 타입 안전을 위한 opaque 포인터 타입.
/// 실제로는 단조 증가 u64 token을 `*mut c_void`로 캐스팅한 것이다.
/// **절대 역참조하지 않는다.**
pub type DvncSessionHandle = *mut c_void;

/// token → DvncSessionHandle 변환.
fn token_to_handle(token: u64) -> DvncSessionHandle {
    token as usize as *mut c_void
}

/// DvncSessionHandle → token 변환.
fn handle_to_token(handle: DvncSessionHandle) -> u64 {
    handle as usize as u64
}

/// registry에서 세션을 찾는다. null이면 ERR_NULL, 없으면 ERR_INVALID_HANDLE.
fn lookup_session(handle: DvncSessionHandle) -> Result<Arc<DvncSessionInner>, i32> {
    if handle.is_null() {
        return Err(DVNC_ERR_NULL);
    }
    let token = handle_to_token(handle);
    let guard = registry().lock().map_err(|_| DVNC_ERR_INTERNAL)?;
    guard.get(&token).cloned().ok_or(DVNC_ERR_INVALID_HANDLE)
}

// ────────────────────────────────────────────────────────────────────
// VncSink 구현 (콜백 브릿지)
// ────────────────────────────────────────────────────────────────────

/// C 콜백을 VncSink로 감싸는 브릿지.
struct FfiSink {
    callbacks: Arc<DvncCallbacks>,
}

impl VncSink for FfiSink {
    fn on_frame(&self, _session_id: &str, frame: FrameRect<'_>) -> io::Result<()> {
        if let Some(cb) = self.callbacks.on_frame {
            unsafe {
                cb(
                    self.callbacks.user_data,
                    frame.x,
                    frame.y,
                    frame.width,
                    frame.height,
                    frame.pixels.as_ptr(),
                    frame.pixels.len() as u32,
                );
            }
        }
        Ok(())
    }

    fn on_cursor(&self, _session_id: &str, cursor: CursorShape<'_>) -> io::Result<()> {
        if let Some(cb) = self.callbacks.on_cursor {
            unsafe {
                cb(
                    self.callbacks.user_data,
                    cursor.hotspot_x,
                    cursor.hotspot_y,
                    cursor.width,
                    cursor.height,
                    cursor.rgba.as_ptr(),
                    cursor.rgba.len() as u32,
                );
            }
        }
        Ok(())
    }

    fn on_event(&self, _session_id: &str, event: VncEvent) -> io::Result<()> {
        match event {
            VncEvent::Connected {
                desktop_width,
                desktop_height,
                name,
            } => {
                if let Some(cb) = self.callbacks.on_connected {
                    let c_name =
                        std::ffi::CString::new(name).unwrap_or_else(|_| c"<invalid>".to_owned());
                    unsafe {
                        cb(
                            self.callbacks.user_data,
                            desktop_width,
                            desktop_height,
                            c_name.as_ptr(),
                        )
                    };
                }
            }
            VncEvent::Resized {
                desktop_width,
                desktop_height,
            } => {
                if let Some(cb) = self.callbacks.on_resized {
                    unsafe { cb(self.callbacks.user_data, desktop_width, desktop_height) };
                }
            }
            VncEvent::Capabilities(caps) => {
                if let Some(cb) = self.callbacks.on_capabilities {
                    let json = serde_json::to_string(&caps).unwrap_or_default();
                    let c_json = std::ffi::CString::new(json).unwrap_or_else(|_| c"{}".to_owned());
                    unsafe { cb(self.callbacks.user_data, c_json.as_ptr()) };
                }
            }
            VncEvent::Clipboard { text } => {
                if let Some(cb) = self.callbacks.on_clipboard {
                    let c_text = std::ffi::CString::new(text).unwrap_or_else(|_| c"".to_owned());
                    unsafe { cb(self.callbacks.user_data, c_text.as_ptr()) };
                }
            }
            VncEvent::ClipboardLossy { .. } => {
                // 모바일에서는 별도 알림 불필요 — 무시
            }
            VncEvent::Closed => {
                if let Some(cb) = self.callbacks.on_closed {
                    unsafe { cb(self.callbacks.user_data) };
                }
            }
            VncEvent::Error { message } => {
                if let Some(cb) = self.callbacks.on_error {
                    let c_msg =
                        std::ffi::CString::new(message).unwrap_or_else(|_| c"<error>".to_owned());
                    unsafe { cb(self.callbacks.user_data, c_msg.as_ptr()) };
                }
            }
        }
        Ok(())
    }
}

// ────────────────────────────────────────────────────────────────────
// 헬퍼
// ────────────────────────────────────────────────────────────────────

/// null-safe C 문자열 → Rust String. null이면 빈 문자열.
unsafe fn cstr_to_string(ptr: *const c_char) -> Result<String, i32> {
    if ptr.is_null() {
        return Ok(String::new());
    }
    CStr::from_ptr(ptr)
        .to_str()
        .map(|s| s.to_owned())
        .map_err(|_| DVNC_ERR_INVALID_UTF8)
}

// ────────────────────────────────────────────────────────────────────
// 공개 C ABI
// ────────────────────────────────────────────────────────────────────

/// 새 세션 handle을 만든다.
///
/// `callbacks`가 null이면 `DVNC_ERR_NULL`을 반환하고 `out_handle`에 null을 쓴다.
/// 성공 시 `out_handle`에 opaque 포인터(process-local token)를 쓰고 `DVNC_OK`를 반환한다.
///
/// # Safety
/// `callbacks`는 유효한 `DvncCallbacks` 구조체를 가리켜야 한다.
/// `out_handle`은 유효한 쓰기 가능 포인터여야 한다.
#[no_mangle]
pub unsafe extern "C" fn dvnc_session_create(
    callbacks: *const DvncCallbacks,
    out_handle: *mut DvncSessionHandle,
) -> i32 {
    if callbacks.is_null() || out_handle.is_null() {
        if !out_handle.is_null() {
            *out_handle = ptr::null_mut();
        }
        return DVNC_ERR_NULL;
    }

    let result = catch_unwind(|| {
        let cbs = Arc::new(ptr::read(callbacks));
        let token = NEXT_TOKEN.fetch_add(1, Ordering::Relaxed);
        let inner = Arc::new(DvncSessionInner {
            state: Mutex::new(SessionState::Created),
            callbacks: cbs,
        });

        match registry().lock() {
            Ok(mut guard) => {
                guard.insert(token, inner);
                Ok(token_to_handle(token))
            }
            Err(_) => Err(DVNC_ERR_INTERNAL),
        }
    });

    match result {
        Ok(Ok(ptr)) => {
            *out_handle = ptr;
            DVNC_OK
        }
        Ok(Err(code)) => {
            *out_handle = ptr::null_mut();
            code
        }
        Err(_) => {
            *out_handle = ptr::null_mut();
            DVNC_ERR_PANIC
        }
    }
}

/// 세션을 시작한다(워커 스레드를 띄우고 VNC 서버에 연결한다).
///
/// 연결 결과는 비동기로 `on_connected` 또는 `on_error` 콜백으로 전달된다.
/// `run_with_sink`의 `register` 콜백은 네트워크 연결 전에 호출되므로,
/// 이 함수는 연결 완료까지 block하지 않고 register 콜백이 불린 직후 반환한다.
///
/// # Safety
/// `handle`은 `dvnc_session_create`에서 받은 유효한 포인터여야 한다.
/// `config`는 유효한 `DvncConnectConfig`를 가리켜야 한다.
#[no_mangle]
pub unsafe extern "C" fn dvnc_session_start(
    handle: DvncSessionHandle,
    config: *const DvncConnectConfig,
) -> i32 {
    if config.is_null() {
        return DVNC_ERR_NULL;
    }

    let result = catch_unwind(std::panic::AssertUnwindSafe(|| {
        let session = match lookup_session(handle) {
            Ok(s) => s,
            Err(e) => return e,
        };

        let cfg = &*config;
        let host = match cstr_to_string(cfg.host) {
            Ok(s) if s.is_empty() => return DVNC_ERR_NULL,
            Ok(s) => s,
            Err(e) => return e,
        };
        let password = match cstr_to_string(cfg.password) {
            Ok(s) => s,
            Err(e) => return e,
        };
        let username = match cstr_to_string(cfg.username) {
            Ok(s) => s,
            Err(e) => return e,
        };
        let image_quality = match cstr_to_string(cfg.image_quality) {
            Ok(s) => s,
            Err(e) => return e,
        };
        let tunnel_auth_token = match cstr_to_string(cfg.tunnel_auth_token) {
            Ok(value) if value.is_empty() => None,
            Ok(value) => Some(value),
            Err(error) => return error,
        };

        let port = if cfg.port == 0 { 5900 } else { cfg.port };
        let shared = cfg.shared != 0;

        let payload = ConnectPayload {
            host,
            port,
            password,
            username,
            image_quality,
            shared,
            tunnel_auth_token,
        };

        let mut state = match session.state.lock() {
            Ok(g) => g,
            Err(_) => return DVNC_ERR_INTERNAL,
        };
        match &*state {
            SessionState::Created => {}
            SessionState::Running { .. } => return DVNC_ERR_ALREADY_STARTED,
            SessionState::Destroyed => return DVNC_ERR_INVALID_HANDLE,
        }

        let sink: Arc<dyn VncSink> = Arc::new(FfiSink {
            callbacks: Arc::clone(&session.callbacks),
        });

        // 워커로 handle을 받아올 채널
        let (tx, rx) = std::sync::mpsc::channel::<SessionHandle>();

        let worker = match thread::Builder::new()
            .name("dvnc-worker".to_owned())
            .spawn(move || {
                let _ = session::run_with_sink(
                    "ffi-session".to_owned(),
                    "ffi-req".to_owned(),
                    payload,
                    sink,
                    |h| {
                        let _ = tx.send(h);
                    },
                );
            }) {
            Ok(handle) => handle,
            Err(_) => return DVNC_ERR_INTERNAL,
        };

        // register 콜백은 네트워크 연결 전에 즉시 불리므로 handle을 받을 수 있다.
        // channel failure는 worker가 register 전에 panic한 것 — 내부 오류.
        let session_handle = match rx.recv() {
            Ok(h) => h,
            Err(_) => return DVNC_ERR_INTERNAL,
        };

        *state = SessionState::Running {
            handle: session_handle,
            thread: Some(worker),
        };

        DVNC_OK
    }));

    result.unwrap_or(DVNC_ERR_PANIC)
}

/// 세션 연결을 끊는다.
///
/// 워커 스레드에 종료를 요청한다. 실제 종료는 비동기로 `on_closed` 콜백으로 알려진다.
/// 이미 끊겼거나 시작 안 된 세션에 불러도 안전하다(no-op).
///
/// # Safety
/// `handle`은 유효한 세션 포인터여야 한다.
#[no_mangle]
pub unsafe extern "C" fn dvnc_session_disconnect(handle: DvncSessionHandle) -> i32 {
    let result = catch_unwind(std::panic::AssertUnwindSafe(|| {
        let session = match lookup_session(handle) {
            Ok(s) => s,
            Err(e) => return e,
        };

        let state = match session.state.lock() {
            Ok(g) => g,
            Err(_) => return DVNC_ERR_INTERNAL,
        };
        if let SessionState::Running { handle: h, .. } = &*state {
            h.close();
        }
        DVNC_OK
    }));

    result.unwrap_or(DVNC_ERR_PANIC)
}

/// handle을 해제한다.
///
/// `dvnc_session_disconnect`를 먼저 불러 워커가 종료되게 한 뒤 부르는 것이 권장된다.
/// 이 함수는 워커 종료를 기다린 뒤(join) registry에서 제거한다.
/// 워커 콜백 안에서는 자기 자신을 join할 수 없으므로 종료만 요청하고
/// `DVNC_ERR_CALLBACK_THREAD`를 반환하며, registry 소유권은 유지된다. 다른 스레드에서
/// 재시도해야 하고, 그 전에 user_data를 해제하면 안 된다.
/// 이미 destroy된 handle에 불러도 안전하다(`DVNC_ERR_INVALID_HANDLE`).
///
/// # Safety
/// `handle`은 `dvnc_session_create`에서 받은 포인터여야 한다. 이후 handle은 무효.
#[no_mangle]
pub unsafe extern "C" fn dvnc_session_destroy(handle: DvncSessionHandle) -> i32 {
    if handle.is_null() {
        return DVNC_ERR_NULL;
    }

    let result = catch_unwind(std::panic::AssertUnwindSafe(|| {
        let token = handle_to_token(handle);

        // A callback runs on this exact worker. Removing the registry entry here would let the
        // caller free user_data while the callback is still using it, and joining would panic.
        // Keep ownership intact, request shutdown, and require a non-worker destroy retry.
        let session = match lookup_session(handle) {
            Ok(session) => session,
            Err(error) => return error,
        };
        {
            let state = match session.state.lock() {
                Ok(state) => state,
                Err(poisoned) => poisoned.into_inner(),
            };
            if let SessionState::Running {
                handle: worker_handle,
                thread: Some(worker),
            } = &*state
            {
                if worker.thread().id() == thread::current().id() {
                    worker_handle.close();
                    return DVNC_ERR_CALLBACK_THREAD;
                }
            }
        }
        drop(session);

        // registry에서 제거. 이후 같은 token으로의 lookup은 ERR_INVALID_HANDLE.
        let session = {
            let mut guard = match registry().lock() {
                Ok(g) => g,
                Err(_) => return DVNC_ERR_INTERNAL,
            };
            match guard.remove(&token) {
                Some(s) => s,
                None => return DVNC_ERR_INVALID_HANDLE,
            }
        };

        // state를 가져와 worker join을 수행한다.
        let mut state = match session.state.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };

        match std::mem::replace(&mut *state, SessionState::Destroyed) {
            SessionState::Running { handle: h, thread } => {
                // disconnect를 안 했으면 여기서 한다.
                h.close();
                drop(state); // unlock before join
                if let Some(t) = thread {
                    let _ = t.join();
                }
            }
            SessionState::Created | SessionState::Destroyed => {
                drop(state);
            }
        }

        // Arc가 drop되면서 남은 참조도 정리된다.
        drop(session);
        DVNC_OK
    }));

    result.unwrap_or(DVNC_ERR_PANIC)
}

/// 포인터 이동 이벤트를 보낸다.
///
/// # Safety
/// `handle`은 유효한 활성 세션이어야 한다.
#[no_mangle]
pub unsafe extern "C" fn dvnc_session_pointer_move(
    handle: DvncSessionHandle,
    x: u16,
    y: u16,
) -> i32 {
    let result = catch_unwind(std::panic::AssertUnwindSafe(|| {
        let session = match lookup_session(handle) {
            Ok(s) => s,
            Err(e) => return e,
        };
        let state = match session.state.lock() {
            Ok(g) => g,
            Err(_) => return DVNC_ERR_INTERNAL,
        };
        if let SessionState::Running { handle: h, .. } = &*state {
            let event = crate::protocol::InputEvent::MouseMove { x, y };
            let _ = h.send_input(&[event]);
            DVNC_OK
        } else {
            DVNC_ERR_INVALID_HANDLE
        }
    }));
    result.unwrap_or(DVNC_ERR_PANIC)
}

/// 마우스 버튼 이벤트를 보낸다.
///
/// `button`: 0=왼쪽, 1=가운데, 2=오른쪽.
///
/// # Safety
/// `handle`은 유효한 활성 세션이어야 한다.
#[no_mangle]
pub unsafe extern "C" fn dvnc_session_pointer_button(
    handle: DvncSessionHandle,
    button: u8,
    pressed: u8,
    x: u16,
    y: u16,
) -> i32 {
    let result = catch_unwind(std::panic::AssertUnwindSafe(|| {
        let session = match lookup_session(handle) {
            Ok(s) => s,
            Err(e) => return e,
        };
        let state = match session.state.lock() {
            Ok(g) => g,
            Err(_) => return DVNC_ERR_INTERNAL,
        };
        if let SessionState::Running { handle: h, .. } = &*state {
            let event = crate::protocol::InputEvent::MouseButton {
                button,
                pressed: pressed != 0,
                x,
                y,
            };
            let _ = h.send_input(&[event]);
            DVNC_OK
        } else {
            DVNC_ERR_INVALID_HANDLE
        }
    }));
    result.unwrap_or(DVNC_ERR_PANIC)
}

/// 스크롤 이벤트를 보낸다.
///
/// `vertical`: 0=수평, 1=수직. `delta`: 양수=위/오른쪽.
///
/// # Safety
/// `handle`은 유효한 활성 세션이어야 한다.
#[no_mangle]
pub unsafe extern "C" fn dvnc_session_pointer_scroll(
    handle: DvncSessionHandle,
    vertical: u8,
    delta: i16,
    x: u16,
    y: u16,
) -> i32 {
    let result = catch_unwind(std::panic::AssertUnwindSafe(|| {
        let session = match lookup_session(handle) {
            Ok(s) => s,
            Err(e) => return e,
        };
        let state = match session.state.lock() {
            Ok(g) => g,
            Err(_) => return DVNC_ERR_INTERNAL,
        };
        if let SessionState::Running { handle: h, .. } = &*state {
            let event = crate::protocol::InputEvent::Wheel {
                vertical: vertical != 0,
                delta,
                x,
                y,
            };
            let _ = h.send_input(&[event]);
            DVNC_OK
        } else {
            DVNC_ERR_INVALID_HANDLE
        }
    }));
    result.unwrap_or(DVNC_ERR_PANIC)
}

/// 키 다운 이벤트를 보낸다.
///
/// `keysym`: X11 keysym. `keycode`: PS/2 set 1 scancode (0이면 무시).
///
/// # Safety
/// `handle`은 유효한 활성 세션이어야 한다.
#[no_mangle]
pub unsafe extern "C" fn dvnc_session_key_down(
    handle: DvncSessionHandle,
    keysym: u32,
    keycode: u32,
) -> i32 {
    let result = catch_unwind(std::panic::AssertUnwindSafe(|| {
        let session = match lookup_session(handle) {
            Ok(s) => s,
            Err(e) => return e,
        };
        let state = match session.state.lock() {
            Ok(g) => g,
            Err(_) => return DVNC_ERR_INTERNAL,
        };
        if let SessionState::Running { handle: h, .. } = &*state {
            let event = crate::protocol::InputEvent::Key {
                keysym,
                pressed: true,
                keycode,
            };
            let _ = h.send_input(&[event]);
            DVNC_OK
        } else {
            DVNC_ERR_INVALID_HANDLE
        }
    }));
    result.unwrap_or(DVNC_ERR_PANIC)
}

/// 키 업 이벤트를 보낸다.
///
/// # Safety
/// `handle`은 유효한 활성 세션이어야 한다.
#[no_mangle]
pub unsafe extern "C" fn dvnc_session_key_up(
    handle: DvncSessionHandle,
    keysym: u32,
    keycode: u32,
) -> i32 {
    let result = catch_unwind(std::panic::AssertUnwindSafe(|| {
        let session = match lookup_session(handle) {
            Ok(s) => s,
            Err(e) => return e,
        };
        let state = match session.state.lock() {
            Ok(g) => g,
            Err(_) => return DVNC_ERR_INTERNAL,
        };
        if let SessionState::Running { handle: h, .. } = &*state {
            let event = crate::protocol::InputEvent::Key {
                keysym,
                pressed: false,
                keycode,
            };
            let _ = h.send_input(&[event]);
            DVNC_OK
        } else {
            DVNC_ERR_INVALID_HANDLE
        }
    }));
    result.unwrap_or(DVNC_ERR_PANIC)
}

/// 클립보드 텍스트를 원격에 보낸다.
///
/// `text`는 null-terminated UTF-8. null이면 `DVNC_ERR_NULL`.
///
/// # Safety
/// `handle`은 유효한 활성 세션이어야 한다.
#[no_mangle]
pub unsafe extern "C" fn dvnc_session_send_clipboard(
    handle: DvncSessionHandle,
    text: *const c_char,
) -> i32 {
    if text.is_null() {
        return DVNC_ERR_NULL;
    }

    let result = catch_unwind(std::panic::AssertUnwindSafe(|| {
        let session = match lookup_session(handle) {
            Ok(s) => s,
            Err(e) => return e,
        };
        let text_str = match cstr_to_string(text) {
            Ok(s) => s,
            Err(e) => return e,
        };
        let state = match session.state.lock() {
            Ok(g) => g,
            Err(_) => return DVNC_ERR_INTERNAL,
        };
        if let SessionState::Running { handle: h, .. } = &*state {
            let _ = h.send_clipboard(text_str);
            DVNC_OK
        } else {
            DVNC_ERR_INVALID_HANDLE
        }
    }));
    result.unwrap_or(DVNC_ERR_PANIC)
}

/// 화면 전체를 다시 받는다(화면 깨짐 복구).
///
/// # Safety
/// `handle`은 유효한 활성 세션이어야 한다.
#[no_mangle]
pub unsafe extern "C" fn dvnc_session_refresh(handle: DvncSessionHandle) -> i32 {
    let result = catch_unwind(std::panic::AssertUnwindSafe(|| {
        let session = match lookup_session(handle) {
            Ok(s) => s,
            Err(e) => return e,
        };
        let state = match session.state.lock() {
            Ok(g) => g,
            Err(_) => return DVNC_ERR_INTERNAL,
        };
        if let SessionState::Running { handle: h, .. } = &*state {
            let _ = h.refresh_screen();
            DVNC_OK
        } else {
            DVNC_ERR_INVALID_HANDLE
        }
    }));
    result.unwrap_or(DVNC_ERR_PANIC)
}

/// 원격 데스크톱 크기 변경을 요청한다.
///
/// 서버가 지원하지 않으면 조용히 무시된다(에러 아님).
///
/// # Safety
/// `handle`은 유효한 활성 세션이어야 한다.
#[no_mangle]
pub unsafe extern "C" fn dvnc_session_request_desktop_size(
    handle: DvncSessionHandle,
    width: u16,
    height: u16,
) -> i32 {
    let result = catch_unwind(std::panic::AssertUnwindSafe(|| {
        let session = match lookup_session(handle) {
            Ok(s) => s,
            Err(e) => return e,
        };
        let state = match session.state.lock() {
            Ok(g) => g,
            Err(_) => return DVNC_ERR_INTERNAL,
        };
        if let SessionState::Running { handle: h, .. } = &*state {
            let _ = h.request_desktop_size(width, height);
            DVNC_OK
        } else {
            DVNC_ERR_INVALID_HANDLE
        }
    }));
    result.unwrap_or(DVNC_ERR_PANIC)
}

// ────────────────────────────────────────────────────────────────────
// 내부 테스트 (cfg(test) — production 빌드에서 제거됨)
// ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct TestCounter {
        frame: AtomicU32,
        connected: AtomicU32,
        clipboard: AtomicU32,
        closed: AtomicU32,
    }

    impl TestCounter {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                frame: AtomicU32::new(0),
                connected: AtomicU32::new(0),
                clipboard: AtomicU32::new(0),
                closed: AtomicU32::new(0),
            })
        }
    }

    unsafe extern "C" fn test_on_frame(
        user_data: *mut c_void,
        _x: u16,
        _y: u16,
        _w: u16,
        _h: u16,
        _pixels: *const u8,
        _len: u32,
    ) {
        let counter = &*(user_data as *const TestCounter);
        counter.frame.fetch_add(1, Ordering::SeqCst);
    }

    unsafe extern "C" fn test_on_connected(
        user_data: *mut c_void,
        _w: u16,
        _h: u16,
        _name: *const c_char,
    ) {
        let counter = &*(user_data as *const TestCounter);
        counter.connected.fetch_add(1, Ordering::SeqCst);
    }

    unsafe extern "C" fn test_on_clipboard(user_data: *mut c_void, _text: *const c_char) {
        let counter = &*(user_data as *const TestCounter);
        counter.clipboard.fetch_add(1, Ordering::SeqCst);
    }

    unsafe extern "C" fn test_on_closed(user_data: *mut c_void) {
        let counter = &*(user_data as *const TestCounter);
        counter.closed.fetch_add(1, Ordering::SeqCst);
    }

    fn make_test_callbacks(counter: &Arc<TestCounter>) -> DvncCallbacks {
        DvncCallbacks {
            user_data: Arc::as_ptr(counter) as *mut c_void,
            on_connected: Some(test_on_connected),
            on_resized: None,
            on_capabilities: None,
            on_clipboard: Some(test_on_clipboard),
            on_error: None,
            on_closed: Some(test_on_closed),
            on_frame: Some(test_on_frame),
            on_cursor: None,
        }
    }

    #[test]
    fn ffi_sink_bridge_delivers_frame_callback() {
        let counter = TestCounter::new();
        let cbs = make_test_callbacks(&counter);
        let cbs_arc = Arc::new(cbs);
        let sink = FfiSink { callbacks: cbs_arc };
        let pixels = vec![0u8; 4 * 10 * 10];
        sink.on_frame(
            "test",
            FrameRect {
                x: 0,
                y: 0,
                width: 10,
                height: 10,
                pixels: &pixels,
            },
        )
        .unwrap();
        assert_eq!(counter.frame.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn ffi_sink_bridge_delivers_event_callbacks() {
        let counter = TestCounter::new();
        let cbs = make_test_callbacks(&counter);
        let cbs_arc = Arc::new(cbs);
        let sink = FfiSink { callbacks: cbs_arc };

        sink.on_event(
            "test",
            VncEvent::Connected {
                desktop_width: 1920,
                desktop_height: 1080,
                name: "test".to_owned(),
            },
        )
        .unwrap();
        sink.on_event(
            "test",
            VncEvent::Clipboard {
                text: "hello 안녕".to_owned(),
            },
        )
        .unwrap();
        sink.on_event("test", VncEvent::Closed).unwrap();

        assert_eq!(counter.connected.load(Ordering::SeqCst), 1);
        assert_eq!(counter.clipboard.load(Ordering::SeqCst), 1);
        assert_eq!(counter.closed.load(Ordering::SeqCst), 1);
    }
}
