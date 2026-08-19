//! AUDIO_PLAYBACK_DVC — 동적 채널로 오는 서버→클라이언트 소리, [MS-RDPEA].
//!
//! **PDU 는 정적 채널(rdpsnd)과 똑같다.** 다른 것은 실려 오는 통로뿐이다. 그래서 프로토콜을 다시
//! 구현하지 않고 크레이트의 rdpsnd 클라이언트(`ironrdp_rdpsnd::client::Rdpsnd`)를 그대로 돌리고,
//! 그것이 돌려준 메시지의 **프레이밍만** DVC 로 바꿔 보낸다(`SvcMessage::encode_unframed_pdu`).
//! 두 경로가 갈리면 한쪽만 고쳐지는 일이 반드시 생긴다.
//!
//! **왜 이 채널을 받아야 하는가.** 예전에는 거절했다 — 받아 주면 서버가 소리를 그리로 돌리고는
//! 아무것도 보내지 않는 것으로 보였기 때문이다. 그 관찰은 반쪽이었다: 채널만 열고 이쪽의 형식
//! 목록(Client Audio Formats)을 보내지 않으면 서버는 당연히 기다린다.
//!
//! 그리고 거절의 대가가 컸다. 최신 윈도우는 재생·녹음을 **한 오디오 엔드포인트**로 다루므로, 이
//! 채널 개설이 계속 실패하면 그 엔드포인트가 올라오지 않는다 — 실측(EC2 Windows): 서버가 이 채널을
//! 네 번 재시도하고 우리가 매번 거절하는 동안 rdpsnd 로는 소리가 한 조각도 오지 않았고, 원격의
//! 녹음기는 "녹음 장치가 없다" 고 했다(AUDIO_INPUT 도 열리지 않았다).

use ironrdp_core::{impl_as_any, Encode, EncodeResult, WriteCursor};
use ironrdp_dvc::{DvcChannelListener, DvcClientProcessor, DvcEncode, DvcMessage, DvcProcessor};
use ironrdp_pdu::PduResult;
use ironrdp_rdpsnd::client::{Rdpsnd, RdpsndClientHandler};
use ironrdp_svc::SvcProcessor;
use tracing::debug;

pub const CHANNEL_NAME: &str = "AUDIO_PLAYBACK_DVC";

/// 이미 인코딩된 PDU 바이트를 DVC 메시지로 실어 보내기 위한 껍데기.
///
/// rdpsnd 클라이언트는 SVC 용 메시지를 돌려주는데, 그 안의 PDU 바이트는 두 통로에서 동일하다.
#[derive(Debug)]
struct RawPdu(Vec<u8>);

impl Encode for RawPdu {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        dst.write_slice(&self.0);
        Ok(())
    }

    fn name(&self) -> &'static str {
        "RdpsndPdu"
    }

    fn size(&self) -> usize {
        self.0.len()
    }
}

impl DvcEncode for RawPdu {}

/// 동적 채널로 오는 소리를 rdpsnd 클라이언트에 그대로 물려 준다.
#[derive(Debug)]
pub struct AudioOutputDvc {
    rdpsnd: Rdpsnd,
}

impl_as_any!(AudioOutputDvc);

impl AudioOutputDvc {
    pub fn new(handler: Box<dyn RdpsndClientHandler>) -> Self {
        Self {
            rdpsnd: Rdpsnd::new(handler),
        }
    }
}

impl DvcProcessor for AudioOutputDvc {
    fn channel_name(&self) -> &str {
        CHANNEL_NAME
    }

    fn start(&mut self, _channel_id: u32) -> PduResult<Vec<DvcMessage>> {
        // 서버가 형식 목록을 먼저 보낸다. 우리가 먼저 말하면 안 된다.
        Ok(Vec::new())
    }

    fn process(&mut self, _channel_id: u32, payload: &[u8]) -> PduResult<Vec<DvcMessage>> {
        let replies = SvcProcessor::process(&mut self.rdpsnd, payload)?;
        debug!(replies = replies.len(), "audio playback dvc");
        replies
            .into_iter()
            .map(|message| {
                message
                    .encode_unframed_pdu()
                    .map(|bytes| Box::new(RawPdu(bytes)) as DvcMessage)
                    .map_err(|error| ironrdp_pdu::encode_err!(error))
            })
            .collect()
    }
}

impl DvcClientProcessor for AudioOutputDvc {}

/// 개설 요청마다 새 처리기를 만든다.
///
/// **서버는 이 채널을 닫고 다시 연다.** 실측(EC2 Windows): 열어 준 채널을 1.2초 뒤에 닫고 1초
/// 간격으로 두 번 더 열려고 했다. 크레이트의 `with_dynamic_channel` 은 처리기를 **한 번만**
/// 내주므로(`OnceListener::create` 가 `Option::take`) 두 번째 이후의 개설 요청은 우리 쪽에서
/// 전부 NO_LISTENER 로 거절됐다 — 서버가 다시 시도해도 우리가 막고 있었다.
pub struct AudioOutputDvcListener {
    make_handler: Box<dyn FnMut() -> Box<dyn RdpsndClientHandler> + Send>,
}

impl AudioOutputDvcListener {
    pub fn new(make_handler: impl FnMut() -> Box<dyn RdpsndClientHandler> + Send + 'static) -> Self {
        Self {
            make_handler: Box::new(make_handler),
        }
    }
}

impl DvcChannelListener for AudioOutputDvcListener {
    fn channel_name(&self) -> &str {
        CHANNEL_NAME
    }

    fn create(&mut self, _channel_id: u32) -> Option<Box<dyn DvcProcessor>> {
        Some(Box::new(AudioOutputDvc::new((self.make_handler)())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironrdp_core::encode_vec;
    use ironrdp_rdpsnd::pdu::{AudioFormat, AudioFormatFlags, PitchPdu, VolumePdu, WaveFormat};
    use std::borrow::Cow;

    /// 형식 목록만 돌려주는 최소 백엔드. 실제 재생은 여기서 재지 않는다.
    #[derive(Debug)]
    struct TestHandler {
        formats: Vec<AudioFormat>,
        waves: usize,
    }

    impl RdpsndClientHandler for TestHandler {
        fn get_flags(&self) -> AudioFormatFlags {
            AudioFormatFlags::empty()
        }
        fn get_formats(&self) -> &[AudioFormat] {
            &self.formats
        }
        fn wave(&mut self, _format_no: usize, _ts: u32, _data: Cow<'_, [u8]>) {
            self.waves += 1;
        }
        fn set_volume(&mut self, _volume: VolumePdu) {}
        fn set_pitch(&mut self, _pitch: PitchPdu) {}
        fn close(&mut self) {}
    }

    fn pcm(rate: u32, channels: u16) -> AudioFormat {
        AudioFormat {
            format: WaveFormat::PCM,
            n_channels: channels,
            n_samples_per_sec: rate,
            n_avg_bytes_per_sec: rate * u32::from(channels) * 2,
            n_block_align: channels * 2,
            bits_per_sample: 16,
            data: None,
        }
    }

    /// 서버의 형식 목록에 **형식 목록으로 답해야** 한다. 이걸 안 보내면 서버는 소리를 하나도
    /// 보내지 않는다 — 예전에 "채널만 열리고 payload 0건" 으로 보였던 것이 이것이다.
    #[test]
    fn answers_server_formats_with_our_formats() {
        let mut dvc = AudioOutputDvc::new(Box::new(TestHandler {
            formats: vec![pcm(44100, 2)],
            waves: 0,
        }));

        // Server Audio Formats PDU: msgType(0x07) + padding + bodySize + body.
        let format = pcm(44100, 2);
        let mut body = Vec::new();
        body.extend_from_slice(&0_u32.to_le_bytes()); // dwFlags
        body.extend_from_slice(&0_u32.to_le_bytes()); // dwVolume
        body.extend_from_slice(&0_u32.to_le_bytes()); // dwPitch
        body.extend_from_slice(&0_u16.to_le_bytes()); // wDGramPort
        body.extend_from_slice(&1_u16.to_le_bytes()); // wNumberOfFormats
        body.push(0); // cLastBlockConfirmed
        body.extend_from_slice(&8_u16.to_le_bytes()); // wVersion (V8)
        body.push(0); // bPad
        let mut format_bytes = vec![0_u8; format.size()];
        format
            .encode(&mut WriteCursor::new(&mut format_bytes))
            .expect("형식 인코딩");
        body.extend_from_slice(&format_bytes);

        let mut payload = vec![0x07_u8, 0];
        payload.extend_from_slice(&(body.len() as u16).to_le_bytes());
        payload.extend_from_slice(&body);

        let replies = dvc.process(1, &payload).expect("형식 처리");

        assert!(!replies.is_empty(), "형식 목록으로 답해야 한다");
        // 첫 응답은 Client Audio Formats(msgType 0x07)다. DVC 프레이밍만 다르고 PDU 는 같다.
        assert_eq!(encode_vec(replies[0].as_ref()).unwrap()[0], 0x07);
    }

    /// 리스너를 크레이트에 **붙인 채로** 열고·닫고·다시 열어 본다.
    ///
    /// 앞의 단위 테스트는 리스너 혼자만 본다. 실제로 거절을 만들던 자리는 크레이트의 채널 표라서
    /// (`with_dynamic_channel` 이 처리기를 한 번만 내준다) 그 경로까지 태워야 회귀를 잡는다.
    #[test]
    fn crate_reopens_the_channel_after_the_server_closes_it() {
        use ironrdp_dvc::pdu::{CapabilitiesRequestPdu, CapsVersion, ClosePdu, CreateRequestPdu, DrdynvcServerPdu};
        use ironrdp_dvc::DrdynvcClient;
        use ironrdp_svc::SvcProcessor;

        // 개설 응답의 마지막 4바이트가 상태다. 0 = 수락, 0xC0000001 = NO_LISTENER(거절).
        fn creation_status(client: &mut DrdynvcClient, channel_id: u32) -> u32 {
            let request = encode_vec(&DrdynvcServerPdu::Create(CreateRequestPdu::new(
                channel_id,
                CHANNEL_NAME.to_owned(),
            )))
            .expect("개설 요청 인코딩");
            let mut replies = client.process(&request).expect("개설 처리");
            let bytes = replies
                .pop()
                .expect("응답이 있어야 한다")
                .encode_unframed_pdu()
                .expect("응답 인코딩");
            let tail = &bytes[bytes.len() - 4..];
            u32::from_le_bytes([tail[0], tail[1], tail[2], tail[3]])
        }

        let mut client = DrdynvcClient::new().with_listener(AudioOutputDvcListener::new(|| {
            Box::new(TestHandler {
                formats: vec![pcm(44100, 2)],
                waves: 0,
            })
        }));
        client
            .process(&encode_vec(&DrdynvcServerPdu::Capabilities(CapabilitiesRequestPdu::new(CapsVersion::V1, None))).unwrap())
            .expect("caps");

        assert_eq!(creation_status(&mut client, 10), 0, "첫 개설은 수락한다");

        // 서버가 닫는다. 실측에서는 열어 준 지 1.2초 뒤였다.
        client
            .process(&encode_vec(&DrdynvcServerPdu::Close(ClosePdu::new(10))).unwrap())
            .expect("close");

        // 그리고 다시 연다. 예전에는 여기서 0xC0000001 이 나갔고, 서버는 소리를 포기했다.
        assert_eq!(creation_status(&mut client, 11), 0, "닫힌 뒤 재개설도 수락해야 한다");
    }

    /// **닫힌 뒤 다시 열어 줘야 한다.** 서버가 이 채널을 닫고 재시도하는 것을 실측했고,
    /// 처리기를 한 번만 내주던 시절에는 그 재시도가 전부 NO_LISTENER 로 거절됐다.
    #[test]
    fn listener_creates_a_processor_for_every_request() {
        let mut listener = AudioOutputDvcListener::new(|| {
            Box::new(TestHandler {
                formats: vec![pcm(44100, 2)],
                waves: 0,
            })
        });

        assert!(listener.create(10).is_some(), "첫 개설");
        assert!(listener.create(11).is_some(), "닫힌 뒤 재개설");
        assert!(listener.create(12).is_some());
        assert_eq!(listener.channel_name(), CHANNEL_NAME);
    }

    #[test]
    fn channel_name_matches_what_windows_opens() {
        let dvc = AudioOutputDvc::new(Box::new(TestHandler {
            formats: Vec::new(),
            waves: 0,
        }));
        // 로그에서 서버가 이 이름으로 열려고 한다. 한 글자만 달라도 계속 거절된다.
        assert_eq!(dvc.channel_name(), "AUDIO_PLAYBACK_DVC");
    }
}
