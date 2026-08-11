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

pub mod auth;
pub mod decode;
pub mod output;
pub mod session;
/// 데스크톱과 주고받는 제어 프로토콜(rdp-core 의 같은 이름과 같은 뜻이다).
pub mod protocol;
/// RFB 와이어 프로토콜.
pub mod rfb;
/// 세션이 쓰는 바이트 통로(평문/TLS).
pub mod transport;
/// VeNCrypt 의 TLS 계층.
pub mod tls;
/// VeNCrypt 협상.
pub mod vencrypt;
/// ZRLE 디코더.
pub mod zrle;
