//! RDPSND backend — server-to-client audio.
//!
//! We advertise only uncompressed PCM. The server will then send raw samples, which the renderer
//! can hand straight to the Web Audio API. Advertising a compressed format instead would save
//! bandwidth but require a decoder in this process for whatever the server picks, and RDP's audio
//! codecs (ADPCM, GSM 6.10, and on newer hosts AAC or Opus) are a wide net to cover.
//!
//! Playback itself lives in the renderer. This is the protocol half only.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use ironrdp_rdpsnd::client::RdpsndClientHandler;
use ironrdp_rdpsnd::pdu::{AudioFormat, AudioFormatFlags, PitchPdu, VolumePdu, WaveFormat};
use tracing::{debug, info};

/// 소리가 한 조각이라도 왔는지를 펌프와 나눠 갖는다.
pub type AudioHeard = Arc<AtomicBool>;

/// 백엔드를 **매번 새로** 만드는 공장.
///
/// 동적 채널(AUDIO_PLAYBACK_DVC)은 서버가 닫고 다시 열 수 있어서 하나로는 부족하다
/// (audio_output_dvc.rs 의 `AudioOutputDvcListener` 주석 참고).
pub type AudioBackendFactory = Box<dyn FnMut() -> AudioBackend + Send>;

use crate::output::Output;
use crate::protocol::AudioFramePayload;

/// 광고하는 유일한 PCM 형식: 44.1kHz 16-bit 스테레오.
///
/// 하나만 내미는 데는 이유가 있다. ironrdp 의 client_formats() 는 서버 목록과 우리 목록의
/// 교집합을 HashSet::intersection 으로 만들고(client.rs:96-108), 그 결과의 **순서가
/// 비결정적**이다. wave() 가 주는 format_no 는 그렇게 만들어진 목록의 인덱스이므로, 둘 이상을
/// 광고하는 순간 어떤 형식으로 온 소리인지 확실히 알 수 없게 된다 — 잘못 짚으면 음정이 바뀐
/// 소리가 난다.
///
/// 44.1kHz 를 고른 것은 Windows RDPSND 가 기본으로 내미는 튜플이기 때문이다. 비교가 7개 필드
/// 전부의 정확 일치라, 파생값인 n_avg_bytes_per_sec 와 n_block_align 도 규격대로 맞아야 한다.
const SAMPLE_RATE: u32 = 44_100;
const CHANNELS: u16 = 2;
const BITS_PER_SAMPLE: u16 = 16;

pub struct AudioBackend {
    /// 첫 소리를 받았는지. 소리가 안 난다는 신고가 들어왔을 때 서버가 보내기는 하는지부터
    /// 갈라야 해서, 이 한 줄만은 기본 로그 수준으로 남긴다.
    logged_first_wave: bool,
    /// 소리가 한 조각이라도 왔는지. 펌프가 이걸 보고 "안 온다"는 것도 남긴다 — 아무 줄도
    /// 없으면 원인을 가릴 수 없다.
    heard: AudioHeard,
    session_id: String,
    output: Arc<Output>,
    formats: Vec<AudioFormat>,
}

impl AudioBackend {
    pub fn new(session_id: String, output: Arc<Output>, heard: AudioHeard) -> Self {
        let block_align = CHANNELS * BITS_PER_SAMPLE / 8;
        Self {
            session_id,
            output,
            logged_first_wave: false,
            heard,
            formats: vec![AudioFormat {
                format: WaveFormat::PCM,
                n_channels: CHANNELS,
                n_samples_per_sec: SAMPLE_RATE,
                // 파생값이지만 교집합 비교에 포함되므로 정확해야 한다.
                n_avg_bytes_per_sec: SAMPLE_RATE * u32::from(block_align),
                n_block_align: block_align,
                bits_per_sample: BITS_PER_SAMPLE,
                data: None,
            }],
        }
    }
}

impl core::fmt::Debug for AudioBackend {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("AudioBackend")
            .field("session_id", &self.session_id)
            .finish()
    }
}

impl RdpsndClientHandler for AudioBackend {
    fn get_flags(&self) -> AudioFormatFlags {
        // 재생만 한다. 마이크(입력)는 AUDIO_INPUT 채널이라 여기 해당하지 않는다.
        AudioFormatFlags::ALIVE
    }

    fn get_formats(&self) -> &[AudioFormat] {
        &self.formats
    }

    fn wave(&mut self, format_no: usize, ts: u32, data: std::borrow::Cow<'_, [u8]>) {
        self.heard.store(true, Ordering::Relaxed);

        if !self.logged_first_wave {
            self.logged_first_wave = true;
            // 진폭까지 남긴다. 조각은 오는데 안 들린다면, 서버가 무음을 보내는 것인지(원격
            // 오디오가 다른 장치로 나가는 경우) 우리가 재생을 못 하는 것인지부터 갈라야 한다.
            let peak = data
                .chunks_exact(2)
                .map(|pair| i16::from_le_bytes([pair[0], pair[1]]).unsigned_abs())
                .max()
                .unwrap_or(0);
            let nonzero = data.iter().filter(|byte| **byte != 0).count();
            info!(
                session_id = %self.session_id,
                format_no,
                bytes = data.len(),
                peak,
                nonzero,
                head = ?&data[..data.len().min(24)],
                "first audio from the server"
            );
        }
        // 형식을 하나만 광고했으므로 유효한 인덱스는 0 뿐이다. 다른 값이 오면 우리가 모르는
        // 형식이라, 재생하면 잡음이 된다.
        if format_no != 0 {
            debug!(
                session_id = %self.session_id,
                format_no,
                "dropping audio in a format we did not advertise"
            );
            return;
        }

        let _ = self.output.send_audio(
            &AudioFramePayload {
                kind: "rdpAudio",
                session_id: self.session_id.clone(),
                sample_rate: SAMPLE_RATE,
                channels: CHANNELS,
                bits_per_sample: BITS_PER_SAMPLE,
                timestamp: ts,
            },
            &data,
        );
    }

    fn set_volume(&mut self, volume: VolumePdu) {
        debug!(session_id = %self.session_id, ?volume, "server set volume");
    }

    fn set_pitch(&mut self, pitch: PitchPdu) {
        debug!(session_id = %self.session_id, ?pitch, "server set pitch");
    }

    fn close(&mut self) {
        debug!(session_id = %self.session_id, "audio channel closed");
    }
}
