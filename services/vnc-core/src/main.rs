//! vnc-core 진입점.
//!
//! stdin 으로 제어 프레임을 받고 stdout 으로 이벤트·픽셀을 올린다. 구조는 rdp-core 와 같다 —
//! 이 스레드는 명령만 처리하고, 세션은 각자 스레드에서 돈다. 명령 처리 중에 소켓을 기다리면
//! 세션 하나가 나머지 전부를 멈춘다.

mod ard;
mod auth;
mod clipboard;
mod cursor;
mod decode;
mod output;
mod protocol;
mod rfb;
mod session;
mod session_output;
mod sink;
mod tight;
mod tls;
mod transport;
mod vencrypt;
mod zrle;

use std::collections::HashMap;
use std::io::{self};
use std::sync::{Arc, Mutex};
use std::thread;

use tracing::{debug, warn};

use crate::output::Output;
use crate::protocol::{
    ClipboardPayload, ConnectPayload, ErrorPayload, Event, InputBatch, ReadyPayload, Request,
    SetDesktopSizePayload, StatusPayload,
};
use crate::session::SessionHandle;
use core_framing::{read_frame, KIND_CONTROL};

/// 데스크톱이 이 값으로 코어 세대를 구분할 수 있게 넘긴다.
const VERSION: &str = env!("CARGO_PKG_VERSION");

type Sessions = Arc<Mutex<HashMap<String, SessionHandle>>>;

fn main() -> io::Result<()> {
    // 진단은 stderr 로 나간다. stdout 은 프레임 전용이라 한 바이트도 섞일 수 없다.
    tracing_subscriber::fmt()
        .with_writer(io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("DOLGATE_VNC_LOG")
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .init();

    let output = Output::new();
    let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));

    output.send_event(&Event::new("ready", ReadyPayload { version: VERSION }))?;

    let stdin = io::stdin();
    let mut reader = stdin.lock();
    loop {
        let frame = match read_frame(&mut reader) {
            Ok(frame) => frame,
            // 데스크톱이 파이프를 닫았다 = 종료 신호다.
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(error) => {
                warn!(%error, "stdin frame 을 읽을 수 없다");
                break;
            }
        };
        if frame.kind != KIND_CONTROL {
            warn!(kind = frame.kind, "제어 프레임이 아닌 것을 무시한다");
            continue;
        }
        let request: Request = match serde_json::from_slice(&frame.metadata) {
            Ok(request) => request,
            Err(error) => {
                warn!(%error, "제어 프레임을 해석할 수 없다");
                continue;
            }
        };
        handle_request(request, &output, &sessions);
    }

    // 남은 세션을 정리한다. 여기서 닫지 않으면 소켓이 프로세스 종료까지 열려 있고, 서버 쪽에는
    // 세션이 살아 있는 것으로 남는다.
    if let Ok(mut map) = sessions.lock() {
        for (_, handle) in map.drain() {
            handle.close();
        }
    }
    Ok(())
}

fn handle_request(request: Request, output: &Output, sessions: &Sessions) {
    match request.kind.as_str() {
        "connectVnc" => {
            let Some(session_id) = request.session_id.clone() else {
                reply_error(output, &request.id, None, "sessionId 가 필요합니다");
                return;
            };
            let payload: ConnectPayload = match serde_json::from_value(request.payload) {
                Ok(payload) => payload,
                Err(error) => {
                    reply_error(
                        output,
                        &request.id,
                        Some(&session_id),
                        &format!("연결 정보를 해석할 수 없습니다: {error}"),
                    );
                    return;
                }
            };

            let session_output = output.clone();
            let sessions = Arc::clone(sessions);
            let request_id = request.id.clone();
            let spawn = thread::Builder::new()
                .name(format!("vnc-session-{session_id}"))
                .spawn({
                    let session_id = session_id.clone();
                    move || {
                        let registry = Arc::clone(&sessions);
                        let key = session_id.clone();
                        let result = session::run(
                            session_id.clone(),
                            request_id,
                            payload,
                            session_output.clone(),
                            move |handle| {
                                if let Ok(mut map) = registry.lock() {
                                    map.insert(key, handle);
                                }
                            },
                        );
                        if let Err(error) = result {
                            debug!(%error, session = %session_id, "세션이 오류로 끝났다");
                        }
                        drop(session_output);
                        // 성공이든 실패든 등록을 지운다. 남겨 두면 죽은 세션에 입력을 보낸다.
                        if let Ok(mut map) = sessions.lock() {
                            map.remove(&session_id);
                        }
                    }
                });
            if let Err(error) = spawn {
                reply_error(
                    output,
                    &request.id,
                    Some(&session_id),
                    &format!("세션 스레드를 만들 수 없습니다: {error}"),
                );
            }
        }
        "vncInput" => {
            let Some(session_id) = request.session_id.as_deref() else {
                return;
            };
            let batch: InputBatch = match serde_json::from_value(request.payload) {
                Ok(batch) => batch,
                Err(error) => {
                    warn!(%error, "입력 묶음을 해석할 수 없다");
                    return;
                }
            };
            let handle = sessions
                .lock()
                .ok()
                .and_then(|map| map.get(session_id).cloned());
            // 세션이 이미 끝났을 수 있다. 그건 오류가 아니다 — 사용자가 탭을 닫는 순간에도
            // 입력이 몇 개 뒤늦게 도착한다.
            if let Some(handle) = handle {
                if let Err(error) = handle.send_input(&batch.events) {
                    debug!(%error, session = %session_id, "입력을 보낼 수 없다");
                }
            }
        }
        // 로컬 클립보드를 원격에 알린다. 데스크톱이 클립보드를 소유하므로(RDP 와 같은 규칙) 값은
        // 메인 프로세스가 읽어서 넘긴다 — 코어는 OS 클립보드를 만지지 않는다.
        "vncClipboard" => {
            let Some(session_id) = request.session_id.as_deref() else {
                return;
            };
            let payload: ClipboardPayload = match serde_json::from_value(request.payload) {
                Ok(payload) => payload,
                Err(error) => {
                    warn!(%error, "클립보드 요청을 해석할 수 없다");
                    return;
                }
            };
            let handle = sessions
                .lock()
                .ok()
                .and_then(|map| map.get(session_id).cloned());
            // 세션이 이미 끝났을 수 있다. 입력과 같은 이유로 오류가 아니다.
            if let Some(handle) = handle {
                if let Err(error) = handle.send_clipboard(payload.text) {
                    debug!(%error, session = %session_id, "클립보드를 보낼 수 없다");
                }
            }
        }
        // 창 크기에 맞춰 원격 화면 크기를 요청한다.
        // 화면 전체를 다시 받는다. 캔버스가 그림을 잃었을 때(크기 변경으로 지워졌을 때) 부른다.
        "vncRefresh" => {
            let Some(session_id) = request.session_id.as_deref() else {
                return;
            };
            let handle = sessions
                .lock()
                .ok()
                .and_then(|map| map.get(session_id).cloned());
            if let Some(handle) = handle {
                if let Err(error) = handle.refresh_screen() {
                    debug!(%error, session = %session_id, "화면 갱신을 요청할 수 없다");
                }
            }
        }
        "vncSetDesktopSize" => {
            let Some(session_id) = request.session_id.as_deref() else {
                return;
            };
            let payload: SetDesktopSizePayload = match serde_json::from_value(request.payload) {
                Ok(payload) => payload,
                Err(error) => {
                    warn!(%error, "화면 크기 요청을 해석할 수 없다");
                    return;
                }
            };
            let handle = sessions
                .lock()
                .ok()
                .and_then(|map| map.get(session_id).cloned());
            if let Some(handle) = handle {
                if let Err(error) = handle.request_desktop_size(payload.width, payload.height) {
                    debug!(%error, session = %session_id, "화면 크기를 요청할 수 없다");
                }
            }
        }
        "disconnectVnc" => {
            let Some(session_id) = request.session_id.as_deref() else {
                return;
            };
            let handle = sessions
                .lock()
                .ok()
                .and_then(|mut map| map.remove(session_id));
            if let Some(handle) = handle {
                handle.close();
            }
            let _ = output.send_event(
                &Event::new("status", StatusPayload { ok: true })
                    .request(&request.id)
                    .session(session_id),
            );
        }
        other => {
            warn!(kind = other, "모르는 요청을 무시한다");
            let _ = output.send_event(
                &Event::new("status", StatusPayload { ok: false }).request(&request.id),
            );
        }
    }
}

fn reply_error(output: &Output, request_id: &str, session_id: Option<&str>, message: &str) {
    let mut event = Event::new(
        "error",
        ErrorPayload {
            message: message.to_owned(),
        },
    )
    .request(request_id);
    if let Some(session_id) = session_id {
        event = event.session(session_id);
    }
    let _ = output.send_event(&event);
}
