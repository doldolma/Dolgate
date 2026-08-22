//! 출력 경계 추상화.
//!
//! 사이드카는 stdout 으로 프레임을 내보내지만, 모바일 FFI 소비자는 콜백으로 직접 받아야 한다.
//! 이 모듈이 그 경계를 정의한다 — 기존 사이드카는 `SessionOutput::Stdio` 를 쓰고, 라이브러리
//! 소비자는 `VncSink` 를 구현해 프레임·이벤트를 자기 방식으로 받는다.
//!
//! # Drop 동작과 프레임버퍼
//!
//! VncSink 구현체가 drop될 때, 아직 전달하지 못한 damage 사각형이 있을 수 있다. 이 경우
//! 다음 세션에서 authoritative framebuffer에 coalesce하거나, 수신 측이 full refresh를
//! 요청해야 한다(full dirty로 간주). drop 시 손실된 프레임은 복구할 수 없으므로 renderer는
//! 재연결 후 `dvnc_session_refresh()`로 전체 화면을 다시 받아야 한다.
//!
//! # 콜백 실패 정책
//!
//! FFI 콜백 시그니처는 `void`를 반환한다. renderer 콜백이 내부적으로 실패하더라도
//! (Metal/OpenGL 텍스처 업로드 실패 등) Rust 세션은 끊기지 않는다. 세션은 계속 돌고,
//! 다음 프레임에서 복구할 기회를 준다. 콜백에서 세션을 끊으려면 별도 스레드에서
//! `dvnc_session_disconnect()`를 호출해야 한다.

use std::io;

use crate::protocol::CapabilitiesPayload;

/// 프레임 사각형. x/y/width/height + RGBA 슬라이스를 JSON/base64 변환 없이 직접 전달한다.
#[derive(Debug, Clone)]
pub struct FrameRect<'a> {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
    /// `width * height * 4` 바이트의 빽빽한 RGBA.
    pub pixels: &'a [u8],
}

/// 커서 모양.
#[derive(Debug, Clone)]
pub struct CursorShape<'a> {
    pub hotspot_x: u16,
    pub hotspot_y: u16,
    pub width: u16,
    pub height: u16,
    /// `width * height * 4` 바이트의 RGBA. 투명 픽셀은 알파 0.
    pub rgba: &'a [u8],
}

/// 세션에서 발생하는 typed 이벤트.
#[derive(Debug, Clone)]
pub enum VncEvent {
    /// 연결 성공.
    Connected {
        desktop_width: u16,
        desktop_height: u16,
        name: String,
    },
    /// 화면 크기 변경.
    Resized {
        desktop_width: u16,
        desktop_height: u16,
    },
    /// 서버 capabilities 변경.
    Capabilities(CapabilitiesPayload),
    /// 서버에서 클립보드 텍스트를 받았다.
    Clipboard { text: String },
    /// 고전 클립보드로 보내며 손실된 글자가 있다.
    ClipboardLossy { replaced: usize },
    /// 세션이 정상 종료했다.
    Closed,
    /// 오류로 끝났다.
    Error { message: String },
}

/// 출력 경계 trait. 세션이 생산하는 모든 것을 받는다.
///
/// 프레임과 커서는 RGBA 슬라이스를 직접 건네므로 JSON/base64 오버헤드가 없다.
/// 제어 이벤트는 `VncEvent` enum 으로 typed 하게 전달된다.
///
/// 구현체는 `Send + Sync + 'static` 이어야 세션 스레드에서 쓸 수 있다.
pub trait VncSink: Send + Sync + 'static {
    /// 프레임 사각형을 받는다.
    ///
    /// 대기열이 차면 버려도 된다(화면은 다음 갱신에서 복구된다). 여기서 오래 막히면 세션 루프가
    /// 멈추므로 빠르게 돌아가야 한다.
    fn on_frame(&self, session_id: &str, frame: FrameRect<'_>) -> io::Result<()>;

    /// 커서 모양을 받는다. width/height 가 0 이면 "커서를 숨겨라" 는 뜻이다.
    fn on_cursor(&self, session_id: &str, cursor: CursorShape<'_>) -> io::Result<()>;

    /// typed 이벤트를 받는다.
    fn on_event(&self, session_id: &str, event: VncEvent) -> io::Result<()>;

    /// request_id 가 있는 이벤트(connected, error 등의 응답).
    /// 기본 구현은 request_id 를 무시하고 on_event 를 부른다.
    fn on_event_with_request(
        &self,
        session_id: &str,
        request_id: &str,
        event: VncEvent,
    ) -> io::Result<()> {
        let _ = request_id;
        self.on_event(session_id, event)
    }
}
