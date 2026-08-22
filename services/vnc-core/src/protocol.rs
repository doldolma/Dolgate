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
    /// 비밀번호. 서버가 None 을 제시하면 쓰이지 않는다.
    ///
    /// VncAuth 로 붙을 때는 **앞 8바이트만** 쓰인다(규격이 DES 키로 쓰려고 자른다, auth.rs 참고).
    /// VeNCrypt 의 Plain 계열은 그 제약이 없어 전체가 쓰인다.
    #[serde(default)]
    pub password: String,
    /// 계정. VeNCrypt 의 Plain 계열(TLSPlain·X509Plain)에서만 쓰인다.
    ///
    /// 비어 있으면 계정을 요구하는 방식을 고르지 않는다 — 빈 계정으로 보내면 서버가 거절하고, 그
    /// 실패는 "비밀번호가 틀렸다" 와 구분되지 않는다.
    #[serde(default)]
    pub username: String,
    /// 화질 단계: `lossless`(기본) · `balanced` · `fast`.
    ///
    /// 무손실이 아니면 서버가 사진 영역을 JPEG 로 보낸다 — 대역폭이 크게 줄지만 글자가 뭉개진다.
    /// 모르는 값은 무손실로 떨어진다(rfb::ImageQuality).
    #[serde(default)]
    pub image_quality: String,
    /// false 면 서버가 다른 클라이언트를 끊는다. 기본은 공유다 — 화면을 같이 보는 것이 VNC 의
    /// 일반적인 사용 방식이고, 남의 세션을 끊는 것은 사용자가 명시적으로 고를 일이다.
    #[serde(default = "default_shared")]
    pub shared: bool,
    /// Private preface for an authenticated mobile loopback tunnel.
    #[serde(default)]
    pub tunnel_auth_token: Option<String>,
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
    Key {
        keysym: u32,
        pressed: bool,
        /// PS/2 set 1 스캔코드. 서버가 QEMU 확장 키를 쓸 때만 실려 나간다.
        ///
        /// 없거나 0 이면 keysym 만 보낸다 — 렌더러가 모르는 키이거나, 확장을 안 쓰는 서버다.
        #[serde(default)]
        keycode: u32,
    },
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

/// 원격 화면 크기 요청(앱 → 코어).
///
/// 서버가 `ExtendedDesktopSize` 를 쓰지 않으면 조용히 버려진다 — 크기를 못 바꾸는 서버가 정상적으로
/// 존재하므로 오류가 아니다.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDesktopSizePayload {
    pub width: u16,
    pub height: u16,
}

/// 클립보드 텍스트. 양방향으로 같은 모양을 쓴다 — 이벤트(서버 → 앱)와 요청(앱 → 서버).
///
/// 고전 RFB 클립보드는 latin-1 만 실을 수 있다. 그 변환은 보내는 자리에서 한다(rfb.rs) — 여기서
/// 미리 깎으면 나중에 ExtendedClipboard 를 붙일 때 원본을 잃는다.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardPayload {
    pub text: String,
}

/// 고전 클립보드로 보내면서 담을 수 없는 글자를 `?` 로 바꿨다.
///
/// 서버가 UTF-8 확장을 지원하지 않을 때만 나간다. 알리지 않으면 한글 복사가 조용히 망가진다.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardLossyPayload {
    /// `?` 로 바뀐 글자 수.
    pub replaced: usize,
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

/// 이 세션에서 실제로 켜진 확장.
///
/// **선언과 다르다.** 우리는 늘 같은 목록을 선언하지만 켜지는 것은 서버마다 다르고, 그것은 협상이
/// 끝나 봐야 안다(어떤 것은 서버가 그 기능을 실제로 쓸 때 비로소 드러난다). 사용자가 "왜 한글
/// 복붙이 안 되지" 를 물을 때 답이 여기 있다.
#[derive(Debug, Serialize, PartialEq, Eq, Clone, Copy, Default)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitiesPayload {
    /// UTF-8 클립보드. 꺼져 있으면 고전 latin-1 이라 한글을 담을 수 없다.
    pub extended_clipboard: bool,
    /// 창 크기에 맞춰 원격 해상도를 바꿀 수 있나.
    pub desktop_resize: bool,
    /// 커서 모양을 따로 받아 우리가 그리나(= 커서가 왕복 지연 없이 움직인다).
    pub cursor: bool,
    /// 요청 없이 서버가 계속 보내나.
    pub continuous_updates: bool,
    /// 스캔코드로 키를 보내나(QEMU 확장 키). 꺼져 있으면 keysym 으로만 보낸다.
    pub qemu_keys: bool,
    /// 통로가 TLS 인가(VeNCrypt).
    pub tls: bool,
    /// 서버가 화면에 실제로 쓰는 인코딩. 아직 픽셀을 못 받았으면 빈 문자열이다.
    pub encoding: &'static str,
}

/// 커서 모양을 실어 보내는 stream frame 의 메타데이터.
///
/// 페이로드는 `width * height * 4` 바이트의 RGBA 이고, **투명한 픽셀은 알파가 0** 이다(프레임과
/// 다른 점이다 — 화면 픽셀은 늘 불투명하다).
///
/// `width` 나 `height` 가 0 이면 "커서를 숨겨라" 는 뜻이다. 서버가 커서를 감출 때 그렇게 알린다.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorPayload {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub session_id: String,
    /// 모양 안에서 실제 포인터가 되는 점. CSS 커서의 핫스팟 좌표와 같은 뜻이다.
    pub hotspot_x: u16,
    pub hotspot_y: u16,
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
        assert_eq!(payload.username, "");
        // 화질은 기본이 무손실이다(빈 값 → Lossless).
        assert_eq!(payload.image_quality, "");
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
                pressed: true,
                // 옛 렌더러는 이 필드를 안 보낸다. 기본값 0 으로 떨어져야 한다.
                keycode: 0,
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

    // 커서도 프레임과 같은 stream 경로로 나가므로 데스크톱이 `type` 으로 갈라낸다. 이름이 바뀌면
    // 커서가 화면 사각형으로 그려진다.
    #[test]
    fn cursor_metadata_uses_camel_case() {
        let meta = CursorPayload {
            kind: "vncCursor",
            session_id: "sess-1".to_owned(),
            hotspot_x: 3,
            hotspot_y: 4,
            width: 32,
            height: 32,
        };
        assert_eq!(
            serde_json::to_string(&meta).unwrap(),
            r#"{"type":"vncCursor","sessionId":"sess-1","hotspotX":3,"hotspotY":4,"width":32,"height":32}"#
        );
    }

    // 데스크톱이 읽는 계약이다. 이름이 바뀌면 탭 hover 가 조용히 비어 보인다.
    #[test]
    fn capabilities_use_camel_case() {
        let payload = CapabilitiesPayload {
            extended_clipboard: false,
            desktop_resize: true,
            cursor: true,
            continuous_updates: true,
            qemu_keys: true,
            tls: false,
            encoding: "zrle",
        };
        assert_eq!(
            serde_json::to_string(&payload).unwrap(),
            r#"{"extendedClipboard":false,"desktopResize":true,"cursor":true,"continuousUpdates":true,"qemuKeys":true,"tls":false,"encoding":"zrle"}"#
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
