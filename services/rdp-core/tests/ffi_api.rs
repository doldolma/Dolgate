//! C ABI lifecycle and failure-path tests. No external RDP server is required.

use std::ffi::{c_void, CString};
use std::net::TcpListener;
use std::ptr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rdp_core::ffi::*;

#[derive(Default)]
struct CallbackState {
    events: AtomicU32,
    frames: AtomicU32,
    audio: AtomicU32,
}

unsafe extern "C" fn on_event(user_data: *mut c_void, json: *const u8, json_len: u32) {
    let state = &*(user_data as *const CallbackState);
    assert!(!json.is_null());
    let bytes = std::slice::from_raw_parts(json, json_len as usize);
    let _: serde_json::Value = serde_json::from_slice(bytes).expect("valid control JSON");
    state.events.fetch_add(1, Ordering::SeqCst);
}

unsafe extern "C" fn on_frame(
    user_data: *mut c_void,
    _x: u16,
    _y: u16,
    width: u16,
    height: u16,
    pixels: *const u8,
    pixels_len: u32,
) {
    let state = &*(user_data as *const CallbackState);
    assert!(!pixels.is_null());
    assert_eq!(pixels_len as usize, usize::from(width) * usize::from(height) * 4);
    state.frames.fetch_add(1, Ordering::SeqCst);
}

unsafe extern "C" fn on_audio(
    user_data: *mut c_void,
    _sample_rate: u32,
    _channels: u16,
    _bits_per_sample: u16,
    _timestamp: u32,
    samples: *const u8,
    samples_len: u32,
) {
    let state = &*(user_data as *const CallbackState);
    assert!(!samples.is_null());
    assert_ne!(samples_len, 0);
    state.audio.fetch_add(1, Ordering::SeqCst);
}

fn callbacks(state: &Arc<CallbackState>) -> DrdpCallbacks {
    DrdpCallbacks {
        user_data: Arc::as_ptr(state) as *mut c_void,
        on_event: Some(on_event),
        on_frame: Some(on_frame),
        on_audio: Some(on_audio),
    }
}

fn create(state: &Arc<CallbackState>) -> DrdpSessionHandle {
    let callbacks = callbacks(state);
    let mut handle = ptr::null_mut();
    assert_eq!(unsafe { drdp_session_create(&callbacks, &mut handle) }, DRDP_OK);
    assert!(!handle.is_null());
    handle
}

struct ConfigStrings {
    host: CString,
    dial_address: CString,
    username: CString,
    password: CString,
    domain: CString,
    drives: CString,
    tunnel_auth_token: CString,
}

impl ConfigStrings {
    fn new(dial_address: String) -> Self {
        Self {
            host: CString::new("rdp.example.test").unwrap(),
            dial_address: CString::new(dial_address).unwrap(),
            username: CString::new("test-user").unwrap(),
            password: CString::new("test-password").unwrap(),
            domain: CString::new("TEST").unwrap(),
            drives: CString::new("[]").unwrap(),
            tunnel_auth_token: CString::new("").unwrap(),
        }
    }

    fn config(&self) -> DrdpConnectConfig {
        DrdpConnectConfig {
            host: self.host.as_ptr(),
            dial_address: self.dial_address.as_ptr(),
            port: 3389,
            username: self.username.as_ptr(),
            password: self.password.as_ptr(),
            domain: self.domain.as_ptr(),
            desktop_width: 1280,
            desktop_height: 720,
            audio_enabled: 1,
            clipboard_enabled: 1,
            microphone_enabled: 0,
            camera_enabled: 0,
            admin_session: 0,
            color_depth: 32,
            drives_json: self.drives.as_ptr(),
            tunnel_auth_token: self.tunnel_auth_token.as_ptr(),
        }
    }
}

fn refused_endpoint() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    address.to_string()
}

#[test]
fn create_and_destroy_without_start() {
    let state = Arc::new(CallbackState::default());
    let handle = create(&state);
    assert_eq!(unsafe { drdp_session_destroy(handle) }, DRDP_OK);
}

#[test]
fn null_create_arguments_are_rejected() {
    let state = Arc::new(CallbackState::default());
    let callbacks = callbacks(&state);
    let mut handle = 1usize as DrdpSessionHandle;

    assert_eq!(
        unsafe { drdp_session_create(ptr::null(), &mut handle) },
        DRDP_ERR_NULL
    );
    assert!(handle.is_null());
    assert_eq!(
        unsafe { drdp_session_create(&callbacks, ptr::null_mut()) },
        DRDP_ERR_NULL
    );
}

#[test]
fn created_session_rejects_runtime_operations_but_disconnect_is_idempotent() {
    let state = Arc::new(CallbackState::default());
    let handle = create(&state);
    let text = CString::new("hello").unwrap();

    assert_eq!(unsafe { drdp_session_disconnect(handle) }, DRDP_OK);
    assert_eq!(
        unsafe { drdp_session_pointer_move(handle, 1, 2) },
        DRDP_ERR_INVALID_HANDLE
    );
    assert_eq!(
        unsafe { drdp_session_key(handle, 0x1e, 1) },
        DRDP_ERR_INVALID_HANDLE
    );
    assert_eq!(
        unsafe { drdp_session_unicode(handle, '한' as u32, 1) },
        DRDP_ERR_INVALID_HANDLE
    );
    assert_eq!(
        unsafe { drdp_session_send_clipboard(handle, text.as_ptr()) },
        DRDP_ERR_INVALID_HANDLE
    );
    assert_eq!(unsafe { drdp_session_destroy(handle) }, DRDP_OK);
}

#[test]
fn argument_validation_is_deterministic() {
    let state = Arc::new(CallbackState::default());
    let handle = create(&state);

    assert_eq!(
        unsafe { drdp_session_pointer_button(handle, 3, 1, 0, 0) },
        DRDP_ERR_INVALID_ARGUMENT
    );
    assert_eq!(
        unsafe { drdp_session_key(handle, 0, 1) },
        DRDP_ERR_INVALID_ARGUMENT
    );
    assert_eq!(
        unsafe { drdp_session_unicode(handle, 0x11_0000, 1) },
        DRDP_ERR_INVALID_ARGUMENT
    );
    assert_eq!(
        unsafe { drdp_session_resize(handle, 0, 720) },
        DRDP_ERR_INVALID_ARGUMENT
    );
    assert_eq!(
        unsafe { drdp_session_send_clipboard(handle, ptr::null()) },
        DRDP_ERR_NULL
    );
    assert_eq!(unsafe { drdp_session_destroy(handle) }, DRDP_OK);
}

#[test]
fn start_validates_config_before_spawning() {
    let state = Arc::new(CallbackState::default());
    let handle = create(&state);
    let strings = ConfigStrings::new(refused_endpoint());
    let mut config = strings.config();

    assert_eq!(
        unsafe { drdp_session_start(handle, ptr::null()) },
        DRDP_ERR_NULL
    );
    let empty_host = CString::new("").unwrap();
    config.host = empty_host.as_ptr();
    assert_eq!(
        unsafe { drdp_session_start(handle, &config) },
        DRDP_ERR_INVALID_ARGUMENT
    );

    config = strings.config();
    config.color_depth = 24;
    assert_eq!(
        unsafe { drdp_session_start(handle, &config) },
        DRDP_ERR_INVALID_ARGUMENT
    );

    config = strings.config();
    let invalid_drives = CString::new("not-json").unwrap();
    config.drives_json = invalid_drives.as_ptr();
    assert_eq!(
        unsafe { drdp_session_start(handle, &config) },
        DRDP_ERR_INVALID_ARGUMENT
    );
    assert_eq!(unsafe { drdp_session_destroy(handle) }, DRDP_OK);
}

#[test]
fn refused_connection_reports_control_events_and_joins() {
    let state = Arc::new(CallbackState::default());
    let handle = create(&state);
    let strings = ConfigStrings::new(refused_endpoint());
    let config = strings.config();

    assert_eq!(unsafe { drdp_session_start(handle, &config) }, DRDP_OK);
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(unsafe { drdp_session_destroy(handle) }, DRDP_OK);
    assert!(
        state.events.load(Ordering::SeqCst) >= 1,
        "failure must be delivered as control JSON"
    );
}

#[test]
fn second_start_is_rejected() {
    let state = Arc::new(CallbackState::default());
    let handle = create(&state);
    let strings = ConfigStrings::new(refused_endpoint());
    let config = strings.config();

    assert_eq!(unsafe { drdp_session_start(handle, &config) }, DRDP_OK);
    assert_eq!(
        unsafe { drdp_session_start(handle, &config) },
        DRDP_ERR_ALREADY_STARTED
    );
    assert_eq!(unsafe { drdp_session_destroy(handle) }, DRDP_OK);
}

#[test]
fn destroyed_handle_never_aliases_a_new_session() {
    let state = Arc::new(CallbackState::default());
    let first = create(&state);
    assert_eq!(unsafe { drdp_session_destroy(first) }, DRDP_OK);
    let second = create(&state);
    assert_ne!(first, second, "opaque tokens must be monotonic");
    assert_eq!(
        unsafe { drdp_session_disconnect(first) },
        DRDP_ERR_INVALID_HANDLE
    );
    assert_eq!(unsafe { drdp_session_destroy(second) }, DRDP_OK);
}

#[test]
fn concurrent_destroy_has_one_winner() {
    let state = Arc::new(CallbackState::default());
    let handle = create(&state) as usize;
    let workers: Vec<_> = (0..8)
        .map(|_| {
            std::thread::spawn(move || unsafe {
                drdp_session_destroy(handle as DrdpSessionHandle)
            })
        })
        .collect();
    let results: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();

    assert_eq!(results.iter().filter(|&&code| code == DRDP_OK).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|&&code| code == DRDP_ERR_INVALID_HANDLE)
            .count(),
        7
    );
}

#[test]
fn null_and_destroyed_handles_return_defined_errors() {
    assert_eq!(
        unsafe { drdp_session_destroy(ptr::null_mut()) },
        DRDP_ERR_NULL
    );
    assert_eq!(
        unsafe { drdp_session_refresh(ptr::null_mut()) },
        DRDP_ERR_NULL
    );

    let state = Arc::new(CallbackState::default());
    let handle = create(&state);
    assert_eq!(unsafe { drdp_session_destroy(handle) }, DRDP_OK);
    assert_eq!(
        unsafe { drdp_session_destroy(handle) },
        DRDP_ERR_INVALID_HANDLE
    );
    assert_eq!(
        unsafe { drdp_session_pointer_move(handle, 0, 0) },
        DRDP_ERR_INVALID_HANDLE
    );
}
