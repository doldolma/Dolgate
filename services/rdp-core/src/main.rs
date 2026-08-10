//! Headless RDP sidecar.
//!
//! Mirrors how `services/ssh-core` is driven: the Electron main process spawns this binary and
//! exchanges length-prefixed frames over stdio (see `framing`). Nothing is drawn here — decoded
//! pixels go out as stream frames and the renderer puts them on a canvas.
//!
//! Logs go to stderr only. stdout is the frame channel and a stray `println!` would corrupt it.

mod audio;
mod clipboard;
mod drive;
mod egfx;
mod egfx_surface;
mod framing;
mod output;
mod protocol;
mod session;

use std::collections::HashMap;
use std::io::{self, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

use anyhow::Context as _;
use tracing::{info, warn};

use crate::framing::{KIND_CONTROL, read_frame};
use crate::output::Output;
use crate::protocol::{
    ConnectPayload, EmptyPayload, ErrorPayload, Event, InputEvent, InputPayload, Request,
    StatusPayload, TrustVerdictPayload,
};

struct SessionHandle {
    /// Flipped on disconnect so the session thread can wind down.
    stop: Arc<AtomicBool>,
    /// Input is queued here and drained by the session thread, which owns the socket.
    input: Sender<Vec<InputEvent>>,
    /// The session thread parks on this between the TLS handshake and CredSSP, waiting to hear
    /// whether the server's certificate is trusted.
    trust: Sender<bool>,
    /// Requested desktop sizes. Only the newest is acted on — see flush_resize_requests.
    resize: Sender<(u16, u16)>,
    /// 다시 선언할 모니터 배치. 창이 실제로 그릴 수 있는 크기를 알게 된 뒤 온다.
    layout: Sender<Vec<crate::protocol::MonitorRequest>>,
    /// Local clipboard text, so the remote can paste what was copied here.
    clipboard: Sender<String>,
    /// 화면 전체를 다시 보내 달라는 요청.
    ///
    /// RDP 는 바뀐 부분만 보낸다. 세션 도중에 새로 붙는 창(모니터별 창처럼)은 그동안의 화면을
    /// 못 받아서, 정지한 영역이 영영 검은 채로 남는다 — 서버는 다시 보내주지 않는다.
    refresh: Sender<()>,
}

type Sessions = Arc<Mutex<HashMap<String, SessionHandle>>>;

fn main() -> anyhow::Result<()> {
    setup_logging();

    let output = Arc::new(Output::new());
    let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));

    output
        .send_event(&Event::new("ready", EmptyPayload {}))
        .context("emit ready")?;

    let mut reader = BufReader::new(io::stdin());

    loop {
        let frame = match read_frame(&mut reader) {
            Ok(frame) => frame,
            // The parent closed stdin: it is shutting us down.
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => {
                info!("stdin closed; shutting down");
                break;
            }
            Err(e) => return Err(anyhow::Error::new(e).context("read frame")),
        };

        if frame.kind != KIND_CONTROL {
            warn!(kind = frame.kind, "ignoring non-control frame");
            continue;
        }

        let request: Request = match serde_json::from_slice(&frame.metadata) {
            Ok(request) => request,
            Err(error) => {
                warn!(%error, "malformed control frame");
                continue;
            }
        };

        handle(request, &output, &sessions);
    }

    stop_all(&sessions);

    Ok(())
}

fn handle(request: Request, output: &Arc<Output>, sessions: &Sessions) {
    match request.kind.as_str() {
        "health" => {
            let _ = output.send_event(
                &Event::new("status", StatusPayload { ok: true }).request(&request.id),
            );
        }
        "connectRdp" => connect_rdp(request, output, sessions),
        "rdpInput" => send_input(request, sessions),
        "rdpTrustCertificate" => resolve_trust(request, sessions),
        "rdpResize" => request_resize(request, sessions),
        "rdpSetLayout" => request_layout(request, sessions),
        "rdpRefresh" => request_refresh(request, sessions),
        "rdpClipboard" => set_clipboard(request, sessions),
        "disconnect" => disconnect(request, output, sessions),
        other => {
            warn!(kind = other, "unknown request type");
            let _ = output.send_event(
                &Event::new("error", ErrorPayload {
                    message: format!("unknown request type: {other}"),
                })
                .request(&request.id),
            );
        }
    }
}

fn connect_rdp(request: Request, output: &Arc<Output>, sessions: &Sessions) {
    let Some(session_id) = request.session_id.clone() else {
        let _ = output.send_event(
            &Event::new("error", ErrorPayload {
                message: "connectRdp requires a sessionId".to_owned(),
            })
            .request(&request.id),
        );
        return;
    };

    let payload: ConnectPayload = match serde_json::from_value(request.payload) {
        Ok(payload) => payload,
        Err(error) => {
            let _ = output.send_event(
                &Event::new("error", ErrorPayload {
                    message: format!("invalid connect payload: {error}"),
                })
                .session(&session_id)
                .request(&request.id),
            );
            return;
        }
    };

    let stop = Arc::new(AtomicBool::new(false));
    let (input_tx, input_rx) = mpsc::channel();
    let (trust_tx, trust_rx) = mpsc::channel();
    let (resize_tx, resize_rx) = mpsc::channel();
    let (layout_tx, layout_rx) = mpsc::channel();
    let (refresh_tx, refresh_rx) = mpsc::channel();
    let (clipboard_tx, clipboard_rx) = mpsc::channel();
    {
        let mut guard = sessions.lock().expect("sessions mutex poisoned");
        if guard.contains_key(&session_id) {
            let _ = output.send_event(
                &Event::new("error", ErrorPayload {
                    message: format!("session {session_id} already exists"),
                })
                .session(&session_id)
                .request(&request.id),
            );
            return;
        }
        guard.insert(
            session_id.clone(),
            SessionHandle {
                stop: Arc::clone(&stop),
                input: input_tx,
                trust: trust_tx,
                resize: resize_tx,
                layout: layout_tx,
                refresh: refresh_tx,
                clipboard: clipboard_tx,
            },
        );
    }

    let thread_output = Arc::clone(output);
    let thread_sessions = Arc::clone(sessions);
    let request_id = request.id;
    let thread_session_id = session_id.clone();

    // One thread per session: the RDP socket read blocks, and this keeps the stdin loop responsive.
    if let Err(error) = thread::Builder::new()
        .name(format!("rdp-{session_id}"))
        .spawn(move || {
            // 패닉을 잡아 사용자에게 알린다.
            //
            // 이 스레드가 패닉하면 프로세스는 살아 있어서 Electron 쪽은 아무것도 눈치채지
            // 못한다 — 화면은 마지막 프레임에 얼어붙고, 사용자는 이유를 알 방법이 없다.
            // (실제로 EGFX 더티 사각형 병합의 u64 언더플로로 그렇게 됐다.)
            // 그래서 여기서 잡아 session::run 의 실패와 같은 `error` 이벤트로 흘린다 —
            // 그 경로는 이미 렌더러의 세션 화면까지 이어져 있다.
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                session::run(
                    thread_session_id.clone(),
                    request_id.clone(),
                    payload,
                    Arc::clone(&thread_output),
                    stop,
                    input_rx,
                    trust_rx,
                    resize_rx,
                    layout_rx,
                    refresh_rx,
                    clipboard_rx,
                );
            }));

            if let Err(panic) = outcome {
                let detail = panic_message(&panic);
                // 이미 기본 패닉 훅이 스택을 stderr 에 찍었다. 여기서는 사용자에게 보일
                // 한 줄만 만든다 — 원문은 로그에 남아 있다.
                warn!(session_id = %thread_session_id, detail, "session thread panicked");
                let _ = thread_output.send_event(
                    &Event::new(
                        "error",
                        ErrorPayload {
                            message: format!("RDP 세션이 내부 오류로 중단되었습니다: {detail}"),
                        },
                    )
                    .session(&thread_session_id)
                    .request(&request_id),
                );
            }

            thread_sessions
                .lock()
                .expect("sessions mutex poisoned")
                .remove(&thread_session_id);
        })
    {
        warn!(%error, "failed to spawn session thread");
        sessions
            .lock()
            .expect("sessions mutex poisoned")
            .remove(&session_id);
    }
}

/// 패닉 payload 에서 사람이 읽을 한 줄을 뽑는다. panic!("...") 은 &str, format! 로 만든
/// 것은 String 으로 온다 — 둘 다 아니면 타입만 남는다.
fn panic_message(panic: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(text) = panic.downcast_ref::<&'static str>() {
        return (*text).to_owned();
    }
    if let Some(text) = panic.downcast_ref::<String>() {
        return text.clone();
    }
    "알 수 없는 패닉".to_owned()
}

fn disconnect(request: Request, output: &Arc<Output>, sessions: &Sessions) {
    let Some(session_id) = request.session_id.as_deref() else {
        return;
    };

    // Only signals; the session thread emits `closed` once it has actually unwound.
    if let Some(handle) = sessions
        .lock()
        .expect("sessions mutex poisoned")
        .get(session_id)
    {
        handle.stop.store(true, Ordering::Relaxed);
    }

    let _ = output.send_event(
        &Event::new("status", StatusPayload { ok: true })
            .session(session_id)
            .request(&request.id),
    );
}

// 입력은 조용히 버린다. 세션이 이미 사라졌거나 스레드가 내려가는 중이라면 되돌릴 것이 없고,
// 마우스 움직임마다 에러 이벤트를 올리면 로그만 뒤덮는다.
fn send_input(request: Request, sessions: &Sessions) {
    let Some(session_id) = request.session_id.as_deref() else {
        return;
    };

    let payload: InputPayload = match serde_json::from_value(request.payload) {
        Ok(payload) => payload,
        Err(error) => {
            warn!(%error, "invalid input payload");
            return;
        }
    };

    if payload.events.is_empty() {
        return;
    }

    if let Some(handle) = sessions
        .lock()
        .expect("sessions mutex poisoned")
        .get(session_id)
    {
        let _ = handle.input.send(payload.events);
    }
}

fn resolve_trust(request: Request, sessions: &Sessions) {
    let Some(session_id) = request.session_id.as_deref() else {
        return;
    };

    let payload: TrustVerdictPayload = match serde_json::from_value(request.payload) {
        Ok(payload) => payload,
        Err(error) => {
            warn!(%error, "invalid trust verdict");
            return;
        }
    };

    if let Some(handle) = sessions
        .lock()
        .expect("sessions mutex poisoned")
        .get(session_id)
    {
        let _ = handle.trust.send(payload.accept);
    }
}

fn request_resize(request: Request, sessions: &Sessions) {
    let Some(session_id) = request.session_id.as_deref() else {
        return;
    };

    let payload: crate::protocol::ResizePayload = match serde_json::from_value(request.payload) {
        Ok(payload) => payload,
        Err(error) => {
            warn!(%error, "invalid resize payload");
            return;
        }
    };

    if let Some(handle) = sessions
        .lock()
        .expect("sessions mutex poisoned")
        .get(session_id)
    {
        let _ = handle.resize.send((payload.width, payload.height));
    }
}

fn request_layout(request: Request, sessions: &Sessions) {
    let Some(session_id) = request.session_id.as_deref() else {
        return;
    };

    let payload: crate::protocol::SetLayoutPayload =
        match serde_json::from_value(request.payload) {
            Ok(payload) => payload,
            Err(error) => {
                warn!(%error, "invalid layout payload");
                return;
            }
        };

    if payload.monitors.is_empty() {
        warn!("ignoring an empty monitor layout");
        return;
    }

    if let Some(handle) = sessions
        .lock()
        .expect("sessions mutex poisoned")
        .get(session_id)
    {
        let _ = handle.layout.send(payload.monitors);
    }
}

/// 지금 화면 전체를 한 번 더 보내게 한다.
fn request_refresh(request: Request, sessions: &Sessions) {
    let Some(session_id) = request.session_id.as_deref() else {
        return;
    };

    if let Some(handle) = sessions
        .lock()
        .expect("sessions mutex poisoned")
        .get(session_id)
    {
        let _ = handle.refresh.send(());
    }
}

fn set_clipboard(request: Request, sessions: &Sessions) {
    let Some(session_id) = request.session_id.as_deref() else {
        return;
    };

    let payload: crate::protocol::ClipboardSetPayload =
        match serde_json::from_value(request.payload) {
            Ok(payload) => payload,
            Err(error) => {
                warn!(%error, "invalid clipboard payload");
                return;
            }
        };

    if let Some(handle) = sessions
        .lock()
        .expect("sessions mutex poisoned")
        .get(session_id)
    {
        let _ = handle.clipboard.send(payload.text);
    }
}

fn stop_all(sessions: &Sessions) {
    for handle in sessions.lock().expect("sessions mutex poisoned").values() {
        handle.stop.store(true, Ordering::Relaxed);
    }
}

fn setup_logging() {
    use tracing_subscriber::EnvFilter;

    let filter = EnvFilter::builder()
        .with_default_directive(tracing::level_filters::LevelFilter::WARN.into())
        .with_env_var("DOLGATE_RDP_LOG")
        .from_env_lossy();

    // stderr, never stdout — stdout carries frames.
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(io::stderr)
        .init();
}
