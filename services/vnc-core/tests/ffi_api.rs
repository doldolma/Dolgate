//! C ABI FFI 단위 테스트.
//!
//! 실제 VNC 서버 없이 handle 수명, 콜백 전달, 에러 경로, double-destroy 방어를 검증한다.
//! flaky TEST-NET 의존성을 제거하고 localhost fake listener를 사용한다.

use std::ffi::{c_char, c_void, CString};
use std::io::Write;
use std::net::TcpListener;
use std::ptr;
use std::sync::atomic::{AtomicI32, AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;

use vnc_core::ffi::*;

// ────────────────────────────────────────────────────────────────────
// 테스트 헬퍼
// ────────────────────────────────────────────────────────────────────

/// 테스트용 콜백 카운터.
struct CallbackCounter {
    connected: AtomicU32,
    resized: AtomicU32,
    error: AtomicU32,
    closed: AtomicU32,
    frame: AtomicU32,
    cursor: AtomicU32,
    clipboard: AtomicU32,
    capabilities: AtomicU32,
}

impl CallbackCounter {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            connected: AtomicU32::new(0),
            resized: AtomicU32::new(0),
            error: AtomicU32::new(0),
            closed: AtomicU32::new(0),
            frame: AtomicU32::new(0),
            cursor: AtomicU32::new(0),
            clipboard: AtomicU32::new(0),
            capabilities: AtomicU32::new(0),
        })
    }
}

unsafe extern "C" fn test_on_connected(
    user_data: *mut c_void,
    _w: u16,
    _h: u16,
    _name: *const c_char,
) {
    let counter = &*(user_data as *const CallbackCounter);
    counter.connected.fetch_add(1, Ordering::SeqCst);
}

unsafe extern "C" fn test_on_resized(user_data: *mut c_void, _w: u16, _h: u16) {
    let counter = &*(user_data as *const CallbackCounter);
    counter.resized.fetch_add(1, Ordering::SeqCst);
}

unsafe extern "C" fn test_on_capabilities(user_data: *mut c_void, _json: *const c_char) {
    let counter = &*(user_data as *const CallbackCounter);
    counter.capabilities.fetch_add(1, Ordering::SeqCst);
}

unsafe extern "C" fn test_on_clipboard(user_data: *mut c_void, _text: *const c_char) {
    let counter = &*(user_data as *const CallbackCounter);
    counter.clipboard.fetch_add(1, Ordering::SeqCst);
}

unsafe extern "C" fn test_on_error(user_data: *mut c_void, _msg: *const c_char) {
    let counter = &*(user_data as *const CallbackCounter);
    counter.error.fetch_add(1, Ordering::SeqCst);
}

unsafe extern "C" fn test_on_closed(user_data: *mut c_void) {
    let counter = &*(user_data as *const CallbackCounter);
    counter.closed.fetch_add(1, Ordering::SeqCst);
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
    let counter = &*(user_data as *const CallbackCounter);
    counter.frame.fetch_add(1, Ordering::SeqCst);
}

unsafe extern "C" fn test_on_cursor(
    user_data: *mut c_void,
    _hx: u16,
    _hy: u16,
    _w: u16,
    _h: u16,
    _rgba: *const u8,
    _len: u32,
) {
    let counter = &*(user_data as *const CallbackCounter);
    counter.cursor.fetch_add(1, Ordering::SeqCst);
}

fn make_callbacks(counter: &Arc<CallbackCounter>) -> DvncCallbacks {
    DvncCallbacks {
        user_data: Arc::as_ptr(counter) as *mut c_void,
        on_connected: Some(test_on_connected),
        on_resized: Some(test_on_resized),
        on_capabilities: Some(test_on_capabilities),
        on_clipboard: Some(test_on_clipboard),
        on_error: Some(test_on_error),
        on_closed: Some(test_on_closed),
        on_frame: Some(test_on_frame),
        on_cursor: Some(test_on_cursor),
    }
}

const CALLBACK_NOT_CALLED: i32 = i32::MIN;

struct CallbackDestroyAttempt {
    handle: AtomicUsize,
    result: AtomicI32,
}

unsafe extern "C" fn destroy_from_error_callback(
    user_data: *mut c_void,
    _message: *const c_char,
) {
    let attempt = &*(user_data as *const CallbackDestroyAttempt);
    let handle = attempt.handle.load(Ordering::SeqCst) as DvncSessionHandle;
    let result = dvnc_session_destroy(handle);
    attempt.result.store(result, Ordering::SeqCst);
}

// ────────────────────────────────────────────────────────────────────
// create/destroy 테스트
// ────────────────────────────────────────────────────────────────────

#[test]
fn create_and_destroy_without_start() {
    let counter = CallbackCounter::new();
    let cbs = make_callbacks(&counter);
    let mut handle: DvncSessionHandle = ptr::null_mut();

    unsafe {
        let rc = dvnc_session_create(&cbs, &mut handle);
        assert_eq!(rc, DVNC_OK);
        assert!(!handle.is_null());

        // start 없이 바로 destroy — 안전해야 한다.
        let rc = dvnc_session_destroy(handle);
        assert_eq!(rc, DVNC_OK);
    }
}

#[test]
fn double_destroy_returns_invalid_handle() {
    let counter = CallbackCounter::new();
    let cbs = make_callbacks(&counter);
    let mut handle: DvncSessionHandle = ptr::null_mut();

    unsafe {
        dvnc_session_create(&cbs, &mut handle);
        let rc1 = dvnc_session_destroy(handle);
        assert_eq!(rc1, DVNC_OK);

        // 두 번째 destroy — registry에 없으므로 INVALID_HANDLE.
        // UB가 아닌 정의된 에러코드 반환.
        let rc2 = dvnc_session_destroy(handle);
        assert_eq!(rc2, DVNC_ERR_INVALID_HANDLE);
    }
}

#[test]
fn create_null_callbacks_returns_error() {
    let mut handle: DvncSessionHandle = ptr::null_mut();
    unsafe {
        let rc = dvnc_session_create(ptr::null(), &mut handle);
        assert_eq!(rc, DVNC_ERR_NULL);
        assert!(handle.is_null());
    }
}

#[test]
fn create_null_out_handle_returns_error() {
    let counter = CallbackCounter::new();
    let cbs = make_callbacks(&counter);
    unsafe {
        let rc = dvnc_session_create(&cbs, ptr::null_mut());
        assert_eq!(rc, DVNC_ERR_NULL);
    }
}

#[test]
fn destroy_null_handle_returns_error() {
    unsafe {
        let rc = dvnc_session_destroy(ptr::null_mut());
        assert_eq!(rc, DVNC_ERR_NULL);
    }
}

// ────────────────────────────────────────────────────────────────────
// 입력 함수 — 활성 세션 없이 호출
// ────────────────────────────────────────────────────────────────────

#[test]
fn input_on_non_started_session_returns_invalid_handle() {
    let counter = CallbackCounter::new();
    let cbs = make_callbacks(&counter);
    let mut handle: DvncSessionHandle = ptr::null_mut();

    unsafe {
        dvnc_session_create(&cbs, &mut handle);

        // 시작 안 된 세션에 입력을 보내면 INVALID_HANDLE
        assert_eq!(
            dvnc_session_pointer_move(handle, 10, 20),
            DVNC_ERR_INVALID_HANDLE
        );
        assert_eq!(
            dvnc_session_pointer_button(handle, 0, 1, 10, 20),
            DVNC_ERR_INVALID_HANDLE
        );
        assert_eq!(
            dvnc_session_pointer_scroll(handle, 1, -1, 10, 20),
            DVNC_ERR_INVALID_HANDLE
        );
        assert_eq!(
            dvnc_session_key_down(handle, 65, 0),
            DVNC_ERR_INVALID_HANDLE
        );
        assert_eq!(dvnc_session_key_up(handle, 65, 0), DVNC_ERR_INVALID_HANDLE);
        assert_eq!(dvnc_session_refresh(handle), DVNC_ERR_INVALID_HANDLE);
        assert_eq!(
            dvnc_session_request_desktop_size(handle, 1920, 1080),
            DVNC_ERR_INVALID_HANDLE
        );

        let text = CString::new("hello").unwrap();
        assert_eq!(
            dvnc_session_send_clipboard(handle, text.as_ptr()),
            DVNC_ERR_INVALID_HANDLE
        );

        dvnc_session_destroy(handle);
    }
}

#[test]
fn input_on_null_handle_returns_error() {
    unsafe {
        assert_eq!(
            dvnc_session_pointer_move(ptr::null_mut(), 10, 20),
            DVNC_ERR_NULL
        );
        assert_eq!(dvnc_session_key_down(ptr::null_mut(), 65, 0), DVNC_ERR_NULL);
        assert_eq!(dvnc_session_refresh(ptr::null_mut()), DVNC_ERR_NULL);
    }
}

#[test]
fn clipboard_null_text_returns_error() {
    let counter = CallbackCounter::new();
    let cbs = make_callbacks(&counter);
    let mut handle: DvncSessionHandle = ptr::null_mut();

    unsafe {
        dvnc_session_create(&cbs, &mut handle);
        assert_eq!(
            dvnc_session_send_clipboard(handle, ptr::null()),
            DVNC_ERR_NULL
        );
        dvnc_session_destroy(handle);
    }
}

// ────────────────────────────────────────────────────────────────────
// start: localhost fake listener로 에러 콜백 수신 확인
// ────────────────────────────────────────────────────────────────────

#[test]
fn destroy_from_worker_callback_does_not_self_join_or_drop_the_handle() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        if let Ok((stream, _)) = listener.accept() {
            drop(stream);
        }
    });

    let attempt = Arc::new(CallbackDestroyAttempt {
        handle: AtomicUsize::new(0),
        result: AtomicI32::new(CALLBACK_NOT_CALLED),
    });
    let callbacks = DvncCallbacks {
        user_data: Arc::as_ptr(&attempt) as *mut c_void,
        on_connected: None,
        on_resized: None,
        on_capabilities: None,
        on_clipboard: None,
        on_error: Some(destroy_from_error_callback),
        on_closed: None,
        on_frame: None,
        on_cursor: None,
    };
    let mut handle: DvncSessionHandle = ptr::null_mut();

    unsafe {
        assert_eq!(dvnc_session_create(&callbacks, &mut handle), DVNC_OK);
        attempt.handle.store(handle as usize, Ordering::SeqCst);

        let host = CString::new("127.0.0.1").unwrap();
        let config = DvncConnectConfig {
            host: host.as_ptr(),
            port,
            password: ptr::null(),
            username: ptr::null(),
            image_quality: ptr::null(),
            shared: 1,
            tunnel_auth_token: std::ptr::null(),
        };
        assert_eq!(dvnc_session_start(handle, &config), DVNC_OK);

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while attempt.result.load(Ordering::SeqCst) == CALLBACK_NOT_CALLED {
            assert!(std::time::Instant::now() < deadline, "error callback did not run");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(
            attempt.result.load(Ordering::SeqCst),
            DVNC_ERR_CALLBACK_THREAD,
            "worker callback must ask for an external destroy retry with its own code, \
             not the generic internal error — the caller has to tell the two apart to know \
             whether releasing user_data is safe"
        );
        assert_eq!(
            dvnc_session_destroy(handle),
            DVNC_OK,
            "callback-thread attempt must leave registry ownership intact"
        );
    }

    server.join().unwrap();
}

#[test]
fn start_with_immediate_close_calls_error_or_closed() {
    // localhost에서 accept 후 즉시 닫는 fake listener. 연결은 되지만 RFB 프로토콜이 없으므로
    // 세션은 에러 또는 closed를 보고한다. TEST-NET(192.0.2.1) 의존 제거.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();

    // accept 후 즉시 소켓을 닫는 스레드
    let _server = std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            // 아무 것도 안 쓰고 닫는다 → 클라이언트는 읽기 오류를 받는다.
            let _ = stream.write_all(b""); // no-op
            drop(stream);
        }
    });

    let counter = CallbackCounter::new();
    let cbs = make_callbacks(&counter);
    let mut handle: DvncSessionHandle = ptr::null_mut();

    unsafe {
        dvnc_session_create(&cbs, &mut handle);

        let host = CString::new("127.0.0.1").unwrap();
        let config = DvncConnectConfig {
            host: host.as_ptr(),
            port,
            password: ptr::null(),
            username: ptr::null(),
            image_quality: ptr::null(),
            shared: 1,
            tunnel_auth_token: std::ptr::null(),
        };

        let rc = dvnc_session_start(handle, &config);
        assert_eq!(rc, DVNC_OK);

        // 워커가 연결 실패를 콜백으로 보낼 시간을 준다.
        std::thread::sleep(std::time::Duration::from_millis(500));

        // disconnect → destroy 해도 안전해야 한다.
        dvnc_session_disconnect(handle);
        std::thread::sleep(std::time::Duration::from_millis(100));
        dvnc_session_destroy(handle);
    }

    // error 또는 closed 중 하나는 왔어야 한다.
    let total = counter.error.load(Ordering::SeqCst) + counter.closed.load(Ordering::SeqCst);
    assert!(total >= 1, "expected at least one error or closed callback");
}

#[test]
fn start_with_connection_refused_calls_error_or_closed() {
    // 아무도 listen하지 않는 포트에 연결 → connection refused.
    // 이것은 TEST-NET TCP timeout보다 훨씬 빠르다(즉각 실패).
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener); // 바로 닫아서 connection refused 유발

    let counter = CallbackCounter::new();
    let cbs = make_callbacks(&counter);
    let mut handle: DvncSessionHandle = ptr::null_mut();

    unsafe {
        dvnc_session_create(&cbs, &mut handle);

        let host = CString::new("127.0.0.1").unwrap();
        let config = DvncConnectConfig {
            host: host.as_ptr(),
            port,
            password: ptr::null(),
            username: ptr::null(),
            image_quality: ptr::null(),
            shared: 1,
            tunnel_auth_token: std::ptr::null(),
        };

        let rc = dvnc_session_start(handle, &config);
        assert_eq!(rc, DVNC_OK);

        // connection refused는 즉시 발생한다.
        std::thread::sleep(std::time::Duration::from_millis(500));

        dvnc_session_destroy(handle);
    }

    // error 또는 closed 중 하나는 왔어야 한다.
    let total = counter.error.load(Ordering::SeqCst) + counter.closed.load(Ordering::SeqCst);
    assert!(total >= 1, "expected at least one error or closed callback");
}

#[test]
fn start_null_config_returns_error() {
    let counter = CallbackCounter::new();
    let cbs = make_callbacks(&counter);
    let mut handle: DvncSessionHandle = ptr::null_mut();

    unsafe {
        dvnc_session_create(&cbs, &mut handle);
        let rc = dvnc_session_start(handle, ptr::null());
        assert_eq!(rc, DVNC_ERR_NULL);
        dvnc_session_destroy(handle);
    }
}

#[test]
fn start_empty_host_returns_error() {
    let counter = CallbackCounter::new();
    let cbs = make_callbacks(&counter);
    let mut handle: DvncSessionHandle = ptr::null_mut();

    unsafe {
        dvnc_session_create(&cbs, &mut handle);
        let host = CString::new("").unwrap();
        let config = DvncConnectConfig {
            host: host.as_ptr(),
            port: 5900,
            password: ptr::null(),
            username: ptr::null(),
            image_quality: ptr::null(),
            shared: 1,
            tunnel_auth_token: std::ptr::null(),
        };
        let rc = dvnc_session_start(handle, &config);
        assert_eq!(rc, DVNC_ERR_NULL); // 빈 호스트 → null 에러
        dvnc_session_destroy(handle);
    }
}

// ────────────────────────────────────────────────────────────────────
// disconnect 안전성
// ────────────────────────────────────────────────────────────────────

#[test]
fn disconnect_non_started_is_noop() {
    let counter = CallbackCounter::new();
    let cbs = make_callbacks(&counter);
    let mut handle: DvncSessionHandle = ptr::null_mut();

    unsafe {
        dvnc_session_create(&cbs, &mut handle);
        let rc = dvnc_session_disconnect(handle);
        assert_eq!(rc, DVNC_OK); // no-op
        dvnc_session_destroy(handle);
    }
}

#[test]
fn disconnect_null_handle_returns_error() {
    unsafe {
        let rc = dvnc_session_disconnect(ptr::null_mut());
        assert_eq!(rc, DVNC_ERR_NULL);
    }
}

// ────────────────────────────────────────────────────────────────────
// destroyed handle에 대한 호출
// ────────────────────────────────────────────────────────────────────

#[test]
fn operations_on_destroyed_handle_return_invalid() {
    let counter = CallbackCounter::new();
    let cbs = make_callbacks(&counter);
    let mut handle: DvncSessionHandle = ptr::null_mut();

    unsafe {
        dvnc_session_create(&cbs, &mut handle);
        dvnc_session_destroy(handle);

        // destroy 후 모든 호출은 INVALID_HANDLE
        assert_eq!(
            dvnc_session_pointer_move(handle, 0, 0),
            DVNC_ERR_INVALID_HANDLE
        );
        assert_eq!(dvnc_session_disconnect(handle), DVNC_ERR_INVALID_HANDLE);
        assert_eq!(dvnc_session_refresh(handle), DVNC_ERR_INVALID_HANDLE);

        let host = CString::new("127.0.0.1").unwrap();
        let config = DvncConnectConfig {
            host: host.as_ptr(),
            port: 5900,
            password: ptr::null(),
            username: ptr::null(),
            image_quality: ptr::null(),
            shared: 1,
            tunnel_auth_token: std::ptr::null(),
        };
        assert_eq!(dvnc_session_start(handle, &config), DVNC_ERR_INVALID_HANDLE);
    }
}

// ────────────────────────────────────────────────────────────────────
// concurrent destroy 안전성
// ────────────────────────────────────────────────────────────────────

#[test]
fn concurrent_destroy_is_safe() {
    let counter = CallbackCounter::new();
    let cbs = make_callbacks(&counter);
    let mut handle: DvncSessionHandle = ptr::null_mut();

    unsafe {
        dvnc_session_create(&cbs, &mut handle);
    }

    // 여러 스레드에서 동시에 destroy 시도 — 하나만 성공, 나머지는 INVALID_HANDLE.
    let handle_val = handle as usize;
    let threads: Vec<_> = (0..4)
        .map(|_| {
            std::thread::spawn(move || unsafe { dvnc_session_destroy(handle_val as *mut c_void) })
        })
        .collect();

    let results: Vec<i32> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    let ok_count = results.iter().filter(|&&r| r == DVNC_OK).count();
    let invalid_count = results
        .iter()
        .filter(|&&r| r == DVNC_ERR_INVALID_HANDLE)
        .count();

    assert_eq!(ok_count, 1, "exactly one destroy should succeed");
    assert_eq!(invalid_count, 3, "rest should get INVALID_HANDLE");
}
