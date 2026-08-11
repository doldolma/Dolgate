//! RFB (VNC) 클라이언트 코어.
//!
//! **왜 별도 사이드카인가:** 화면·입력을 다루는 일은 rdp-core 와 같은 모양이지만(9바이트 stdio
//! 프레이밍, 픽셀을 stream frame 으로 올려보내기), 프로토콜이 공유하는 것은 하나도 없다. 같은
//! 크레이트에 넣으면 RDP 세션에도 VNC 의존성이 실린다.
//!
//! **화면 전달 계약은 rdp-core 와 같다.** 사각형 좌표 + 빽빽하게 채운 RGBA 바이트다. RFB 의
//! FramebufferUpdate 가 정확히 그 모양이라, 렌더러의 캔버스 경로를 그대로 쓸 수 있다.
//!
//! 이 크레이트는 아직 프로토콜 계층만 담는다. stdio 루프와 세션 관리는 다음 단계에서 붙는다.

pub mod auth;
pub mod decode;
pub mod protocol;
