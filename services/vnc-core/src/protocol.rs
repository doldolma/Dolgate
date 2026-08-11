//! 데스크톱(Electron 메인)과 주고받는 제어 프로토콜.
//!
//! rdp-core 의 같은 이름 모듈과 같은 모양이다 — `CoreRequest`/`CoreEvent`/`CoreStreamFrame` 을
//! 그대로 따르므로 데스크톱은 `core-framing.ts` 를 고치지 않고 쓴다. 필드 이름이 camelCase 인
//! 이유도 같다.

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub payload: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event<T> {
    #[serde(rename = "type")]
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub payload: T,
}

impl<T> Event<T> {
    pub fn new(kind: &'static str, payload: T) -> Self {
        Self {
            kind,
            request_id: None,
            session_id: None,
            payload,
        }
    }

    pub fn request(mut self, request_id: impl Into<String>) -> Self {
        self.request_id = Some(request_id.into());
        self
    }

    pub fn session(mut self, session_id: impl Into<String>) -> Self {
        self.session_id = Some(session_id.into());
        self
    }
}

fn default_vnc_port() -> u16 {
    5900
}

fn default_shared() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectPayload {
    pub host: String,
    #[serde(default = "default_vnc_port")]
    pub port: u16,
    /// VncAuth 비밀번호. 서버가 None 을 제시하면 쓰이지 않는다.
    ///
    /// **9자 이상은 서버가 무시한다** — 규격이 8바이트로 자르기 때문이다(auth.rs 참고).
    #[serde(default)]
    pub password: String,
    /// false 면 서버가 다른 클라이언트를 끊는다. 기본은 공유다 — 화면을 같이 보는 것이 VNC 의
    /// 일반적인 사용 방식이고, 남의 세션을 끊는 것은 사용자가 명시적으로 고를 일이다.
    #[serde(default = "default_shared")]
    pub shared: bool,
}

/// 입력 이벤트 묶음. 렌더러가 한 번에 여러 개를 보낸다(마우스 이동이 특히 잦다).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputBatch {
    pub events: Vec<InputEvent>,
}

/// 한 입력 이벤트.
///
/// **키는 X11 keysym 이다** — RDP 의 스캔코드와 다른 체계라 렌더러가 변환해서 보낸다. 프로토콜이
/// keysym 만 받으므로 코어에서 스캔코드 표를 들 이유가 없다.
///
/// 좌표는 모든 포인터 이벤트에 실린다. RFB 의 PointerEvent 는 버튼 마스크와 위치를 매번 함께
/// 보내는 상태 기반 메시지이고, 우리는 그 상태를 세션에서 들고 있는다(session.rs).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InputEvent {
    #[serde(rename_all = "camelCase")]
    MouseMove { x: u16, y: u16 },
    #[serde(rename_all = "camelCase")]
    MouseButton {
        /// 0=왼쪽, 1=가운데, 2=오른쪽.
        button: u8,
        pressed: bool,
        x: u16,
        y: u16,
    },
    #[serde(rename_all = "camelCase")]
    Wheel {
        /// 위/아래(수직) 또는 좌/우(수평).
        vertical: bool,
        /// 양수 = 위 또는 오른쪽. 크기는 무시하고 방향만 쓴다 — RFB 는 휠을 버튼 누름으로
        /// 표현하므로 단계 수가 없다.
        delta: i16,
        x: u16,
        y: u16,
    },
    #[serde(rename_all = "camelCase")]
    Key { keysym: u32, pressed: bool },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyPayload {
    pub version: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedPayload {
    pub desktop_width: u16,
    pub desktop_height: u16,
    /// 서버가 붙인 세션 이름(ServerInit). 탭 제목 후보로 쓸 수 있다.
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizedPayload {
    pub desktop_width: u16,
    pub desktop_height: u16,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorPayload {
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct EmptyPayload {}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusPayload {
    pub ok: bool,
}

/// 픽셀을 실어 보내는 stream frame 의 메타데이터.
///
/// 페이로드는 `width * height * 4` 바이트의 RGBA 이고 빽빽하게 채워져 있다 — 보내는 쪽이 이미
/// 프레임버퍼 stride 를 걷어냈으므로 받는 쪽은 그대로 캔버스에 넘기면 된다. rdp-core 의
/// `rdpFrame` 과 같은 계약이고 `type` 만 다르다.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FramePayload {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub session_id: String,
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connect_payload_defaults_to_the_vnc_port_and_shared_access() {
        let payload: ConnectPayload =
            serde_json::from_str(r#"{"host":"192.168.1.10"}"#).unwrap();
        assert_eq!(payload.port, 5900);
        assert!(payload.shared);
        assert_eq!(payload.password, "");
    }

    #[test]
    fn connect_payload_reads_camel_case_fields() {
        let payload: ConnectPayload = serde_json::from_str(
            r#"{"host":"pve","port":5901,"password":"secret","shared":false}"#,
        )
        .unwrap();
        assert_eq!((payload.host.as_str(), payload.port), ("pve", 5901));
        assert!(!payload.shared);
    }

    #[test]
    fn input_events_are_tagged_by_kind() {
        let batch: InputBatch = serde_json::from_str(
            r#"{"events":[
                {"kind":"mouseMove","x":10,"y":20},
                {"kind":"mouseButton","button":2,"pressed":true,"x":10,"y":20},
                {"kind":"wheel","vertical":true,"delta":-1,"x":10,"y":20},
                {"kind":"key","keysym":65293,"pressed":true}
            ]}"#,
        )
        .unwrap();
        assert_eq!(batch.events.len(), 4);
        assert!(matches!(
            batch.events[0],
            InputEvent::MouseMove { x: 10, y: 20 }
        ));
        assert!(matches!(
            batch.events[1],
            InputEvent::MouseButton {
                button: 2,
                pressed: true,
                ..
            }
        ));
        assert!(matches!(
            batch.events[3],
            InputEvent::Key {
                keysym: 65293,
                pressed: true
            }
        ));
    }

    // 프레임 메타데이터는 렌더러가 읽는 계약이다. 이름이 바뀌면 화면이 안 그려지므로 바이트로
    // 고정한다(rdp-core 의 같은 테스트와 같은 이유).
    #[test]
    fn frame_metadata_uses_camel_case() {
        let meta = FramePayload {
            kind: "vncFrame",
            session_id: "sess-1".to_owned(),
            x: 10,
            y: 20,
            width: 30,
            height: 40,
        };
        assert_eq!(
            serde_json::to_string(&meta).unwrap(),
            r#"{"type":"vncFrame","sessionId":"sess-1","x":10,"y":20,"width":30,"height":40}"#
        );
    }

    #[test]
    fn event_envelope_omits_absent_ids() {
        let event = Event::new("closed", EmptyPayload {}).session("sess-1");
        assert_eq!(
            serde_json::to_string(&event).unwrap(),
            r#"{"type":"closed","sessionId":"sess-1","payload":{}}"#
        );
    }
}
