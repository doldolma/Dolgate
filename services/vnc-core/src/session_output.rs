//! 세션 내부에서 쓰는 출력 경계.
//!
//! `SessionOutput` 은 세션 코드가 이벤트·프레임·커서를 내보내는 유일한 경로다.
//! 내부적으로 `Output`(사이드카 stdio) 또는 `Arc<dyn VncSink>`(라이브러리 콜백) 중 하나를
//! 갖고 같은 인터페이스를 제공한다.

use std::io;
use std::sync::Arc;

use crate::output::Output;
use crate::protocol::{
    ClipboardLossyPayload, ClipboardPayload, ConnectedPayload, CursorPayload, EmptyPayload,
    ErrorPayload, Event, FramePayload, ResizedPayload,
};
use crate::sink::{CursorShape, FrameRect, VncEvent, VncSink};

/// 세션이 출력을 보내는 데 쓰는 통합 구조체.
///
/// `Clone` 이어야 여러 자리(pump, connect_and_run 등)에서 공유한다.
/// `Send + Sync` 이어야 세션 스레드에서 쓸 수 있다.
#[derive(Clone)]
pub(crate) enum SessionOutput {
    /// 사이드카 경로: core-framing 을 통해 stdout 으로 나간다.
    Stdio(Output),
    /// 라이브러리 경로: VncSink trait 콜백으로 직접 전달한다.
    #[allow(dead_code)]
    Sink(Arc<dyn VncSink>),
}

impl SessionOutput {
    pub(crate) fn from_output(output: Output) -> Self {
        Self::Stdio(output)
    }

    #[allow(dead_code)]
    pub(crate) fn from_sink(sink: Arc<dyn VncSink>) -> Self {
        Self::Sink(sink)
    }

    /// 제어 이벤트(connected, closed, error, capabilities, clipboard 등).
    pub(crate) fn emit_event(&self, session_id: &str, event: VncEvent) -> io::Result<()> {
        match self {
            Self::Stdio(output) => emit_event_stdio(output, session_id, None, event),
            Self::Sink(sink) => sink.on_event(session_id, event),
        }
    }

    /// request_id 가 있는 이벤트(응답).
    pub(crate) fn emit_event_with_request(
        &self,
        session_id: &str,
        request_id: &str,
        event: VncEvent,
    ) -> io::Result<()> {
        match self {
            Self::Stdio(output) => emit_event_stdio(output, session_id, Some(request_id), event),
            Self::Sink(sink) => sink.on_event_with_request(session_id, request_id, event),
        }
    }

    /// 픽셀 프레임.
    pub(crate) fn emit_frame(
        &self,
        session_id: &str,
        x: u16,
        y: u16,
        width: u16,
        height: u16,
        pixels: &[u8],
    ) -> io::Result<()> {
        match self {
            Self::Stdio(output) => output.send_frame(
                &FramePayload {
                    kind: "vncFrame",
                    session_id: session_id.to_owned(),
                    x,
                    y,
                    width,
                    height,
                },
                pixels,
            ),
            Self::Sink(sink) => sink.on_frame(
                session_id,
                FrameRect {
                    x,
                    y,
                    width,
                    height,
                    pixels,
                },
            ),
        }
    }

    /// 커서 모양.
    pub(crate) fn emit_cursor(
        &self,
        session_id: &str,
        hotspot_x: u16,
        hotspot_y: u16,
        width: u16,
        height: u16,
        rgba: &[u8],
    ) -> io::Result<()> {
        match self {
            Self::Stdio(output) => output.send_cursor(
                &CursorPayload {
                    kind: "vncCursor",
                    session_id: session_id.to_owned(),
                    hotspot_x,
                    hotspot_y,
                    width,
                    height,
                },
                rgba,
            ),
            Self::Sink(sink) => sink.on_cursor(
                session_id,
                CursorShape {
                    hotspot_x,
                    hotspot_y,
                    width,
                    height,
                    rgba,
                },
            ),
        }
    }
}

/// stdio 경로에서 VncEvent 를 기존 Output 의 Event 로 변환해 보낸다.
fn emit_event_stdio(
    output: &Output,
    session_id: &str,
    request_id: Option<&str>,
    event: VncEvent,
) -> io::Result<()> {
    match event {
        VncEvent::Connected {
            desktop_width,
            desktop_height,
            name,
        } => {
            let mut ev = Event::new(
                "connected",
                ConnectedPayload {
                    desktop_width,
                    desktop_height,
                    name,
                },
            )
            .session(session_id);
            if let Some(rid) = request_id {
                ev = ev.request(rid);
            }
            output.send_event(&ev)
        }
        VncEvent::Resized {
            desktop_width,
            desktop_height,
        } => {
            let mut ev = Event::new(
                "resized",
                ResizedPayload {
                    desktop_width,
                    desktop_height,
                },
            )
            .session(session_id);
            if let Some(rid) = request_id {
                ev = ev.request(rid);
            }
            output.send_event(&ev)
        }
        VncEvent::Capabilities(caps) => {
            let mut ev = Event::new("capabilities", caps).session(session_id);
            if let Some(rid) = request_id {
                ev = ev.request(rid);
            }
            output.send_event(&ev)
        }
        VncEvent::Clipboard { text } => {
            let mut ev = Event::new("clipboard", ClipboardPayload { text }).session(session_id);
            if let Some(rid) = request_id {
                ev = ev.request(rid);
            }
            output.send_event(&ev)
        }
        VncEvent::ClipboardLossy { replaced } => {
            let mut ev = Event::new("clipboardLossy", ClipboardLossyPayload { replaced })
                .session(session_id);
            if let Some(rid) = request_id {
                ev = ev.request(rid);
            }
            output.send_event(&ev)
        }
        VncEvent::Closed => {
            let mut ev = Event::new("closed", EmptyPayload {}).session(session_id);
            if let Some(rid) = request_id {
                ev = ev.request(rid);
            }
            output.send_event(&ev)
        }
        VncEvent::Error { message, failure } => {
            let mut ev =
                Event::new("error", ErrorPayload { message, failure }).session(session_id);
            if let Some(rid) = request_id {
                ev = ev.request(rid);
            }
            output.send_event(&ev)
        }
    }
}
