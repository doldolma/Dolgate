//! Reusable lifecycle and control handle for one blocking RDP session.

use std::io;
use std::net::Shutdown;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle, ThreadId};

use tracing::warn;

use crate::output::Output;
use crate::protocol::{ConnectPayload, ErrorPayload, Event, InputEvent, MonitorRequest};
use crate::session::{self, CancelSocket};

/// Owns every control channel and the worker thread for one RDP connection.
///
/// `disconnect` is non-blocking. Owners must call [`join`](Self::join) before releasing callback
/// state referenced by an [`Output`](crate::output::Output) sink.
pub struct SessionRuntime {
    stop: Arc<AtomicBool>,
    input: Sender<Vec<InputEvent>>,
    trust: Sender<bool>,
    resize: Sender<(u16, u16)>,
    layout: Sender<Vec<MonitorRequest>>,
    refresh: Sender<()>,
    clipboard: Sender<String>,
    microphone: Sender<Vec<u8>>,
    camera: Sender<Vec<u8>>,
    cancel_socket: CancelSocket,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl SessionRuntime {
    /// Starts one blocking IronRDP session on a dedicated worker thread.
    pub fn start(
        session_id: String,
        request_id: String,
        payload: ConnectPayload,
        output: Arc<Output>,
    ) -> io::Result<Arc<Self>> {
        let stop = Arc::new(AtomicBool::new(false));
        let (input, input_rx) = mpsc::channel();
        let (trust, trust_rx) = mpsc::channel();
        let (resize, resize_rx) = mpsc::channel();
        let (layout, layout_rx) = mpsc::channel();
        let (refresh, refresh_rx) = mpsc::channel();
        let (clipboard, clipboard_rx) = mpsc::channel();
        let (microphone, microphone_rx) = mpsc::channel();
        let (camera, camera_rx) = mpsc::channel();
        let cancel_socket: CancelSocket = Arc::new(Mutex::new(None));

        let runtime = Arc::new(Self {
            stop: Arc::clone(&stop),
            input,
            trust,
            resize,
            layout,
            refresh,
            clipboard,
            microphone,
            camera,
            cancel_socket: Arc::clone(&cancel_socket),
            worker: Mutex::new(None),
        });

        let thread_session_id = session_id.clone();
        let thread_request_id = request_id.clone();
        let thread_output = Arc::clone(&output);
        let handle = thread::Builder::new()
            .name(format!("rdp-{session_id}"))
            .spawn(move || {
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    session::run(
                        thread_session_id.clone(),
                        thread_request_id.clone(),
                        payload,
                        Arc::clone(&thread_output),
                        stop,
                        input_rx,
                        trust_rx,
                        resize_rx,
                        layout_rx,
                        refresh_rx,
                        clipboard_rx,
                        microphone_rx,
                        camera_rx,
                        cancel_socket,
                    );
                }));

                if let Err(panic) = outcome {
                    let detail = panic_message(&panic);
                    warn!(session_id = %thread_session_id, detail, "session thread panicked");
                    let _ = thread_output.send_event(
                        &Event::new(
                            "error",
                            ErrorPayload {
                                message: format!("RDP 세션이 내부 오류로 중단되었습니다: {detail}"),
                            },
                        )
                        .session(&thread_session_id)
                        .request(&thread_request_id),
                    );
                }
            })?;

        *runtime.worker.lock().expect("RDP worker mutex poisoned") = Some(handle);
        Ok(runtime)
    }

    /// Requests shutdown and interrupts a connect/handshake socket if one is currently blocked.
    pub fn disconnect(&self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Ok(slot) = self.cancel_socket.lock() {
            if let Some(socket) = slot.as_ref() {
                let _ = socket.shutdown(Shutdown::Both);
            }
        }
    }

    pub fn send_input(&self, events: Vec<InputEvent>) -> bool {
        !events.is_empty() && self.input.send(events).is_ok()
    }

    pub fn resolve_trust(&self, accept: bool) -> bool {
        self.trust.send(accept).is_ok()
    }

    pub fn resize(&self, width: u16, height: u16) -> bool {
        self.resize.send((width, height)).is_ok()
    }

    pub fn set_layout(&self, monitors: Vec<MonitorRequest>) -> bool {
        !monitors.is_empty() && self.layout.send(monitors).is_ok()
    }

    pub fn refresh(&self) -> bool {
        self.refresh.send(()).is_ok()
    }

    pub fn send_clipboard(&self, text: String) -> bool {
        self.clipboard.send(text).is_ok()
    }

    pub fn send_microphone(&self, samples: Vec<u8>) -> bool {
        !samples.is_empty() && self.microphone.send(samples).is_ok()
    }

    pub fn send_camera(&self, frame: Vec<u8>) -> bool {
        !frame.is_empty() && self.camera.send(frame).is_ok()
    }

    pub fn worker_thread_id(&self) -> Option<ThreadId> {
        self.worker
            .lock()
            .ok()
            .and_then(|worker| worker.as_ref().map(|handle| handle.thread().id()))
    }

    pub fn is_finished(&self) -> bool {
        self.worker
            .lock()
            .map(|worker| worker.as_ref().is_none_or(JoinHandle::is_finished))
            .unwrap_or(true)
    }

    /// Waits for the worker. Returns false when called by the worker itself; joining oneself would
    /// deadlock, and native callback owners must defer destroy to another thread in that case.
    pub fn join(&self) -> bool {
        let Some(handle) = self
            .worker
            .lock()
            .expect("RDP worker mutex poisoned")
            .take()
        else {
            return true;
        };

        if handle.thread().id() == thread::current().id() {
            *self.worker.lock().expect("RDP worker mutex poisoned") = Some(handle);
            return false;
        }

        handle.join().is_ok()
    }
}

fn panic_message(panic: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(text) = panic.downcast_ref::<&'static str>() {
        return (*text).to_owned();
    }
    if let Some(text) = panic.downcast_ref::<String>() {
        return text.clone();
    }
    "알 수 없는 패닉".to_owned()
}
