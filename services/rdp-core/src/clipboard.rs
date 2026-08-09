//! CLIPRDR backend — text only.
//!
//! The clipboard itself lives in Electron, not here. This type is the protocol half: it answers the
//! server's requests and turns remote copies into events the desktop side writes into the real
//! clipboard.
//!
//! Only `CF_UNICODETEXT` is handled. Files and images travel over the same channel but need file
//! streaming and image transcoding, which are their own piece of work — announcing formats we
//! cannot actually deliver would make paste fail on the remote instead of falling back.

use std::sync::Arc;
use std::sync::mpsc::Sender;

use ironrdp_core::impl_as_any;
use ironrdp_cliprdr::backend::{ClipboardMessage, CliprdrBackend};
use ironrdp_cliprdr::pdu::{
    ClipboardFormat, ClipboardFormatId, ClipboardGeneralCapabilityFlags, FileContentsRequest,
    FileContentsResponse, FormatDataRequest, FormatDataResponse, LockDataId,
    OwnedFormatDataResponse,
};
use tracing::debug;

use crate::output::Output;
use crate::protocol::{ClipboardTextPayload, Event};

/// [MS-RDPECLIP] 2.2.5.1.1 — UTF-16LE text, the format every Windows app offers for plain text.
fn cf_unicodetext() -> ClipboardFormatId {
    ClipboardFormatId::new(13)
}

pub struct TextClipboardBackend {
    session_id: String,
    output: Arc<Output>,
    /// Messages the backend wants sent on the CLIPRDR channel. The session thread owns the socket,
    /// so they are queued here rather than written directly.
    outbound: Sender<ClipboardMessage>,
    /// The local clipboard text most recently handed to us, kept so a server-side paste request can
    /// be answered immediately — the protocol expects data on demand, not on announcement.
    local_text: Option<String>,
}

impl TextClipboardBackend {
    pub fn new(session_id: String, output: Arc<Output>, outbound: Sender<ClipboardMessage>) -> Self {
        Self {
            session_id,
            output,
            outbound,
            local_text: None,
        }
    }
}

/// Shared handle used to push local clipboard changes into the backend.
pub struct ClipboardHandle {
    pub outbound: Sender<ClipboardMessage>,
}

impl ClipboardHandle {
    /// Announces that local text is available. The remote fetches it only when the user pastes.
    pub fn announce_text(&self) {
        let _ = self
            .outbound
            .send(ClipboardMessage::SendInitiateCopy(vec![ClipboardFormat::new(
                cf_unicodetext(),
            )]));
    }
}

// Output 은 stdout 뮤텍스를 들고 있어 Debug 를 파생시키기 곤란하다. 트레이트가 요구하는
// 최소한만 손으로 채운다.
impl core::fmt::Debug for TextClipboardBackend {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("TextClipboardBackend")
            .field("session_id", &self.session_id)
            .field("has_local_text", &self.local_text.is_some())
            .finish()
    }
}

impl_as_any!(TextClipboardBackend);

impl CliprdrBackend for TextClipboardBackend {
    fn temporary_directory(&self) -> &str {
        // File transfer is not implemented, so nothing is ever written here.
        ".cliprdr"
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        // No long-format-name or file-transfer flags: we only speak short-name text.
        ClipboardGeneralCapabilityFlags::empty()
    }

    fn on_ready(&mut self) {
        debug!(session_id = %self.session_id, "clipboard channel ready");
    }

    fn on_process_negotiated_capabilities(
        &mut self,
        _capabilities: ClipboardGeneralCapabilityFlags,
    ) {
    }

    fn on_request_format_list(&mut self) {
        // 여기서 반드시 무언가를 내보내야 한다.
        //
        // [MS-RDPECLIP] 3.2.5.1: 서버는 Monitor Ready 를 보낸 뒤 클라이언트의 Capabilities +
        // Temporary Directory + Format List 묶음을 기다린다. IronRDP 는 그 묶음을
        // initiate_copy() 에서 만들고, initiate_copy() 는 이 콜백의 응답으로만 촉발된다.
        //
        // 가진 텍스트가 없다고 아무것도 보내지 않으면 초기화가 끝나지 않는다. 그러면 서버는
        // 우리를 준비되지 않은 클라이언트로 보고 원격 복사 알림(Format List)을 아예 보내지
        // 않는다 — 양방향이 조용히 죽는다. 비어 있으면 빈 목록을 보낸다.
        let formats = if self.local_text.is_some() {
            vec![ClipboardFormat::new(cf_unicodetext())]
        } else {
            Vec::new()
        };
        let _ = self.outbound.send(ClipboardMessage::SendInitiateCopy(formats));
    }

    fn on_remote_copy(&mut self, available_formats: &[ClipboardFormat]) {
        debug!(
            session_id = %self.session_id,
            formats = ?available_formats.iter().map(|f| f.id().value()).collect::<Vec<_>>(),
            "remote copied"
        );
        // The remote copied something. Pull it only if plain text is on offer — anything else we
        // could not put on the local clipboard anyway.
        if available_formats
            .iter()
            .any(|format| format.id() == cf_unicodetext())
        {
            let _ = self
                .outbound
                .send(ClipboardMessage::SendInitiatePaste(cf_unicodetext()));
        }
    }

    fn on_format_data_request(&mut self, _request: FormatDataRequest) {
        debug!(
            session_id = %self.session_id,
            has_text = self.local_text.is_some(),
            "remote requested our clipboard"
        );
        // The remote is pasting and wants our data now.
        let response = match self.local_text.as_deref() {
            Some(text) => OwnedFormatDataResponse::new_data(encode_utf16_nul(text)),
            None => OwnedFormatDataResponse::new_error(),
        };
        let _ = self.outbound.send(ClipboardMessage::SendFormatData(response));
    }

    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        debug!(
            session_id = %self.session_id,
            is_error = response.is_error(),
            len = response.data().len(),
            "format data response"
        );
        if response.is_error() {
            return;
        }
        let Some(text) = decode_utf16_nul(response.data()) else {
            return;
        };

        let _ = self.output.send_event(
            &Event::new("clipboardText", ClipboardTextPayload { text })
                .session(&self.session_id),
        );
    }

    fn on_file_contents_request(&mut self, _request: FileContentsRequest) {}

    fn on_file_contents_response(&mut self, _response: FileContentsResponse<'_>) {}

    fn on_lock(&mut self, _data_id: LockDataId) {}

    fn on_unlock(&mut self, _data_id: LockDataId) {}
}

impl TextClipboardBackend {
    /// Records the local clipboard text so a later paste on the remote can be answered.
    pub fn set_local_text(&mut self, text: String) {
        self.local_text = Some(text);
    }
}

/// Windows expects UTF-16LE terminated by a NUL. Omitting the terminator makes some applications
/// paste trailing garbage.
fn encode_utf16_nul(text: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(text.len() * 2 + 2);
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes.extend_from_slice(&[0, 0]);
    bytes
}

fn decode_utf16_nul(data: &[u8]) -> Option<String> {
    if data.len() % 2 != 0 {
        return None;
    }

    let units: Vec<u16> = data
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .take_while(|unit| *unit != 0)
        .collect();

    String::from_utf16(&units).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_text_through_the_windows_encoding() {
        let encoded = encode_utf16_nul("hello 안녕");
        assert_eq!(decode_utf16_nul(&encoded).as_deref(), Some("hello 안녕"));
    }

    #[test]
    fn terminates_the_encoded_text_with_nul() {
        let encoded = encode_utf16_nul("ab");
        // 'a', 'b', NUL — 종단자가 없으면 붙여넣을 때 뒤에 쓰레기가 딸려간다.
        assert_eq!(encoded, vec![b'a', 0, b'b', 0, 0, 0]);
    }

    #[test]
    fn stops_decoding_at_the_terminator() {
        let mut data = encode_utf16_nul("keep");
        data.extend_from_slice(&[b'x', 0]);
        assert_eq!(decode_utf16_nul(&data).as_deref(), Some("keep"));
    }

    #[test]
    fn rejects_an_odd_length_payload_instead_of_guessing() {
        assert_eq!(decode_utf16_nul(&[b'a', 0, b'b']), None);
    }

    #[test]
    fn decodes_an_empty_payload_as_empty_text() {
        assert_eq!(decode_utf16_nul(&[]).as_deref(), Some(""));
    }
}
