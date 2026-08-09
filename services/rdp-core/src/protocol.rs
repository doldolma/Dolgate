//! Message shapes exchanged with the Electron main process.
//!
//! These mirror `CoreRequest` / `CoreEvent` / `CoreStreamFrame` from `apps/desktop/src/shared/ipc.ts`
//! so the desktop side can reuse `core-framing.ts` unchanged. Field names are camelCase for the
//! same reason.

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

/// One display the client is offering. Increment 1 accepts a single entry; the multi-monitor work
/// widens this to a list, which is why it is already a struct rather than bare width/height.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorRequest {
    pub width: u16,
    pub height: u16,
    #[serde(default)]
    pub left: i32,
    #[serde(default)]
    pub top: i32,
    #[serde(default)]
    pub primary: bool,
}

// Clone: 그래픽 파이프라인 없이 다시 붙을 때 같은 요청을 그대로 한 번 더 쓴다(session::run).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectPayload {
    pub host: String,
    #[serde(default = "default_rdp_port")]
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub domain: Option<String>,
    pub monitors: Vec<MonitorRequest>,
    /// 원격에 공유할 로컬 폴더. 없으면 드라이브를 붙이지 않는다.
    #[serde(default)]
    pub share: Option<DriveShare>,
}

/// 원격에 노출할 로컬 폴더 하나.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveShare {
    /// 원격에서 보일 드라이브 이름.
    pub label: String,
    pub path: String,
    /// 원격이 이 폴더를 수정하지 못하게 한다.
    #[serde(default)]
    pub read_only: bool,
}

fn default_rdp_port() -> u16 {
    3389
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedPayload {
    pub desktop_width: u16,
    pub desktop_height: u16,
    /// Where each requested monitor landed inside the framebuffer, 0-based.
    pub monitors: Vec<MonitorPlacement>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorPlacement {
    pub index: usize,
    pub left: u16,
    pub top: u16,
    pub width: u16,
    pub height: u16,
}

/// 렌더러가 보내는 입력 이벤트.
///
/// 스캔코드는 확장 키를 0xE000 비트로 표현한 u16 이다(Scancode::from_u16 과 같은 규칙).
/// 좌표는 이미 원격 데스크톱 픽셀로 환산되어 온다 — 캔버스 표시 배율은 렌더러 쪽 사정이다.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InputEvent {
    #[serde(rename_all = "camelCase")]
    MouseMove { x: u16, y: u16 },
    #[serde(rename_all = "camelCase")]
    MouseButton { button: u8, pressed: bool },
    #[serde(rename_all = "camelCase")]
    Wheel { vertical: bool, delta: i16 },
    #[serde(rename_all = "camelCase")]
    Key { scancode: u16, pressed: bool },
    /// 스캔코드로 표현할 수 없는 문자(IME 조합 결과 등).
    #[serde(rename_all = "camelCase")]
    Unicode { character: char, pressed: bool },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputPayload {
    pub events: Vec<InputEvent>,
}

/// TLS 핸드셰이크 직후, CredSSP 로 자격증명을 보내기 전에 올리는 인증서 정보.
///
/// 여기서 멈추는 것이 핵심이다 — 접속을 끝내고 물어보면 이미 비밀번호가 나간 뒤다.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificatePayload {
    /// DER 의 SHA-256 을 대문자 16진수로, 두 자리씩 콜론으로 끊어 표기한다(mstsc 지문과 같은 형식).
    pub fingerprint: String,
    pub subject: String,
    pub issuer: String,
    pub not_after: String,
}

/// 원격 데스크톱 크기 변경 요청.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizePayload {
    pub width: u16,
    pub height: u16,
}

/// 해상도가 실제로 바뀐 뒤 알린다. 렌더러는 캔버스와 누적 버퍼를 다시 만들어야 한다.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizedPayload {
    pub desktop_width: u16,
    pub desktop_height: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustVerdictPayload {
    pub accept: bool,
}

/// 원격에서 복사된 텍스트. 데스크톱이 로컬 클립보드에 넣는다.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardTextPayload {
    pub text: String,
}

/// 로컬 클립보드 텍스트를 코어에 알린다. 원격이 붙여넣을 때 꺼내 쓴다.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardSetPayload {
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorPayload {
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusPayload {
    pub ok: bool,
}

#[derive(Debug, Serialize)]
pub struct EmptyPayload {}

/// 오디오 stream frame 메타데이터. 페이로드는 인터리브된 리틀엔디언 PCM 이다.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFramePayload {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub session_id: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub bits_per_sample: u16,
    /// 서버가 붙인 타임스탬프(ms). 재생 순서 판단에 쓴다.
    pub timestamp: u32,
}

/// Metadata for a stream frame carrying pixels.
///
/// The payload is `width * height * 4` bytes of RGBA, packed tightly — the sender has already
/// walked the framebuffer's stride, so the receiver can hand it straight to `texSubImage2D`.
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

/// 화면 영역 복사. 픽셀 없이 "여기 것을 저기로 옮겨라"만 보낸다.
///
/// EGFX 의 SurfaceToSurface 다. 스크롤이 이걸로 오면 화면 한 장을 다시 인코딩·전송할 필요가
/// 없어진다 — 레거시 경로에 이 명령이 없어서 스크롤이 느렸다.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyRectPayload {
    pub source_x: u16,
    pub source_y: u16,
    pub width: u16,
    pub height: u16,
    pub dest_x: u16,
    pub dest_y: u16,
}

/// 한 가지 색으로 채우기. EGFX 의 SolidFill.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FillRectPayload {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

/// 화면 조각을 캐시 칸에 넣거나 꺼낸다. 역시 픽셀이 오가지 않는다 — 렌더러가 이미 가진
/// 누적본에서 떠 두었다가 도로 놓는다.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheRectPayload {
    pub slot: u16,
    pub source_x: u16,
    pub source_y: u16,
    pub width: u16,
    pub height: u16,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedRectPayload {
    pub slot: u16,
    pub dest_x: u16,
    pub dest_y: u16,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvictCachePayload {
    pub slot: u16,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_connect_request() {
        let raw = r#"{
            "id": "req-1",
            "type": "connectRdp",
            "sessionId": "sess-1",
            "payload": {
                "host": "192.168.200.27",
                "username": "user",
                "password": "secret",
                "monitors": [{ "width": 2560, "height": 1440, "primary": true }]
            }
        }"#;

        let request: Request = serde_json::from_str(raw).unwrap();
        assert_eq!(request.kind, "connectRdp");
        assert_eq!(request.session_id.as_deref(), Some("sess-1"));

        let payload: ConnectPayload = serde_json::from_value(request.payload).unwrap();
        assert_eq!(payload.port, 3389, "port defaults when omitted");
        assert_eq!(payload.monitors.len(), 1);
        assert_eq!(payload.monitors[0].width, 2560);
        assert!(payload.monitors[0].primary);
    }

    #[test]
    fn serializes_an_event_without_empty_optionals() {
        let event = Event::new("connected", ConnectedPayload {
            desktop_width: 2560,
            desktop_height: 1440,
            monitors: vec![MonitorPlacement {
                index: 0,
                left: 0,
                top: 0,
                width: 2560,
                height: 1440,
            }],
        })
        .session("sess-1");

        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains(r#""type":"connected""#));
        assert!(json.contains(r#""sessionId":"sess-1""#));
        assert!(json.contains(r#""desktopWidth":2560"#));
        assert!(!json.contains("requestId"), "unset optionals are omitted");
    }

    #[test]
    fn parses_every_input_event_shape() {
        let raw = r#"{
            "events": [
                { "kind": "mouseMove", "x": 100, "y": 200 },
                { "kind": "mouseButton", "button": 0, "pressed": true },
                { "kind": "wheel", "vertical": true, "delta": -120 },
                { "kind": "key", "scancode": 57373, "pressed": true },
                { "kind": "unicode", "character": "가", "pressed": true }
            ]
        }"#;

        let payload: InputPayload = serde_json::from_str(raw).unwrap();
        assert_eq!(payload.events.len(), 5);

        assert!(matches!(payload.events[0], InputEvent::MouseMove { x: 100, y: 200 }));
        assert!(matches!(
            payload.events[1],
            InputEvent::MouseButton {
                button: 0,
                pressed: true
            }
        ));
        assert!(matches!(
            payload.events[2],
            InputEvent::Wheel {
                vertical: true,
                delta: -120
            }
        ));
        // 0xE01D = 확장 비트가 선 오른쪽 Ctrl.
        assert!(matches!(
            payload.events[3],
            InputEvent::Key {
                scancode: 0xE01D,
                pressed: true
            }
        ));
        assert!(matches!(
            payload.events[4],
            InputEvent::Unicode {
                character: '가',
                pressed: true
            }
        ));
    }

    #[test]
    fn frame_metadata_uses_camel_case() {
        let meta = FramePayload {
            kind: "rdpFrame",
            session_id: "sess-1".to_owned(),
            x: 10,
            y: 20,
            width: 30,
            height: 40,
        };

        let json = serde_json::to_string(&meta).unwrap();
        assert_eq!(
            json,
            r#"{"type":"rdpFrame","sessionId":"sess-1","x":10,"y":20,"width":30,"height":40}"#
        );
    }
}
