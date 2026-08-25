//! VncSink trait 과 SessionOutput 의 단위 테스트.

use std::io;
use std::sync::{Arc, Mutex};

use vnc_core::protocol::CapabilitiesPayload;
use vnc_core::sink::{CursorShape, FrameRect, VncEvent, VncSink};

/// 테스트용 VncSink. 받은 이벤트를 모아 둔다.
#[derive(Debug, Default)]
struct CollectingSink {
    events: Mutex<Vec<(String, VncEvent)>>,
    frames: Mutex<Vec<(String, u16, u16, u16, u16, Vec<u8>)>>,
    cursors: Mutex<Vec<(String, u16, u16, u16, u16, Vec<u8>)>>,
}

impl VncSink for CollectingSink {
    fn on_frame(&self, session_id: &str, frame: FrameRect<'_>) -> io::Result<()> {
        self.frames.lock().unwrap().push((
            session_id.to_owned(),
            frame.x,
            frame.y,
            frame.width,
            frame.height,
            frame.pixels.to_vec(),
        ));
        Ok(())
    }

    fn on_cursor(&self, session_id: &str, cursor: CursorShape<'_>) -> io::Result<()> {
        self.cursors.lock().unwrap().push((
            session_id.to_owned(),
            cursor.hotspot_x,
            cursor.hotspot_y,
            cursor.width,
            cursor.height,
            cursor.rgba.to_vec(),
        ));
        Ok(())
    }

    fn on_event(&self, session_id: &str, event: VncEvent) -> io::Result<()> {
        self.events
            .lock()
            .unwrap()
            .push((session_id.to_owned(), event));
        Ok(())
    }
}

#[test]
fn vnc_sink_receives_typed_events_without_json() {
    let sink = Arc::new(CollectingSink::default());
    // VncEvent 를 직접 만들어 sink 에 보낸다.
    sink.on_event(
        "sess-1",
        VncEvent::Connected {
            desktop_width: 1920,
            desktop_height: 1080,
            name: "test-server".to_owned(),
        },
    )
    .unwrap();
    sink.on_event("sess-1", VncEvent::Closed).unwrap();

    let events = sink.events.lock().unwrap();
    assert_eq!(events.len(), 2);
    match &events[0].1 {
        VncEvent::Connected {
            desktop_width,
            desktop_height,
            name,
        } => {
            assert_eq!(*desktop_width, 1920);
            assert_eq!(*desktop_height, 1080);
            assert_eq!(name, "test-server");
        }
        other => panic!("expected Connected, got {:?}", other),
    }
    assert!(matches!(events[1].1, VncEvent::Closed));
}

#[test]
fn vnc_sink_receives_raw_rgba_frame() {
    let sink = Arc::new(CollectingSink::default());
    // 2x2 RGBA 프레임 = 16 바이트
    let pixels: Vec<u8> = vec![
        255, 0, 0, 255, // red
        0, 255, 0, 255, // green
        0, 0, 255, 255, // blue
        255, 255, 0, 255, // yellow
    ];
    sink.on_frame(
        "sess-1",
        FrameRect {
            x: 10,
            y: 20,
            width: 2,
            height: 2,
            pixels: &pixels,
        },
    )
    .unwrap();

    let frames = sink.frames.lock().unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].0, "sess-1");
    assert_eq!((frames[0].1, frames[0].2), (10, 20)); // x, y
    assert_eq!((frames[0].3, frames[0].4), (2, 2)); // width, height
    assert_eq!(frames[0].5.len(), 16); // RGBA bytes
    assert_eq!(frames[0].5[0..4], [255, 0, 0, 255]); // first pixel = red
}

#[test]
fn vnc_sink_receives_cursor_shape() {
    let sink = Arc::new(CollectingSink::default());
    let rgba = vec![0_u8; 32 * 32 * 4]; // 32x32 transparent cursor
    sink.on_cursor(
        "sess-1",
        CursorShape {
            hotspot_x: 3,
            hotspot_y: 4,
            width: 32,
            height: 32,
            rgba: &rgba,
        },
    )
    .unwrap();

    let cursors = sink.cursors.lock().unwrap();
    assert_eq!(cursors.len(), 1);
    assert_eq!((cursors[0].1, cursors[0].2), (3, 4)); // hotspot
    assert_eq!((cursors[0].3, cursors[0].4), (32, 32)); // size
    assert_eq!(cursors[0].5.len(), 32 * 32 * 4);
}

#[test]
fn vnc_event_carries_capabilities() {
    let sink = Arc::new(CollectingSink::default());
    let caps = CapabilitiesPayload {
        extended_clipboard: true,
        desktop_resize: true,
        cursor: true,
        continuous_updates: false,
        qemu_keys: false,
        tls: true,
        encoding: "zrle",
    };
    sink.on_event("sess-1", VncEvent::Capabilities(caps))
        .unwrap();

    let events = sink.events.lock().unwrap();
    match &events[0].1 {
        VncEvent::Capabilities(c) => {
            assert!(c.extended_clipboard);
            assert!(c.tls);
            assert_eq!(c.encoding, "zrle");
        }
        other => panic!("expected Capabilities, got {:?}", other),
    }
}

#[test]
fn vnc_event_carries_clipboard_text() {
    let sink = Arc::new(CollectingSink::default());
    sink.on_event(
        "sess-1",
        VncEvent::Clipboard {
            text: "안녕하세요".to_owned(),
        },
    )
    .unwrap();

    let events = sink.events.lock().unwrap();
    match &events[0].1 {
        VncEvent::Clipboard { text } => {
            assert_eq!(text, "안녕하세요");
        }
        other => panic!("expected Clipboard, got {:?}", other),
    }
}

#[test]
fn vnc_event_carries_error_message_and_cause() {
    let sink = Arc::new(CollectingSink::default());
    sink.on_event(
        "sess-1",
        VncEvent::Error {
            message: "connection refused (대상 컴퓨터에서 거부했다 (os error 10061))".to_owned(),
            failure: Some("refused"),
        },
    )
    .unwrap();

    let events = sink.events.lock().unwrap();
    match &events[0].1 {
        // 문구와 코드가 함께 실려야 한다 — 구버전 앱은 문구를, 새 앱은 코드를 읽는다.
        VncEvent::Error { message, failure } => {
            assert!(message.starts_with("connection refused"), "{message}");
            assert_eq!(*failure, Some("refused"));
        }
        other => panic!("expected Error, got {:?}", other),
    }
}

#[test]
fn default_on_event_with_request_delegates_to_on_event() {
    let sink = Arc::new(CollectingSink::default());
    // 기본 구현은 request_id 를 무시하고 on_event 를 부른다.
    sink.on_event_with_request(
        "sess-1",
        "req-42",
        VncEvent::Connected {
            desktop_width: 800,
            desktop_height: 600,
            name: "test".to_owned(),
        },
    )
    .unwrap();

    let events = sink.events.lock().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].0, "sess-1");
}
