//! AUDIO_INPUT — client-to-server audio (microphone), [MS-RDPEAI].
//!
//! **IronRDP 에 이 채널 크레이트가 없다.** rdpsnd(출력)는 크레이트가 있지만 입력은 없어서
//! 동적 채널(DVC) 위에 직접 구현한다. 메시지 종류가 일곱 개뿐이고 본문도 단순해서 채널 하나를
//! 통째로 벤더링하는 것보다 이쪽이 짧다.
//!
//! 협상 순서([MS-RDPEAI] 1.3.3.1):
//!
//!   서버 → VERSION           우리 → VERSION
//!   서버 → FORMATS(목록)     우리 → FORMATS(우리가 받아들일 부분집합)
//!   서버 → OPEN(형식 index)  우리 → OPEN_REPLY(성공)
//!   우리 → DATA_INCOMING, DATA(PCM)  … 계속
//!
//! **PCM 만 광고한다.** rdpsnd 쪽과 같은 이유다 — 압축 형식을 받아들이면 이 프로세스 안에
//! 인코더가 필요하고, 서버가 고를 수 있는 것(ADPCM·GSM·AAC·Opus)이 너무 넓다. 마이크는
//! 대역폭도 화면에 비해 무시할 만하다(16-bit 44.1kHz 모노 = 86KB/s).
//!
//! 캡처 자체는 렌더러가 한다(getUserMedia). 이 파일은 프로토콜 절반이고, 협상된 형식을
//! 이벤트로 올려 렌더러가 그 사양대로 잡게 한다 — 리샘플링은 오디오 그래프가 이미 하는 일이다.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;

use ironrdp_core::{impl_as_any, Encode, EncodeResult, WriteCursor};
use ironrdp_dvc::{DvcChannelListener, DvcClientProcessor, DvcEncode, DvcMessage, DvcProcessor};
use ironrdp_pdu::{PduResult, decode_err};
use tracing::{debug, info, warn};

pub const CHANNEL_NAME: &str = "AUDIO_INPUT";

/// 우리가 말하는 버전.
///
/// **2 여야 한다.** 윈도우 11 의 audin 서버는 `server_version=2` 를 말하고, FreeRDP 도 2 로
/// 답한다(`SNDIN_VERSION 0x02`). 1 로 답하면 협상이 형식 목록까지만 가고 서버가 OPEN 을 보내지
/// 않는다 — 실측(패러럴즈 Windows 11 Pro): `audin formats negotiated` 다음에 아무것도 오지 않았고,
/// 같은 서버에서 Windows App 은 정상 동작했다.
const VERSION: u32 = 2;

mod message_id {
    pub const VERSION: u8 = 0x01;
    pub const FORMATS: u8 = 0x02;
    pub const OPEN: u8 = 0x03;
    pub const OPEN_REPLY: u8 = 0x04;
    pub const DATA_INCOMING: u8 = 0x05;
    pub const DATA: u8 = 0x06;
    pub const FORMAT_CHANGE: u8 = 0x07;
}

/// WAVE_FORMAT_PCM. 우리가 받아들이는 유일한 태그다.
const WAVE_FORMAT_PCM: u16 = 0x0001;

/// 협상된 캡처 사양. 렌더러가 이 사양대로 마이크를 잡는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptureFormat {
    pub sample_rate: u32,
    pub channels: u16,
    pub bits_per_sample: u16,
    /// 서버가 한 번에 받고 싶어 하는 프레임 수. 이 크기로 잘라 보내면 서버가 가장 매끄럽게 재생한다.
    pub frames_per_packet: u32,
}

/// 서버가 보낸 형식 하나(WAVEFORMATEX).
#[derive(Debug, Clone, PartialEq, Eq)]
struct AudioFormat {
    format_tag: u16,
    channels: u16,
    samples_per_sec: u32,
    avg_bytes_per_sec: u32,
    block_align: u16,
    bits_per_sample: u16,
    extra: Vec<u8>,
}

impl AudioFormat {
    fn is_plain_pcm(&self) -> bool {
        // 16-bit PCM 만 받는다. 8-bit PCM 은 unsigned 라 렌더러가 부호를 뒤집어야 하고,
        // 그 형식만 주는 서버는 실무에서 못 봤다 — 만나면 그때 붙인다.
        self.format_tag == WAVE_FORMAT_PCM && self.bits_per_sample == 16 && self.channels > 0
    }

    fn encoded_len(&self) -> usize {
        18 + self.extra.len()
    }

    fn encode_into(&self, dst: &mut WriteCursor<'_>) {
        dst.write_u16(self.format_tag);
        dst.write_u16(self.channels);
        dst.write_u32(self.samples_per_sec);
        dst.write_u32(self.avg_bytes_per_sec);
        dst.write_u16(self.block_align);
        dst.write_u16(self.bits_per_sample);
        dst.write_u16(u16::try_from(self.extra.len()).unwrap_or(0));
        dst.write_slice(&self.extra);
    }
}

/// 바이트를 형식 목록으로. 잘린 항목은 버린다(서버가 개수를 부풀려 보내도 우리가 죽지 않는다).
fn parse_formats(mut data: &[u8], count: u32) -> Vec<AudioFormat> {
    let mut formats = Vec::new();
    for _ in 0..count {
        if data.len() < 18 {
            break;
        }
        let extra_len = u16::from_le_bytes([data[16], data[17]]) as usize;
        if data.len() < 18 + extra_len {
            break;
        }
        formats.push(AudioFormat {
            format_tag: u16::from_le_bytes([data[0], data[1]]),
            channels: u16::from_le_bytes([data[2], data[3]]),
            samples_per_sec: u32::from_le_bytes([data[4], data[5], data[6], data[7]]),
            avg_bytes_per_sec: u32::from_le_bytes([data[8], data[9], data[10], data[11]]),
            block_align: u16::from_le_bytes([data[12], data[13]]),
            bits_per_sample: u16::from_le_bytes([data[14], data[15]]),
            extra: data[18..18 + extra_len].to_vec(),
        });
        data = &data[18 + extra_len..];
    }
    formats
}

/// 클라이언트가 보내는 메시지들. 하나의 열거형으로 두어 `DvcEncode` 를 한 번만 구현한다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outgoing {
    Version(u32),
    /// 우리가 받아들이는 형식 목록(서버 목록의 부분집합).
    Formats(Vec<AudioFormatWire>),
    OpenReply { result: u32 },
    /// 서버가 고른 형식 index 를 되돌려 확인해 준다. OPEN_REPLY 보다 **먼저** 나간다.
    FormatChange(u32),
    DataIncoming,
    Data(Vec<u8>),
}

/// 되돌려 보낼 형식. 서버가 준 것을 그대로 싣는다 — 우리가 값을 바꾸면 서버가 목록에서 못 찾는다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioFormatWire(Vec<u8>);

impl Encode for Outgoing {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        match self {
            Self::Version(version) => {
                dst.write_u8(message_id::VERSION);
                dst.write_u32(*version);
            }
            Self::Formats(formats) => {
                dst.write_u8(message_id::FORMATS);
                dst.write_u32(u32::try_from(formats.len()).unwrap_or(0));
                // cbSizeFormatsPacket 은 **헤더까지 포함한 패킷 전체 크기**다. FreeRDP 가
                // 목록을 다 쓴 뒤의 스트림 위치(=9+목록)를 넣는다. 목록 크기만 넣으면 9 만큼
                // 작다.
                let body: usize = formats.iter().map(|format| format.0.len()).sum();
                dst.write_u32(u32::try_from(1 + 4 + 4 + body).unwrap_or(0));
                for format in formats {
                    dst.write_slice(&format.0);
                }
            }
            Self::OpenReply { result } => {
                dst.write_u8(message_id::OPEN_REPLY);
                dst.write_u32(*result);
            }
            Self::FormatChange(index) => {
                dst.write_u8(message_id::FORMAT_CHANGE);
                dst.write_u32(*index);
            }
            Self::DataIncoming => {
                dst.write_u8(message_id::DATA_INCOMING);
            }
            Self::Data(samples) => {
                dst.write_u8(message_id::DATA);
                dst.write_slice(samples);
            }
        }
        Ok(())
    }

    fn name(&self) -> &'static str {
        "AudinPdu"
    }

    fn size(&self) -> usize {
        match self {
            Self::Version(_) => 1 + 4,
            Self::Formats(formats) => {
                1 + 4 + 4 + formats.iter().map(|format| format.0.len()).sum::<usize>()
            }
            Self::OpenReply { .. } => 1 + 4,
            Self::FormatChange(_) => 1 + 4,
            Self::DataIncoming => 1,
            Self::Data(samples) => 1 + samples.len(),
        }
    }
}

impl DvcEncode for Outgoing {}

/// AUDIO_INPUT 클라이언트.
///
/// 협상만 한다 — 실제 PCM 은 펌프가 `encode_data` 로 실어 보낸다. 채널 처리기 안에서 보내려면
/// 캡처 스레드가 이 객체를 잠가야 하는데, 그러면 서버 메시지 처리가 캡처에 막힌다.
/// 채널의 현재 상태를 펌프와 나눠 갖는다.
///
/// **왜 처리기 안에만 두지 않는가.** 두 가지가 겹친다:
///
///   - 서버는 이 채널을 **닫고 다시 열 수 있다.** 크레이트의 `with_dynamic_channel` 은 처리기를
///     한 번만 내주므로(`OnceListener::create` 가 `Option::take`) 두 번째 개설 요청부터는 우리가
///     NO_LISTENER 로 거절한다. 그래서 매번 새 처리기를 만드는 리스너로 붙인다.
///   - 리스너로 붙인 채널은 크레이트의 TypeId 조회(`get_dvc::<T>()`)에 걸리지 않는다. 펌프가
///     채널 번호와 열림 여부를 알 길이 없어진다.
///
/// 그래서 두 값만 처리기 밖으로 빼내 공유한다. 처리기가 새로 만들어져도 이 핸들은 그대로다.
#[derive(Debug, Default)]
pub struct AudinChannel {
    /// 서버가 준 채널 번호. 0 은 "아직 안 열렸다" 다 — DVC 채널 번호는 1부터다.
    channel_id: AtomicU32,
    /// 서버가 OPEN 까지 보냈는지. 이 전에 PCM 을 보내면 서버가 버린다.
    opened: AtomicBool,
}

impl AudinChannel {
    /// 서버가 이 채널을 열었는지. 마이크를 요청했는데 이것이 계속 false 면 사용자에게 알린다.
    pub fn created(&self) -> bool {
        self.channel_id.load(Ordering::Relaxed) != 0
    }

    /// 마이크 소리를 실어 보낼 수 있는 상태면 채널 번호.
    pub fn ready(&self) -> Option<u32> {
        let id = self.channel_id.load(Ordering::Relaxed);
        (id != 0 && self.opened.load(Ordering::Relaxed)).then_some(id)
    }
}

/// 개설 요청마다 새 처리기를 만든다. 위 `AudinChannel` 주석의 첫 번째 이유가 이 타입의 존재 이유다.
pub struct AudinListener {
    format_tx: Sender<CaptureFormat>,
    channel: Arc<AudinChannel>,
}

impl AudinListener {
    pub fn new(format_tx: Sender<CaptureFormat>, channel: Arc<AudinChannel>) -> Self {
        Self { format_tx, channel }
    }
}

impl DvcChannelListener for AudinListener {
    fn channel_name(&self) -> &str {
        CHANNEL_NAME
    }

    fn create(&mut self, _channel_id: u32) -> Option<Box<dyn DvcProcessor>> {
        Some(Box::new(AudinClient::new(
            self.format_tx.clone(),
            Arc::clone(&self.channel),
        )))
    }
}

pub struct AudinClient {
    /// 협상이 끝나면 캡처 사양을 한 번 알린다.
    format_tx: Sender<CaptureFormat>,
    /// 서버가 준 형식 목록 중 우리가 받아들인 것들(원본 바이트와 해석을 함께 들고 있는다).
    accepted: Vec<(AudioFormatWire, AudioFormat)>,
    /// 펌프와 나눠 갖는 채널 상태. 처리기가 새로 만들어져도 이 핸들은 그대로다.
    channel: Arc<AudinChannel>,
}

impl_as_any!(AudinClient);

impl AudinClient {
    pub fn new(format_tx: Sender<CaptureFormat>, channel: Arc<AudinChannel>) -> Self {
        Self {
            format_tx,
            accepted: Vec::new(),
            channel,
        }
    }

    /// PCM 한 덩어리를 보낼 메시지로. DATA_INCOMING 을 먼저 보내는 것이 규격이다
    /// ([MS-RDPEAI] 2.2.3.1) — 그것 없이 DATA 만 보내면 서버가 무시한다.
    pub fn encode_data(samples: Vec<u8>) -> Vec<DvcMessage> {
        vec![
            Box::new(Outgoing::DataIncoming) as DvcMessage,
            Box::new(Outgoing::Data(samples)) as DvcMessage,
        ]
    }

}

impl DvcProcessor for AudinClient {
    fn channel_name(&self) -> &str {
        CHANNEL_NAME
    }

    fn start(&mut self, channel_id: u32) -> PduResult<Vec<DvcMessage>> {
        self.channel.channel_id.store(channel_id, Ordering::Relaxed);
        // **개설 자체를 info 로 남긴다.** 10초 경고는 일회성이라, 원격에서 뒤늦게 녹음을 시작해
        // 채널이 열린 경우와 서버가 끝까지 안 연 경우가 로그에서 구분되지 않았다.
        info!(channel_id, "audin: the server opened the AUDIO_INPUT channel");
        // 서버가 먼저 VERSION 을 보낸다. 우리가 먼저 말하면 안 된다.
        Ok(Vec::new())
    }

    fn close(&mut self, channel_id: u32) {
        // 닫힌 것이 **지금 열려 있는 채널일 때만** 지운다. 서버가 닫고 곧바로 다시 열면 새
        // 처리기의 start() 가 먼저 도는 순서도 가능해서, 그때 새 번호를 지워 버리면 안 된다.
        if self
            .channel
            .channel_id
            .compare_exchange(channel_id, 0, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
        {
            self.channel.opened.store(false, Ordering::Relaxed);
        }
    }

    fn process(&mut self, _channel_id: u32, payload: &[u8]) -> PduResult<Vec<DvcMessage>> {
        let Some((&message_id, body)) = payload.split_first() else {
            return Err(bad("payload", "empty"));
        };

        match message_id {
            message_id::VERSION => {
                let version = read_u32(body, "version")?;
                debug!(server_version = version, "audin version");
                if version > VERSION {
                    // 우리가 모르는 버전이다. 아는 척 답하면 그 버전의 규칙으로 대화가 이어진다.
                    // FreeRDP 도 이 경우 답하지 않는다(audin_process_version).
                    warn!(
                        server_version = version,
                        ours = VERSION,
                        "audin: unsupported channel version; not answering"
                    );
                    return Ok(Vec::new());
                }
                Ok(vec![Box::new(Outgoing::Version(VERSION)) as DvcMessage])
            }
            message_id::FORMATS => {
                if body.len() < 8 {
                    return Err(bad("formats", "truncated header"));
                }
                let count = u32::from_le_bytes([body[0], body[1], body[2], body[3]]);
                let formats = parse_formats(&body[8..], count);
                self.accepted = formats
                    .into_iter()
                    .filter(AudioFormat::is_plain_pcm)
                    .map(|format| {
                        let mut bytes = vec![0_u8; format.encoded_len()];
                        let mut cursor = WriteCursor::new(&mut bytes);
                        format.encode_into(&mut cursor);
                        (AudioFormatWire(bytes), format)
                    })
                    .collect();
                if self.accepted.is_empty() {
                    // 서버가 PCM 을 하나도 주지 않았다. 빈 목록을 보내면 서버가 채널을 닫는다 —
                    // 그것이 우리가 할 수 있는 정직한 답이다(마이크는 그 세션에서 안 된다).
                    warn!("audin: server offered no PCM format; microphone will stay off");
                }
                info!(accepted = self.accepted.len(), "audin formats negotiated");
                // **DATA_INCOMING 을 목록보다 먼저 보낸다.** FreeRDP 가 그렇게 한다
                // (audin_process_formats 가 목록을 쓰기 직전에 audin_send_incoming_data_pdu 를
                // 부른다). 이것 없이 목록만 보내면 윈도우가 OPEN 을 보내지 않는다 — 실측.
                Ok(vec![
                    Box::new(Outgoing::DataIncoming) as DvcMessage,
                    Box::new(Outgoing::Formats(
                        self.accepted
                            .iter()
                            .map(|(wire, _)| wire.clone())
                            .collect(),
                    )) as DvcMessage,
                ])
            }
            message_id::OPEN => {
                if body.len() < 8 {
                    return Err(bad("open", "truncated"));
                }
                let frames_per_packet = u32::from_le_bytes([body[0], body[1], body[2], body[3]]);
                let index_wire = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
                let index = index_wire as usize;
                let Some((_, format)) = self.accepted.get(index) else {
                    return Err(bad("open", "format index"));
                };
                self.channel.opened.store(true, Ordering::Relaxed);
                let capture = CaptureFormat {
                    sample_rate: format.samples_per_sec,
                    channels: format.channels,
                    bits_per_sample: format.bits_per_sample,
                    frames_per_packet,
                };
                info!(?capture, "audin opened");
                // 받는 쪽이 사라졌으면(세션 종료 중) 무시한다.
                let _ = self.format_tx.send(capture);
                // **OPEN_REPLY 앞에 FORMATCHANGE 를 보낸다.** 서버가 고른 index 를 그대로
                // 되돌려 "이 형식으로 가겠다" 를 확인해 주는 것이고, FreeRDP 도 이 순서다
                // (audin_process_open: format change → open reply).
                Ok(vec![
                    Box::new(Outgoing::FormatChange(index_wire)) as DvcMessage,
                    Box::new(Outgoing::OpenReply { result: 0 }) as DvcMessage,
                ])
            }
            message_id::FORMAT_CHANGE => {
                let index = read_u32(body, "format change")? as usize;
                match self.accepted.get(index) {
                    Some((_, format)) => {
                        let capture = CaptureFormat {
                            sample_rate: format.samples_per_sec,
                            channels: format.channels,
                            bits_per_sample: format.bits_per_sample,
                            // 형식 변경 PDU 에는 패킷 크기가 없다. 서버가 OPEN 에서 준 값을
                            // 그대로 쓰라는 뜻이라 0 으로 알리고, 받는 쪽이 이전 값을 유지한다.
                            frames_per_packet: 0,
                        };
                        info!(?capture, "audin format change");
                        let _ = self.format_tx.send(capture);
                    }
                    None => warn!(index, "audin format change for an unknown format"),
                }
                Ok(Vec::new())
            }
            other => {
                debug!(message_id = other, "audin: ignoring server message");
                Ok(Vec::new())
            }
        }
    }
}

impl DvcClientProcessor for AudinClient {}

fn read_u32(body: &[u8], field: &'static str) -> PduResult<u32> {
    if body.len() < 4 {
        return Err(bad(field, "truncated"));
    }
    Ok(u32::from_le_bytes([body[0], body[1], body[2], body[3]]))
}

/// 서버 메시지가 규격에 맞지 않을 때의 오류.
///
/// `invalid_field_err!` 는 Encode/Decode 오류를 만들고 채널 처리기는 `PduResult` 를 돌려주므로
/// 한 번 감싼다. 이 자리를 헬퍼로 둔 이유는 여섯 군데에서 같은 감싸기를 반복하지 않으려는 것이다.
fn bad(field: &'static str, reason: &'static str) -> ironrdp_pdu::PduError {
    let error: ironrdp_core::DecodeError = ironrdp_core::invalid_field_err!("audin", field, reason);
    decode_err!(error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironrdp_core::encode_vec;
    use std::sync::mpsc;

    fn format_bytes(tag: u16, channels: u16, rate: u32, bits: u16) -> Vec<u8> {
        let block_align = channels * bits / 8;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&tag.to_le_bytes());
        bytes.extend_from_slice(&channels.to_le_bytes());
        bytes.extend_from_slice(&rate.to_le_bytes());
        bytes.extend_from_slice(&(rate * u32::from(block_align)).to_le_bytes());
        bytes.extend_from_slice(&block_align.to_le_bytes());
        bytes.extend_from_slice(&bits.to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes
    }

    fn server_formats(formats: &[Vec<u8>]) -> Vec<u8> {
        let mut payload = vec![message_id::FORMATS];
        payload.extend_from_slice(&(formats.len() as u32).to_le_bytes());
        let body: usize = formats.iter().map(Vec::len).sum();
        payload.extend_from_slice(&(body as u32).to_le_bytes());
        for format in formats {
            payload.extend_from_slice(format);
        }
        payload
    }

    /// **협상 전체를 크레이트의 채널 경로로 태운다.**
    ///
    /// 나머지 테스트는 처리기를 직접 부른다. 실제 서버는 DRDYNVC 개설·데이터 PDU 로 감싸서
    /// 보내고, 우리 응답도 그 프레이밍으로 되돌아간다 — 그 층에서 어긋나면 단위 테스트는 전부
    /// 통과하는데 실제로는 한 마디도 안 통한다. 그래서 리스너를 붙인 `DrdynvcClient` 에
    /// VERSION → FORMATS → OPEN 을 순서대로 먹이고, 마지막에 펌프가 보게 되는 공유 핸들이
    /// 실제로 "보낼 수 있음" 이 되는지까지 본다.
    #[test]
    fn negotiates_end_to_end_through_the_crate_channel() {
        use ironrdp_core::encode_vec as enc;
        use ironrdp_dvc::pdu::{
            CapabilitiesRequestPdu, CapsVersion, CreateRequestPdu, DataPdu, DrdynvcDataPdu, DrdynvcServerPdu,
        };
        use ironrdp_dvc::DrdynvcClient;
        use ironrdp_svc::SvcProcessor;

        const CHANNEL: u32 = 7;

        // 서버가 채널로 보내는 한 덩어리. 응답은 DVC 프레이밍이 붙은 채로 돌아온다.
        fn on_channel(client: &mut DrdynvcClient, payload: Vec<u8>) -> Vec<Vec<u8>> {
            let pdu = DrdynvcServerPdu::Data(DrdynvcDataPdu::Data(DataPdu::new(CHANNEL, payload)));
            client
                .process(&enc(&pdu).expect("데이터 PDU 인코딩"))
                .expect("채널 처리")
                .into_iter()
                .map(|message| message.encode_unframed_pdu().expect("응답 인코딩"))
                .collect()
        }

        let (tx, rx) = mpsc::channel();
        let channel = Arc::new(AudinChannel::default());
        let mut client =
            DrdynvcClient::new().with_listener(AudinListener::new(tx, Arc::clone(&channel)));

        client
            .process(&enc(&DrdynvcServerPdu::Capabilities(CapabilitiesRequestPdu::new(CapsVersion::V1, None))).unwrap())
            .expect("caps");
        client
            .process(&enc(&DrdynvcServerPdu::Create(CreateRequestPdu::new(CHANNEL, CHANNEL_NAME.to_owned()))).unwrap())
            .expect("create");
        assert!(channel.created(), "개설되면 채널 번호가 잡힌다");
        assert_eq!(channel.ready(), None, "OPEN 전에는 보내지 않는다");

        // VERSION: 우리 버전으로 답해야 한다.
        let mut version = vec![message_id::VERSION];
        version.extend_from_slice(&VERSION.to_le_bytes());
        let replies = on_channel(&mut client, version);
        assert!(
            replies.iter().any(|bytes| bytes.ends_with(&[message_id::VERSION, 2, 0, 0, 0])),
            "VERSION 응답이 DVC 프레이밍 안에 실려야 한다: {replies:?}"
        );

        // FORMATS: PCM 하나와 우리가 안 받는 형식(0x0011 = ADPCM) 하나를 섞어 준다.
        let pcm = format_bytes(WAVE_FORMAT_PCM, 1, 44100, 16);
        let adpcm = format_bytes(0x0011, 1, 44100, 4);
        let replies = on_channel(&mut client, server_formats(&[pcm.clone(), adpcm]));
        let formats_reply = replies
            .iter()
            .find(|bytes| bytes.ends_with(&pcm))
            .expect("형식 목록으로 답해야 한다");
        assert!(
            formats_reply.ends_with(&pcm),
            "받아들인 형식(PCM)만 원본 바이트로 돌려줘야 한다: {formats_reply:?}"
        );

        // OPEN: index 0 은 위에서 걸러낸 목록의 PCM 이다.
        let mut open = vec![message_id::OPEN];
        open.extend_from_slice(&480_u32.to_le_bytes());
        open.extend_from_slice(&0_u32.to_le_bytes());
        let replies = on_channel(&mut client, open);
        assert!(
            replies.iter().any(|bytes| bytes.ends_with(&[message_id::OPEN_REPLY, 0, 0, 0, 0])),
            "OPEN_REPLY(성공)로 답해야 한다: {replies:?}"
        );

        // 여기까지 오면 렌더러가 이 사양대로 마이크를 잡고, 펌프가 PCM 을 실어 보낸다.
        assert_eq!(
            rx.try_recv().expect("협상된 사양이 올라와야 한다"),
            CaptureFormat {
                sample_rate: 44100,
                channels: 1,
                bits_per_sample: 16,
                frames_per_packet: 480,
            }
        );
        assert_eq!(channel.ready(), Some(CHANNEL), "펌프가 보낼 수 있는 상태여야 한다");
    }

    /// 펌프는 이 공유 핸들만 보고 마이크를 보낼지 정한다. OPEN 전에 보내면 서버가 버린다.
    #[test]
    fn shared_handle_tracks_open_and_close() {
        let (tx, _rx) = mpsc::channel();
        let channel = Arc::new(AudinChannel::default());
        let mut client = AudinClient::new(tx, Arc::clone(&channel));

        assert!(!channel.created());
        assert_eq!(channel.ready(), None);

        client.start(10).expect("start");
        assert!(channel.created(), "개설되면 채널 번호가 보여야 한다");
        assert_eq!(channel.ready(), None, "OPEN 전에는 보내지 않는다");

        client
            .process(10, &server_formats(&[format_bytes(WAVE_FORMAT_PCM, 1, 44100, 16)]))
            .expect("formats");
        let mut open = vec![message_id::OPEN];
        open.extend_from_slice(&960_u32.to_le_bytes());
        open.extend_from_slice(&0_u32.to_le_bytes());
        client.process(10, &open).expect("open");
        assert_eq!(channel.ready(), Some(10));

        client.close(10);
        assert!(!channel.created(), "닫히면 다시 보내지 않는다");
        assert_eq!(channel.ready(), None);
    }

    /// **닫힌 뒤 다시 열어 줘야 한다.** 처리기를 한 번만 내주면 서버의 재시도를 우리가 거절한다.
    #[test]
    fn listener_creates_a_processor_for_every_request() {
        let (tx, _rx) = mpsc::channel();
        let channel = Arc::new(AudinChannel::default());
        let mut listener = AudinListener::new(tx, Arc::clone(&channel));

        assert!(listener.create(10).is_some(), "첫 개설");
        assert!(listener.create(11).is_some(), "닫힌 뒤 재개설");
        assert_eq!(listener.channel_name(), CHANNEL_NAME);
    }

    /// 지금 열려 있는 채널이 아닌 번호로 온 close 는 상태를 건드리지 않는다.
    #[test]
    fn close_of_a_stale_channel_is_ignored() {
        let (tx, _rx) = mpsc::channel();
        let channel = Arc::new(AudinChannel::default());
        let mut fresh = AudinClient::new(tx.clone(), Arc::clone(&channel));
        fresh.start(11).expect("start");

        // 먼저 열려 있던 처리기가 뒤늦게 닫힌다.
        let mut stale = AudinClient::new(tx, Arc::clone(&channel));
        stale.close(10);

        assert!(channel.created(), "새 채널이 살아 있어야 한다");
    }

    #[test]
    fn answers_version_with_our_own() {
        let (tx, _rx) = mpsc::channel();
        let mut client = AudinClient::new(tx, Arc::default());
        let mut payload = vec![message_id::VERSION];
        payload.extend_from_slice(&2_u32.to_le_bytes());

        let replies = client.process(1, &payload).expect("version");

        // **값 2 를 못박는다.** 상수만 참조하면 1 로 되돌아가도 테스트가 통과한다 — 그리고 1 로
        // 답하는 순간 윈도우가 OPEN 을 보내지 않는다(실측).
        assert_eq!(
            encode_vec(replies[0].as_ref()).unwrap(),
            vec![message_id::VERSION, 2, 0, 0, 0]
        );
    }

    /// 우리가 모르는 버전이면 답하지 않는다. 아는 척 답하면 그 버전 규칙으로 대화가 이어진다.
    #[test]
    fn does_not_answer_a_newer_channel_version() {
        let (tx, _rx) = mpsc::channel();
        let mut client = AudinClient::new(tx, Arc::default());
        let mut payload = vec![message_id::VERSION];
        payload.extend_from_slice(&3_u32.to_le_bytes());

        assert!(client.process(1, &payload).expect("version").is_empty());
    }

    /// 압축 형식은 걸러내고 PCM 만 되돌려 보낸다. 되돌릴 때 **서버가 준 바이트 그대로** 보내야
    /// 서버가 자기 목록에서 찾는다 — 값을 다시 만들어 보내면 index 가 어긋난다.
    #[test]
    fn accepts_only_pcm_and_echoes_it_verbatim() {
        let (tx, _rx) = mpsc::channel();
        let mut client = AudinClient::new(tx, Arc::default());
        let gsm = format_bytes(0x0031, 1, 8000, 0);
        let pcm = format_bytes(WAVE_FORMAT_PCM, 2, 44100, 16);

        let replies = client
            .process(1, &server_formats(&[gsm, pcm.clone()]))
            .expect("formats");

        // 순서가 규격이다: DATA_INCOMING 먼저, 그다음 형식 목록(FreeRDP 와 같다).
        assert_eq!(
            encode_vec(replies[0].as_ref()).unwrap(),
            vec![message_id::DATA_INCOMING],
            "형식 목록 앞에 DATA_INCOMING 이 나가야 한다"
        );
        let encoded = encode_vec(replies[1].as_ref()).unwrap();
        assert_eq!(encoded[0], message_id::FORMATS);
        assert_eq!(u32::from_le_bytes([encoded[1], encoded[2], encoded[3], encoded[4]]), 1);
        assert_eq!(
            u32::from_le_bytes([encoded[5], encoded[6], encoded[7], encoded[8]]) as usize,
            9 + pcm.len(),
            "cbSizeFormatsPacket 은 헤더까지 포함한 패킷 전체 크기다"
        );
        assert_eq!(&encoded[9..], &pcm[..], "PCM 형식을 원본 바이트로 되돌려야 한다");
    }

    #[test]
    fn open_reports_the_capture_format_and_replies_success() {
        let (tx, rx) = mpsc::channel();
        let channel = Arc::new(AudinChannel::default());
        let mut client = AudinClient::new(tx, Arc::clone(&channel));
        client.start(1).expect("start");
        client
            .process(1, &server_formats(&[format_bytes(WAVE_FORMAT_PCM, 1, 22050, 16)]))
            .expect("formats");

        let mut open = vec![message_id::OPEN];
        open.extend_from_slice(&441_u32.to_le_bytes());
        open.extend_from_slice(&0_u32.to_le_bytes());
        let replies = client.process(1, &open).expect("open");

        assert_eq!(
            rx.try_recv().expect("협상된 사양을 알려야 한다"),
            CaptureFormat {
                sample_rate: 22050,
                channels: 1,
                bits_per_sample: 16,
                frames_per_packet: 441,
            }
        );
        assert_eq!(channel.ready(), Some(1), "OPEN 까지 오면 보낼 수 있어야 한다");
        // 순서가 규격이다: 서버가 고른 index 를 FORMATCHANGE 로 확인해 주고, 그다음 OPEN_REPLY.
        let change = encode_vec(replies[0].as_ref()).unwrap();
        assert_eq!(change[0], message_id::FORMAT_CHANGE, "OPEN_REPLY 앞에 FORMATCHANGE");
        assert_eq!(u32::from_le_bytes([change[1], change[2], change[3], change[4]]), 0);
        let encoded = encode_vec(replies[1].as_ref()).unwrap();
        assert_eq!(encoded[0], message_id::OPEN_REPLY);
        assert_eq!(u32::from_le_bytes([encoded[1], encoded[2], encoded[3], encoded[4]]), 0);
    }

    /// 서버가 모르는 형식 index 로 열려고 하면 우리가 없는 형식을 쓰게 된다. 거절해야 한다.
    #[test]
    fn rejects_open_with_an_unknown_format_index() {
        let (tx, _rx) = mpsc::channel();
        let mut client = AudinClient::new(tx, Arc::default());
        client
            .process(1, &server_formats(&[format_bytes(WAVE_FORMAT_PCM, 1, 8000, 16)]))
            .expect("formats");

        let mut open = vec![message_id::OPEN];
        open.extend_from_slice(&100_u32.to_le_bytes());
        open.extend_from_slice(&7_u32.to_le_bytes());
        assert!(client.process(1, &open).is_err());
    }

    /// DATA 앞에는 DATA_INCOMING 이 와야 한다([MS-RDPEAI] 2.2.3.1). 빠뜨리면 서버가 버린다.
    #[test]
    fn data_is_preceded_by_data_incoming() {
        let messages = AudinClient::encode_data(vec![1, 2, 3, 4]);

        assert_eq!(messages.len(), 2);
        assert_eq!(encode_vec(messages[0].as_ref()).unwrap(), vec![message_id::DATA_INCOMING]);
        assert_eq!(
            encode_vec(messages[1].as_ref()).unwrap(),
            vec![message_id::DATA, 1, 2, 3, 4]
        );
    }

    #[test]
    fn truncated_server_messages_do_not_panic() {
        let (tx, _rx) = mpsc::channel();
        let mut client = AudinClient::new(tx, Arc::default());

        assert!(client.process(1, &[]).is_err());
        assert!(client.process(1, &[message_id::VERSION]).is_err());
        assert!(client.process(1, &[message_id::FORMATS, 1]).is_err());
        assert!(client.process(1, &[message_id::OPEN, 0, 0]).is_err());
        // 개수를 부풀린 목록은 읽을 수 있는 만큼만 받아들인다(죽지 않는다).
        let mut lying = vec![message_id::FORMATS];
        lying.extend_from_slice(&9_u32.to_le_bytes());
        lying.extend_from_slice(&0_u32.to_le_bytes());
        assert!(client.process(1, &lying).is_ok());
    }
}
