//! RFB (VNC) 클라이언트 코어.
//!
//! **왜 별도 사이드카인가:** 화면·입력을 다루는 일은 rdp-core 와 같은 모양이지만(9바이트 stdio
//! 프레이밍, 픽셀을 stream frame 으로 올려보내기), 프로토콜이 공유하는 것은 하나도 없다. 같은
//! 크레이트에 넣으면 RDP 세션에도 VNC 의존성이 실린다.
//!
//! **화면 전달 계약은 rdp-core 와 같다.** 사각형 좌표 + 빽빽하게 채운 RGBA 바이트다. RFB 의
//! FramebufferUpdate 가 정확히 그 모양이라, 렌더러의 캔버스 경로를 그대로 쓸 수 있다.
//!
//! 라이브러리와 바이너리가 같은 모듈을 쓴다. 테스트는 라이브러리 쪽으로 붙는다.
//!
//! 모듈 이름은 rdp-core 와 같은 뜻으로 쓴다 — `protocol` 은 데스크톱과 주고받는 제어 프로토콜이고,
//! RFB 와이어는 `rfb` 다. 두 코어를 함께 읽는 사람이 같은 단어를 다른 뜻으로 만나지 않게 한다.
//!
//! # 라이브러리 사용법
//!
//! 사이드카 바이너리(stdin/stdout framing)는 기존과 같다. 모바일 FFI 등 라이브러리 소비자는
//! [`VncSink`] trait 을 구현해 프레임·이벤트를 직접 받을 수 있다:
//!
//! ```ignore
//! use std::sync::Arc;
//! use vnc_core::sink::{VncSink, FrameRect, CursorShape, VncEvent};
//! use vnc_core::session;
//! use vnc_core::protocol::ConnectPayload;
//!
//! struct MySink;
//! impl VncSink for MySink {
//!     fn on_frame(&self, session_id: &str, frame: FrameRect<'_>) -> std::io::Result<()> {
//!         // RGBA 슬라이스를 직접 받아 렌더링
//!         Ok(())
//!     }
//!     fn on_cursor(&self, session_id: &str, cursor: CursorShape<'_>) -> std::io::Result<()> {
//!         Ok(())
//!     }
//!     fn on_event(&self, session_id: &str, event: VncEvent) -> std::io::Result<()> {
//!         Ok(())
//!     }
//! }
//!
//! let sink = Arc::new(MySink);
//! session::run_with_sink("sess-1".into(), "req-1".into(), payload, sink, |handle| {
//!     // handle 을 저장해 입력·클립보드·끊기를 제어
//! });
//! ```
//!
//! # 무엇이 되고 무엇이 안 되나
//!
//! RFB 는 확장이 많고 서버마다 켜는 것이 달라서, "안 되는 것" 을 적어 두지 않으면 붙지 않는 서버를
//! 만날 때마다 처음부터 조사하게 된다. 아래가 그 목록이다.
//!
//! **인증(보안 타입)** — 되는 것: None(1), VncAuth(2), VeNCrypt(19)의 TLSNone·TLSVnc·TLSPlain,
//! Apple Remote Desktop(30). X509None·X509Vnc·X509Plain 은 인증서 TOFU 검증이 앱 저장소까지
//! 연결되기 전에는 **고르지 않는다** — 검증하지 않은 인증서로 자격 증명을 보내지 않기 위해서다.
//! 다만 X509 가 함께 제시됐다는 이유로 쓸 수 있는 서브타입까지 버리지는 않는다(서버가 X509 만
//! 제시할 때에만 거부한다, `pick_vencrypt_subtype` 참고).
//!
//! 안 되는 것은 [`session`] 의 `describe_security_number` 에 번호·이름·이유가 함께 있다. 서버가
//! 그것만 제시하면 이름을 말하고 거부한다 — 번호만 보여주면 사용자가 무엇을 바꿔야 할지 모른다.
//! 맨몸 Plain(256)은 **구현했지만 일부러 거부한다**: TLS 없이 비밀번호가 평문으로 나간다.
//!
//! **인코딩** — 선언하는 것은 [`rfb::CLIENT_ENCODINGS`] 하나뿐이다. Hextile·RRE·CoRRE·zlib·
//! ZlibHex·H.264 는 선언하지 않고, 서버는 선언한 것만 보내므로 그것으로 충분하다(선언하지 않은
//! 인코딩이 오면 그건 서버 결함이고, 디코더가 알 수 없는 번호로 끊는다).
//!
//! **클립보드** — UTF-8 은 ExtendedClipboard 로 된다. 이 확장은 상수 하나가 틀리면 협상이 조용히
//! 실패하고 그것이 "서버가 지원하지 않는다" 로 보인다 — 실제로 그렇게 오진했다. 규격 번호는
//! `0xc0a1e5ce` 이고 다른 의사 인코딩처럼 작은 음수가 아니다([`clipboard`] 참고).
//!
//! **모니터** — 프레임버퍼가 하나뿐이다. RFB 에는 RDP 의 다중 모니터 협상에 해당하는 것이 없어서,
//! 모니터별 창은 그 하나를 잘라 쓴다.
//!
//! 실서버 회귀는 `testing/matrix.sh` 가 구현체 4종 12조합으로 돌린다 — 화면·세션 유지·붙여넣은
//! 값까지 본다. 단위 테스트만으로는 "붙고 화면도 오는데 클립보드가 안 되는" 종류를 놓친다.

/// Apple Remote Desktop 인증(macOS 화면 공유).
pub mod ard;
pub mod auth;
/// 클립보드: 고전 CutText 와 ExtendedClipboard.
pub mod clipboard;
/// 커서 모양(Cursor 의사 인코딩).
pub mod cursor;
pub mod decode;
pub mod output;
/// 데스크톱과 주고받는 제어 프로토콜(rdp-core 의 같은 이름과 같은 뜻이다).
pub mod protocol;
/// RFB 와이어 프로토콜.
pub mod rfb;
pub mod session;
/// 세션 내부 출력 경계 (crate-internal).
pub(crate) mod session_output;
/// 출력 경계 추상화: [`VncSink`] trait 과 typed 이벤트.
pub mod sink;
/// Tight 디코더.
pub mod tight;
/// VeNCrypt 의 TLS 계층.
pub mod tls;
/// 세션이 쓰는 바이트 통로(평문/TLS).
pub mod transport;
/// VeNCrypt 협상.
pub mod vencrypt;
/// ZRLE 디코더.
pub mod zrle;

/// 모바일 FFI C ABI 세션 계층.
///
/// opaque handle은 process-local monotonic token이며 절대 역참조하지 않는다.
/// 내부 registry가 token → Arc<Session>을 소유한다.
pub mod ffi;
