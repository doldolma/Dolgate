//! Hardened C ABI for iOS and Android RDP clients.
//!
//! Opaque handles are monotonically increasing process-local tokens and are never dereferenced.
//! Every exported function contains Rust panics. Frame/audio pointers are borrowed only for the
//! duration of their callback, and control JSON never contains framebuffer bytes.

use std::collections::HashMap;
use std::ffi::{c_char, c_void, CStr};
use std::io;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

use crate::output::{Output, OutputSink};
use crate::protocol::{
    AudioFramePayload, ConnectPayload, DriveShare, FramePayload, InputEvent, MonitorRequest,
};
use crate::runtime::SessionRuntime;

pub const DRDP_OK: i32 = 0;
pub const DRDP_ERR_NULL: i32 = -1;
pub const DRDP_ERR_INVALID_UTF8: i32 = -2;
pub const DRDP_ERR_ALREADY_STARTED: i32 = -3;
pub const DRDP_ERR_INVALID_HANDLE: i32 = -4;
pub const DRDP_ERR_INTERNAL: i32 = -5;
pub const DRDP_ERR_INVALID_ARGUMENT: i32 = -6;
pub const DRDP_ERR_CALLBACK_THREAD: i32 = -7;
pub const DRDP_ERR_PANIC: i32 = -99;

pub type DrdpSessionHandle = *mut c_void;

pub type DrdpOnEvent = unsafe extern "C" fn(user_data: *mut c_void, json: *const u8, json_len: u32);
pub type DrdpOnFrame = unsafe extern "C" fn(
    user_data: *mut c_void,
    x: u16,
    y: u16,
    width: u16,
    height: u16,
    pixels: *const u8,
    pixels_len: u32,
);
pub type DrdpOnAudio = unsafe extern "C" fn(
    user_data: *mut c_void,
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
    timestamp: u32,
    samples: *const u8,
    samples_len: u32,
);

/// Optional callbacks. All callbacks run on the RDP worker thread.
#[derive(Clone, Copy)]
#[repr(C)]
pub struct DrdpCallbacks {
    pub user_data: *mut c_void,
    pub on_event: Option<DrdpOnEvent>,
    pub on_frame: Option<DrdpOnFrame>,
    pub on_audio: Option<DrdpOnAudio>,
}

// The C caller owns `user_data` and must keep it thread-safe and alive until destroy returns.
unsafe impl Send for DrdpCallbacks {}
unsafe impl Sync for DrdpCallbacks {}

/// Single-display mobile connection configuration.
#[repr(C)]
pub struct DrdpConnectConfig {
    /// Logical host used for TLS identity and certificate pinning.
    pub host: *const c_char,
    /// Actual dial endpoint, such as a loopback tunnel. Empty/null means `host:port`.
    pub dial_address: *const c_char,
    pub port: u16,
    pub username: *const c_char,
    pub password: *const c_char,
    pub domain: *const c_char,
    pub desktop_width: u16,
    pub desktop_height: u16,
    pub audio_enabled: u8,
    pub clipboard_enabled: u8,
    pub microphone_enabled: u8,
    pub camera_enabled: u8,
    pub admin_session: u8,
    /// 0 for the core default, otherwise 16 or 32.
    pub color_depth: u8,
    /// Optional JSON array matching `DriveShare`; null/empty means no shared drives.
    pub drives_json: *const c_char,
    /// Go mobile loopback tunnel token. null/empty means direct TCP.
    pub tunnel_auth_token: *const c_char,
}

static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);

fn registry() -> &'static Mutex<HashMap<u64, Arc<DrdpSession>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<u64, Arc<DrdpSession>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

enum SessionState {
    Created,
    Running(Arc<SessionRuntime>),
    Destroyed,
}

struct DrdpSession {
    state: Mutex<SessionState>,
    callbacks: Arc<DrdpCallbacks>,
}

struct FfiSink {
    callbacks: Arc<DrdpCallbacks>,
}

impl OutputSink for FfiSink {
    fn send_event(&self, event_json: &[u8]) -> io::Result<()> {
        let len = u32::try_from(event_json.len())
            .map_err(|_| io::Error::other("RDP event exceeds C ABI length"))?;
        if let Some(callback) = self.callbacks.on_event {
            unsafe { callback(self.callbacks.user_data, event_json.as_ptr(), len) };
        }
        Ok(())
    }

    fn send_frame(&self, meta: &FramePayload, pixels: &[u8]) -> io::Result<()> {
        let expected = usize::from(meta.width)
            .checked_mul(usize::from(meta.height))
            .and_then(|value| value.checked_mul(4))
            .ok_or_else(|| io::Error::other("RDP frame dimensions overflow"))?;
        if pixels.len() != expected {
            return Err(io::Error::other("RDP frame byte length mismatch"));
        }
        let len = u32::try_from(pixels.len())
            .map_err(|_| io::Error::other("RDP frame exceeds C ABI length"))?;
        if let Some(callback) = self.callbacks.on_frame {
            unsafe {
                callback(
                    self.callbacks.user_data,
                    meta.x,
                    meta.y,
                    meta.width,
                    meta.height,
                    pixels.as_ptr(),
                    len,
                )
            };
        }
        Ok(())
    }

    fn send_audio(&self, meta: &AudioFramePayload, samples: &[u8]) -> io::Result<()> {
        let len = u32::try_from(samples.len())
            .map_err(|_| io::Error::other("RDP audio exceeds C ABI length"))?;
        if let Some(callback) = self.callbacks.on_audio {
            unsafe {
                callback(
                    self.callbacks.user_data,
                    meta.sample_rate,
                    meta.channels,
                    meta.bits_per_sample,
                    meta.timestamp,
                    samples.as_ptr(),
                    len,
                )
            };
        }
        Ok(())
    }
}

fn token_to_handle(token: u64) -> DrdpSessionHandle {
    token as usize as DrdpSessionHandle
}

fn handle_to_token(handle: DrdpSessionHandle) -> u64 {
    handle as usize as u64
}

fn lookup_session(handle: DrdpSessionHandle) -> Result<Arc<DrdpSession>, i32> {
    if handle.is_null() {
        return Err(DRDP_ERR_NULL);
    }
    registry()
        .lock()
        .map_err(|_| DRDP_ERR_INTERNAL)?
        .get(&handle_to_token(handle))
        .cloned()
        .ok_or(DRDP_ERR_INVALID_HANDLE)
}

fn lookup_runtime(handle: DrdpSessionHandle) -> Result<Arc<SessionRuntime>, i32> {
    let session = lookup_session(handle)?;
    let state = session.state.lock().map_err(|_| DRDP_ERR_INTERNAL)?;
    match &*state {
        SessionState::Running(runtime) => Ok(Arc::clone(runtime)),
        SessionState::Created | SessionState::Destroyed => Err(DRDP_ERR_INVALID_HANDLE),
    }
}

unsafe fn cstr_to_string(value: *const c_char) -> Result<String, i32> {
    if value.is_null() {
        return Ok(String::new());
    }
    CStr::from_ptr(value)
        .to_str()
        .map(str::to_owned)
        .map_err(|_| DRDP_ERR_INVALID_UTF8)
}

fn ffi_result(action: impl FnOnce() -> i32) -> i32 {
    catch_unwind(AssertUnwindSafe(action)).unwrap_or(DRDP_ERR_PANIC)
}

fn with_runtime(handle: DrdpSessionHandle, action: impl FnOnce(&SessionRuntime) -> bool) -> i32 {
    ffi_result(|| match lookup_runtime(handle) {
        Ok(runtime) if action(&runtime) => DRDP_OK,
        Ok(_) => DRDP_ERR_INTERNAL,
        Err(code) => code,
    })
}

/// Creates an unstarted session and returns a process-local opaque token.
#[no_mangle]
pub unsafe extern "C" fn drdp_session_create(
    callbacks: *const DrdpCallbacks,
    out_handle: *mut DrdpSessionHandle,
) -> i32 {
    if callbacks.is_null() || out_handle.is_null() {
        if !out_handle.is_null() {
            *out_handle = ptr::null_mut();
        }
        return DRDP_ERR_NULL;
    }

    let result = catch_unwind(AssertUnwindSafe(|| {
        let token = NEXT_TOKEN.fetch_add(1, Ordering::Relaxed);
        if token == 0 || token > usize::MAX as u64 {
            return Err(DRDP_ERR_INTERNAL);
        }
        let session = Arc::new(DrdpSession {
            state: Mutex::new(SessionState::Created),
            callbacks: Arc::new(ptr::read(callbacks)),
        });
        registry()
            .lock()
            .map_err(|_| DRDP_ERR_INTERNAL)?
            .insert(token, session);
        Ok(token_to_handle(token))
    }));

    match result {
        Ok(Ok(handle)) => {
            *out_handle = handle;
            DRDP_OK
        }
        Ok(Err(code)) => {
            *out_handle = ptr::null_mut();
            code
        }
        Err(_) => {
            *out_handle = ptr::null_mut();
            DRDP_ERR_PANIC
        }
    }
}

/// Starts the worker. Connection results arrive asynchronously through `on_event`.
#[no_mangle]
pub unsafe extern "C" fn drdp_session_start(
    handle: DrdpSessionHandle,
    config: *const DrdpConnectConfig,
) -> i32 {
    if config.is_null() {
        return DRDP_ERR_NULL;
    }

    ffi_result(|| {
        let session = match lookup_session(handle) {
            Ok(session) => session,
            Err(code) => return code,
        };
        let config = &*config;
        let host = match cstr_to_string(config.host) {
            Ok(host) if !host.is_empty() => host,
            Ok(_) => return DRDP_ERR_INVALID_ARGUMENT,
            Err(code) => return code,
        };
        let dial_address = match cstr_to_string(config.dial_address) {
            Ok(value) if value.is_empty() => None,
            Ok(value) => Some(value),
            Err(code) => return code,
        };
        let username = match cstr_to_string(config.username) {
            Ok(value) => value,
            Err(code) => return code,
        };
        let password = match cstr_to_string(config.password) {
            Ok(value) => value,
            Err(code) => return code,
        };
        let domain = match cstr_to_string(config.domain) {
            Ok(value) if value.is_empty() => None,
            Ok(value) => Some(value),
            Err(code) => return code,
        };
        let drives_json = match cstr_to_string(config.drives_json) {
            Ok(value) => value,
            Err(code) => return code,
        };
        let tunnel_auth_token = match cstr_to_string(config.tunnel_auth_token) {
            Ok(value) if value.is_empty() => None,
            Ok(value) => Some(value),
            Err(code) => return code,
        };
        let drives: Vec<DriveShare> = if drives_json.is_empty() {
            Vec::new()
        } else {
            match serde_json::from_str(&drives_json) {
                Ok(value) => value,
                Err(_) => return DRDP_ERR_INVALID_ARGUMENT,
            }
        };
        let color_depth = match config.color_depth {
            0 => None,
            16 | 32 => Some(u32::from(config.color_depth)),
            _ => return DRDP_ERR_INVALID_ARGUMENT,
        };
        if config.desktop_width == 0 || config.desktop_height == 0 {
            return DRDP_ERR_INVALID_ARGUMENT;
        }

        let payload = ConnectPayload {
            host,
            port: if config.port == 0 { 3389 } else { config.port },
            username,
            password,
            domain,
            monitors: vec![MonitorRequest {
                width: config.desktop_width,
                height: config.desktop_height,
                left: 0,
                top: 0,
                primary: true,
            }],
            audio: config.audio_enabled != 0,
            clipboard: config.clipboard_enabled != 0,
            microphone: config.microphone_enabled != 0,
            camera: config.camera_enabled != 0,
            color_depth,
            admin_session: config.admin_session != 0,
            dial_address,
            tunnel_auth_token,
            drives,
        };

        let mut state = match session.state.lock() {
            Ok(state) => state,
            Err(_) => return DRDP_ERR_INTERNAL,
        };
        match &*state {
            SessionState::Created => {}
            SessionState::Running(_) => return DRDP_ERR_ALREADY_STARTED,
            SessionState::Destroyed => return DRDP_ERR_INVALID_HANDLE,
        }

        let sink: Arc<dyn OutputSink> = Arc::new(FfiSink {
            callbacks: Arc::clone(&session.callbacks),
        });
        let output = Arc::new(Output::with_sink(sink));
        match SessionRuntime::start(
            format!("drdp-{}", handle_to_token(handle)),
            "drdp-connect".to_owned(),
            payload,
            output,
        ) {
            Ok(runtime) => {
                *state = SessionState::Running(runtime);
                DRDP_OK
            }
            Err(_) => DRDP_ERR_INTERNAL,
        }
    })
}

#[no_mangle]
pub unsafe extern "C" fn drdp_session_disconnect(handle: DrdpSessionHandle) -> i32 {
    ffi_result(|| match lookup_session(handle) {
        Ok(session) => {
            let runtime = match session.state.lock() {
                Ok(state) => match &*state {
                    SessionState::Running(runtime) => Some(Arc::clone(runtime)),
                    SessionState::Created | SessionState::Destroyed => None,
                },
                Err(_) => return DRDP_ERR_INTERNAL,
            };
            if let Some(runtime) = runtime {
                runtime.disconnect();
            }
            DRDP_OK
        }
        Err(code) => code,
    })
}

/// Removes the token, requests shutdown, and joins the worker before returning.
#[no_mangle]
pub unsafe extern "C" fn drdp_session_destroy(handle: DrdpSessionHandle) -> i32 {
    if handle.is_null() {
        return DRDP_ERR_NULL;
    }

    ffi_result(|| {
        let session = match lookup_session(handle) {
            Ok(session) => session,
            Err(code) => return code,
        };
        {
            let state = match session.state.lock() {
                Ok(state) => state,
                Err(_) => return DRDP_ERR_INTERNAL,
            };
            if let SessionState::Running(runtime) = &*state {
                if runtime.worker_thread_id() == Some(thread::current().id()) {
                    // 종료는 요청해 둔다. 재시도가 오지 않아도 워커는 스스로 빠져나온다.
                    runtime.disconnect();
                    return DRDP_ERR_CALLBACK_THREAD;
                }
            }
        }

        let removed = match registry().lock() {
            Ok(mut registry) => registry.remove(&handle_to_token(handle)),
            Err(_) => return DRDP_ERR_INTERNAL,
        };
        let Some(session) = removed else {
            return DRDP_ERR_INVALID_HANDLE;
        };

        let runtime = {
            let mut state = match session.state.lock() {
                Ok(state) => state,
                Err(poisoned) => poisoned.into_inner(),
            };
            match std::mem::replace(&mut *state, SessionState::Destroyed) {
                SessionState::Running(runtime) => Some(runtime),
                SessionState::Created | SessionState::Destroyed => None,
            }
        };
        if let Some(runtime) = runtime {
            runtime.disconnect();
            if !runtime.join() {
                return DRDP_ERR_CALLBACK_THREAD;
            }
        }
        DRDP_OK
    })
}

#[no_mangle]
pub unsafe extern "C" fn drdp_session_pointer_move(
    handle: DrdpSessionHandle,
    x: u16,
    y: u16,
) -> i32 {
    with_runtime(handle, |runtime| {
        runtime.send_input(vec![InputEvent::MouseMove { x, y }])
    })
}

#[no_mangle]
pub unsafe extern "C" fn drdp_session_pointer_button(
    handle: DrdpSessionHandle,
    button: u8,
    pressed: u8,
    x: u16,
    y: u16,
) -> i32 {
    if button > 2 {
        return DRDP_ERR_INVALID_ARGUMENT;
    }
    with_runtime(handle, |runtime| {
        runtime.send_input(vec![
            InputEvent::MouseMove { x, y },
            InputEvent::MouseButton {
                button,
                pressed: pressed != 0,
            },
        ])
    })
}

#[no_mangle]
pub unsafe extern "C" fn drdp_session_pointer_scroll(
    handle: DrdpSessionHandle,
    vertical: u8,
    delta: i16,
    x: u16,
    y: u16,
) -> i32 {
    with_runtime(handle, |runtime| {
        runtime.send_input(vec![
            InputEvent::MouseMove { x, y },
            InputEvent::Wheel {
                vertical: vertical != 0,
                delta,
            },
        ])
    })
}

#[no_mangle]
pub unsafe extern "C" fn drdp_session_key(
    handle: DrdpSessionHandle,
    scancode: u16,
    pressed: u8,
) -> i32 {
    if scancode == 0 {
        return DRDP_ERR_INVALID_ARGUMENT;
    }
    with_runtime(handle, |runtime| {
        runtime.send_input(vec![InputEvent::Key {
            scancode,
            pressed: pressed != 0,
        }])
    })
}

#[no_mangle]
pub unsafe extern "C" fn drdp_session_unicode(
    handle: DrdpSessionHandle,
    codepoint: u32,
    pressed: u8,
) -> i32 {
    let Some(character) = char::from_u32(codepoint) else {
        return DRDP_ERR_INVALID_ARGUMENT;
    };
    with_runtime(handle, |runtime| {
        runtime.send_input(vec![InputEvent::Unicode {
            character,
            pressed: pressed != 0,
        }])
    })
}

#[no_mangle]
pub unsafe extern "C" fn drdp_session_resize(
    handle: DrdpSessionHandle,
    width: u16,
    height: u16,
) -> i32 {
    if width == 0 || height == 0 {
        return DRDP_ERR_INVALID_ARGUMENT;
    }
    with_runtime(handle, |runtime| runtime.resize(width, height))
}

#[no_mangle]
pub unsafe extern "C" fn drdp_session_refresh(handle: DrdpSessionHandle) -> i32 {
    with_runtime(handle, SessionRuntime::refresh)
}

#[no_mangle]
pub unsafe extern "C" fn drdp_session_trust_certificate(
    handle: DrdpSessionHandle,
    accept: u8,
) -> i32 {
    with_runtime(handle, |runtime| runtime.resolve_trust(accept != 0))
}

#[no_mangle]
pub unsafe extern "C" fn drdp_session_send_clipboard(
    handle: DrdpSessionHandle,
    text: *const c_char,
) -> i32 {
    if text.is_null() {
        return DRDP_ERR_NULL;
    }
    ffi_result(|| {
        let text = match cstr_to_string(text) {
            Ok(text) => text,
            Err(code) => return code,
        };
        match lookup_runtime(handle) {
            Ok(runtime) if runtime.send_clipboard(text) => DRDP_OK,
            Ok(_) => DRDP_ERR_INTERNAL,
            Err(code) => code,
        }
    })
}

#[no_mangle]
pub unsafe extern "C" fn drdp_session_send_microphone(
    handle: DrdpSessionHandle,
    samples: *const u8,
    samples_len: u32,
) -> i32 {
    if samples.is_null() || samples_len == 0 {
        return DRDP_ERR_NULL;
    }
    ffi_result(|| {
        let samples = std::slice::from_raw_parts(samples, samples_len as usize).to_vec();
        match lookup_runtime(handle) {
            Ok(runtime) if runtime.send_microphone(samples) => DRDP_OK,
            Ok(_) => DRDP_ERR_INTERNAL,
            Err(code) => code,
        }
    })
}

#[no_mangle]
pub unsafe extern "C" fn drdp_session_send_camera(
    handle: DrdpSessionHandle,
    frame: *const u8,
    frame_len: u32,
) -> i32 {
    if frame.is_null() || frame_len == 0 {
        return DRDP_ERR_NULL;
    }
    ffi_result(|| {
        let frame = std::slice::from_raw_parts(frame, frame_len as usize).to_vec();
        match lookup_runtime(handle) {
            Ok(runtime) if runtime.send_camera(frame) => DRDP_OK,
            Ok(_) => DRDP_ERR_INTERNAL,
            Err(code) => code,
        }
    })
}
