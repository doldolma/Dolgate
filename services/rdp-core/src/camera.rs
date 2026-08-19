//! 카메라 리디렉션(MS-RDPECAM) — 제어 채널과 장치 채널.
//!
//! 마이크(audin)와 같은 자리에 있지만 두 가지가 다르다.
//!
//! **채널이 두 종류다.** 제어 채널(`RDCamera_Device_Enumerator`)에서 버전을 맞추고 카메라를
//! 알린 뒤, 서버가 우리가 알려 준 이름으로 **장치 채널**을 연다. 협상과 프레임 전송은 그 장치
//! 채널에서 일어난다.
//!
//! **프레임은 서버가 당겨 간다(credit).** 서버가 `SampleRequest` 로 한 장을 허락하고, 우리는
//! 허락이 남아 있을 때만 한 장 보낸다. 그리고 H.264 는 **인코딩된 프레임을 버릴 수 없다** —
//! 참조 사슬이 끊긴다. 그래서 버리는 것은 렌더러가 **인코딩 전에** 한다(원본 프레임을 버리는
//! 것은 무해하다). 여기서는 남은 허락 수를 렌더러에 알려 주는 것까지만 한다.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use ironrdp_core::impl_as_any;
use ironrdp_dvc::{DvcChannelListener, DvcClientProcessor, DvcMessage, DvcProcessor};
use ironrdp_pdu::PduResult;
use tracing::{debug, info, warn};

use crate::camera_pdu::{self, Incoming, MediaType, Outgoing};

/// 장치 채널 이름. 우리가 정해서 알리고 서버가 이 이름으로 붙는다(규격이 정한 형식은 없다).
pub const DEVICE_CHANNEL_NAME: &str = "RDCamera_dolgate0";

/// 원격에 보일 카메라 이름.
const DEVICE_LABEL: &str = "Dolgate Camera";

/// 광고하는 해상도·프레임레이트.
///
/// **하나만 내민다.** 여러 개를 내밀면 서버가 고른 것에 맞춰 렌더러가 다시 잡아야 하고, 그
/// 왕복이 늘어날 뿐 얻는 것이 없다 — 카메라는 마이크와 달리 우리가 원본을 스케일할 수 있다.
/// 720p 를 고른 것은 대역폭 때문이다(1080p H.264 는 4Mbps 를 넘고, SSM 터널은 1MB/s 가 상한이다).
const ADVERTISED_WIDTH: u32 = 1280;
const ADVERTISED_HEIGHT: u32 = 720;
const ADVERTISED_FPS: u32 = 30;

/// 채널 상태를 펌프·렌더러와 나눠 갖는다.
///
/// 리스너로 붙인 채널은 크레이트의 TypeId 조회에 걸리지 않아서(audin 과 같은 이유) 상태를
/// 처리기 밖으로 빼낸다.
#[derive(Debug, Default)]
pub struct CameraChannel {
    /// 장치 채널 번호. 0 은 아직 안 열렸다는 뜻이다.
    device_channel_id: AtomicU32,
    /// 서버가 캡처를 시작하라고 했는지.
    streaming: AtomicBool,
    /// 서버가 허락한 장 수. 0 이면 보내면 안 된다.
    credit: AtomicU32,
    /// 서버가 고른 스트림 번호.
    stream_index: AtomicU32,
}

impl CameraChannel {
    /// 지금 프레임을 보낼 수 있으면 (채널 번호, 스트림 번호).
    pub fn ready(&self) -> Option<(u32, u8)> {
        let channel_id = self.device_channel_id.load(Ordering::Relaxed);
        if channel_id == 0 || !self.streaming.load(Ordering::Relaxed) {
            return None;
        }
        if self.credit.load(Ordering::Relaxed) == 0 {
            return None;
        }
        Some((channel_id, self.stream_index.load(Ordering::Relaxed) as u8))
    }

    /// 한 장을 썼다. 허락이 0 이면 아무것도 하지 않는다(경쟁 상태에서도 음수로 내려가지 않게).
    pub fn take_credit(&self) -> bool {
        let mut current = self.credit.load(Ordering::Relaxed);
        while current > 0 {
            match self.credit.compare_exchange_weak(
                current,
                current - 1,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => return true,
                Err(actual) => current = actual,
            }
        }
        false
    }

    pub fn streaming(&self) -> bool {
        self.streaming.load(Ordering::Relaxed)
    }
}

/// 제어 채널에서 일어난 일을 펌프에 알린다. 펌프가 이벤트로 렌더러에 올린다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CameraSignal {
    /// 서버가 이 사양으로 캡처를 시작하라고 했다.
    Start {
        width: u32,
        height: u32,
        fps: u32,
    },
    /// 캡처를 멈춰야 한다.
    Stop,
    /// 프레임 한 장을 더 보낼 수 있다.
    Credit,
}

type SignalSender = std::sync::mpsc::Sender<CameraSignal>;

/// 제어 채널. 버전을 맞추고 카메라를 알린다.
#[derive(Debug)]
pub struct CameraEnumerator {
    announced: bool,
}

impl_as_any!(CameraEnumerator);

impl CameraEnumerator {
    fn new() -> Self {
        Self { announced: false }
    }
}

impl DvcProcessor for CameraEnumerator {
    fn channel_name(&self) -> &str {
        camera_pdu::ENUMERATOR_CHANNEL_NAME
    }

    fn start(&mut self, channel_id: u32) -> PduResult<Vec<DvcMessage>> {
        // **우리가 먼저 말한다.** audin·rdpsnd 는 서버가 먼저 보내지만 이 채널은 반대다.
        info!(channel_id, "rdpecam: sending the version request");
        Ok(vec![Outgoing::SelectVersionRequest.into_dvc_message()])
    }

    fn process(&mut self, _channel_id: u32, payload: &[u8]) -> PduResult<Vec<DvcMessage>> {
        match camera_pdu::parse(payload) {
            Incoming::SelectVersionResponse { version } => {
                debug!(server_version = version, "rdpecam version");
                if version > camera_pdu::PROTO_VERSION {
                    // 모르는 버전이다. 그 규칙으로 대화를 이어갈 수 없으므로 카메라를 알리지
                    // 않는다(audin 과 같은 판단).
                    warn!(
                        server_version = version,
                        ours = camera_pdu::PROTO_VERSION,
                        "rdpecam: unsupported channel version; not announcing the camera"
                    );
                    return Ok(Vec::new());
                }
                if self.announced {
                    return Ok(Vec::new());
                }
                self.announced = true;
                info!(
                    channel = DEVICE_CHANNEL_NAME,
                    "rdpecam: announcing the camera"
                );
                Ok(vec![Outgoing::DeviceAdded {
                    name: DEVICE_LABEL.to_owned(),
                    channel_name: DEVICE_CHANNEL_NAME.to_owned(),
                }
                .into_dvc_message()])
            }
            other => {
                debug!(
                    ?other,
                    bytes = payload.len(),
                    head = ?&payload[..payload.len().min(8)],
                    "rdpecam: an unanswered enumerator message"
                );
                Ok(Vec::new())
            }
        }
    }
}

impl DvcClientProcessor for CameraEnumerator {}

/// 장치 채널. 협상과 프레임 전송이 여기서 일어난다.
#[derive(Debug)]
pub struct CameraDevice {
    channel: Arc<CameraChannel>,
    signals: SignalSender,
}

impl_as_any!(CameraDevice);

impl CameraDevice {
    fn new(channel: Arc<CameraChannel>, signals: SignalSender) -> Self {
        Self { channel, signals }
    }

    fn advertised() -> MediaType {
        MediaType::h264(ADVERTISED_WIDTH, ADVERTISED_HEIGHT, ADVERTISED_FPS)
    }
}

impl DvcProcessor for CameraDevice {
    fn channel_name(&self) -> &str {
        DEVICE_CHANNEL_NAME
    }

    fn start(&mut self, channel_id: u32) -> PduResult<Vec<DvcMessage>> {
        info!(channel_id, "rdpecam: the server opened the camera channel");
        self.channel
            .device_channel_id
            .store(channel_id, Ordering::Relaxed);
        // 서버가 먼저 묻는다(Activate 부터). 우리가 먼저 말하지 않는다.
        Ok(Vec::new())
    }

    fn close(&mut self, channel_id: u32) {
        // 서버가 채널을 닫는 것 자체가 신호다 — 우리 답을 받아들이지 못하면 닫고 다시 연다.
        info!(channel_id, "rdpecam: the server closed the camera channel");
        if self
            .channel
            .device_channel_id
            .compare_exchange(channel_id, 0, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
        {
            self.channel.streaming.store(false, Ordering::Relaxed);
            self.channel.credit.store(0, Ordering::Relaxed);
            let _ = self.signals.send(CameraSignal::Stop);
        }
    }

    fn process(&mut self, _channel_id: u32, payload: &[u8]) -> PduResult<Vec<DvcMessage>> {
        // **메시지마다 남긴다.** 이 채널은 서버가 열고 닫기를 반복하는 것으로 실패가 드러나는데,
        // 어느 답이 거부됐는지는 주고받은 것을 봐야만 알 수 있다. 제어 바이트라 값이 민감하지 않다.
        let parsed = camera_pdu::parse(payload);
        debug!(
            bytes = payload.len(),
            head = ?&payload[..payload.len().min(8)],
            ?parsed,
            "rdpecam device message"
        );
        match parsed {
            Incoming::ActivateDevice | Incoming::DeactivateDevice => {
                Ok(vec![Outgoing::Success.into_dvc_message()])
            }
            Incoming::StreamListRequest => Ok(vec![Outgoing::StreamList.into_dvc_message()]),
            Incoming::MediaTypeListRequest { stream_index } => {
                debug!(stream_index, "rdpecam media type list");
                Ok(vec![
                    Outgoing::MediaTypeList(vec![Self::advertised()]).into_dvc_message()
                ])
            }
            Incoming::CurrentMediaTypeRequest { .. } => {
                Ok(vec![Outgoing::CurrentMediaType(Self::advertised()).into_dvc_message()])
            }
            Incoming::StartStreams {
                stream_index,
                media_type,
            } => {
                // **서버가 고른 사양을 그대로 렌더러에 넘긴다.** 우리가 광고한 것과 다를 수 있고,
                // 다른 사양으로 캡처하면 원격에서 찌그러진 화면이 된다.
                info!(
                    stream_index,
                    width = media_type.width,
                    height = media_type.height,
                    fps = media_type.fps(),
                    "rdpecam: the server started the stream"
                );
                self.channel
                    .stream_index
                    .store(u32::from(stream_index), Ordering::Relaxed);
                self.channel.credit.store(0, Ordering::Relaxed);
                self.channel.streaming.store(true, Ordering::Relaxed);
                let _ = self.signals.send(CameraSignal::Start {
                    width: media_type.width,
                    height: media_type.height,
                    fps: media_type.fps(),
                });
                Ok(vec![Outgoing::Success.into_dvc_message()])
            }
            Incoming::StopStreams => {
                info!("rdpecam: the server stopped the stream");
                self.channel.streaming.store(false, Ordering::Relaxed);
                self.channel.credit.store(0, Ordering::Relaxed);
                let _ = self.signals.send(CameraSignal::Stop);
                Ok(vec![Outgoing::Success.into_dvc_message()])
            }
            Incoming::SampleRequest { stream_index } => {
                if u32::from(stream_index) != self.channel.stream_index.load(Ordering::Relaxed) {
                    return Ok(vec![Outgoing::SampleError {
                        stream_index,
                        code: camera_pdu::error_code::INVALID_STREAM_NUMBER,
                    }
                    .into_dvc_message()]);
                }
                // 허락을 쌓아 두고 렌더러에 알린다. 실제 전송은 펌프가 한다 — 프레임이 언제
                // 올지 모르므로 여기서 답할 수 없다.
                self.channel.credit.fetch_add(1, Ordering::Relaxed);
                let _ = self.signals.send(CameraSignal::Credit);
                Ok(Vec::new())
            }
            // 속성(밝기·대비)은 지원하지 않는다. 빈 목록으로 답하면 서버가 더 묻지 않는다.
            Incoming::PropertyListRequest => Ok(vec![Outgoing::PropertyList.into_dvc_message()]),
            Incoming::PropertyRelated => Ok(vec![Outgoing::Error {
                code: camera_pdu::error_code::OPERATION_NOT_SUPPORTED,
            }
            .into_dvc_message()]),
            Incoming::Malformed => {
                // 우리가 못 읽은 것이다. 서버는 이 오류를 받으면 채널을 닫는다 — 열고 닫기가
                // 반복되면 여기부터 본다.
                warn!(
                    bytes = payload.len(),
                    head = ?&payload[..payload.len().min(8)],
                    "rdpecam: a device message we could not parse"
                );
                Ok(vec![Outgoing::Error {
                    code: camera_pdu::error_code::INVALID_MESSAGE,
                }
                .into_dvc_message()])
            }
            other => {
                warn!(?other, "rdpecam: an unanswered device message");
                Ok(Vec::new())
            }
        }
    }
}

impl DvcClientProcessor for CameraDevice {}

/// 개설 요청마다 새 처리기를 만든다. 마이크·소리에서 고친 그 함정이다 — 크레이트의
/// `with_dynamic_channel` 은 처리기를 한 번만 내주므로 서버가 채널을 닫고 다시 열면 거절된다.
pub struct CameraEnumeratorListener;

impl DvcChannelListener for CameraEnumeratorListener {
    fn channel_name(&self) -> &str {
        camera_pdu::ENUMERATOR_CHANNEL_NAME
    }

    fn create(&mut self, _channel_id: u32) -> Option<Box<dyn DvcProcessor>> {
        Some(Box::new(CameraEnumerator::new()))
    }
}

pub struct CameraDeviceListener {
    channel: Arc<CameraChannel>,
    signals: SignalSender,
}

impl CameraDeviceListener {
    pub fn new(channel: Arc<CameraChannel>, signals: SignalSender) -> Self {
        Self { channel, signals }
    }
}

impl DvcChannelListener for CameraDeviceListener {
    fn channel_name(&self) -> &str {
        DEVICE_CHANNEL_NAME
    }

    fn create(&mut self, _channel_id: u32) -> Option<Box<dyn DvcProcessor>> {
        Some(Box::new(CameraDevice::new(
            Arc::clone(&self.channel),
            self.signals.clone(),
        )))
    }
}

/// 인코딩된 프레임 한 장을 보낼 메시지로.
pub fn encode_sample(stream_index: u8, sample: Vec<u8>) -> Vec<DvcMessage> {
    vec![Outgoing::SampleResponse {
        stream_index,
        sample,
    }
    .into_dvc_message()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironrdp_core::{encode_vec as enc, WriteCursor};
    use ironrdp_dvc::pdu::{
        CapabilitiesRequestPdu, CapsVersion, CreateRequestPdu, DataPdu, DrdynvcDataPdu,
        DrdynvcServerPdu,
    };
    use ironrdp_dvc::DrdynvcClient;
    use ironrdp_svc::SvcProcessor;
    use std::sync::mpsc;

    const ENUM_CHANNEL: u32 = 5;
    const DEV_CHANNEL: u32 = 6;

    /// 서버가 채널로 한 덩어리 보낸다. 응답은 DVC 프레이밍이 붙은 채로 돌아온다.
    fn on_channel(client: &mut DrdynvcClient, channel_id: u32, payload: Vec<u8>) -> Vec<Vec<u8>> {
        let pdu = DrdynvcServerPdu::Data(DrdynvcDataPdu::Data(DataPdu::new(channel_id, payload)));
        client
            .process(&enc(&pdu).expect("데이터 PDU"))
            .expect("채널 처리")
            .into_iter()
            .map(|message| message.encode_unframed_pdu().expect("응답 인코딩"))
            .collect()
    }

    fn open(client: &mut DrdynvcClient, channel_id: u32, name: &str) -> Vec<Vec<u8>> {
        let request = enc(&DrdynvcServerPdu::Create(CreateRequestPdu::new(
            channel_id,
            name.to_owned(),
        )))
        .expect("개설 요청");
        client
            .process(&request)
            .expect("개설 처리")
            .into_iter()
            .map(|message| message.encode_unframed_pdu().expect("응답 인코딩"))
            .collect()
    }

    /// **협상 전체를 크레이트의 채널 경로로 태운다.**
    ///
    /// 단위 테스트는 처리기를 직접 부르지만, 실제 서버는 DVC 프레이밍으로 감싸 보내고 우리 응답도
    /// 그 프레이밍으로 돌아간다. 그 층에서 어긋나면 단위 테스트는 다 통과하는데 한 마디도 안
    /// 통한다(마이크에서 그 자리를 검사해 두었다).
    #[test]
    fn negotiates_end_to_end_through_the_crate_channels() {
        let channel = Arc::new(CameraChannel::default());
        let (signal_tx, signal_rx) = mpsc::channel();
        let mut client = DrdynvcClient::new()
            .with_listener(CameraEnumeratorListener)
            .with_listener(CameraDeviceListener::new(Arc::clone(&channel), signal_tx));

        client
            .process(
                &enc(&DrdynvcServerPdu::Capabilities(CapabilitiesRequestPdu::new(
                    CapsVersion::V1,
                    None,
                )))
                .unwrap(),
            )
            .expect("caps");

        // 제어 채널이 열리면 **우리가 먼저** 버전을 묻는다.
        let replies = open(&mut client, ENUM_CHANNEL, camera_pdu::ENUMERATOR_CHANNEL_NAME);
        assert!(
            replies.iter().any(|bytes| bytes.ends_with(&[0x02, 0x03])),
            "개설 직후 SelectVersionRequest 가 나가야 한다: {replies:?}"
        );

        // 서버가 버전을 답하면 카메라를 알린다.
        let replies = on_channel(&mut client, ENUM_CHANNEL, vec![0x02, 0x04]);
        let announce = replies
            .iter()
            .find(|bytes| bytes.contains(&0x05))
            .expect("DeviceAddedNotification 이 나가야 한다");
        assert!(
            announce.ends_with(&{
                let mut tail = DEVICE_CHANNEL_NAME.as_bytes().to_vec();
                tail.push(0);
                tail
            }),
            "장치 채널 이름이 ASCII+NUL 로 끝에 실려야 한다: {announce:?}"
        );

        // 서버가 그 이름으로 장치 채널을 연다.
        open(&mut client, DEV_CHANNEL, DEVICE_CHANNEL_NAME);
        assert_eq!(channel.ready(), None, "아직 스트림이 시작되지 않았다");

        // Activate → 공용 SuccessResponse
        let replies = on_channel(&mut client, DEV_CHANNEL, vec![0x02, 0x07]);
        assert!(
            replies.iter().any(|bytes| bytes.ends_with(&[0x02, 0x01])),
            "Activate 에는 SuccessResponse 로 답한다: {replies:?}"
        );

        // StreamList → 컬러 캡처 하나
        let replies = on_channel(&mut client, DEV_CHANNEL, vec![0x02, 0x09]);
        assert!(
            replies
                .iter()
                .any(|bytes| bytes.ends_with(&[0x0A, 0x01, 0x00, 0x01, 0x01, 0x00])),
            "StreamListResponse 에 개수 바이트가 붙으면 서버가 거부한다: {replies:?}"
        );

        // MediaTypeList → H.264 하나
        let replies = on_channel(&mut client, DEV_CHANNEL, vec![0x02, 0x0B, 0x00]);
        let list = replies
            .iter()
            .find(|bytes| bytes.contains(&0x0C))
            .expect("MediaTypeListResponse");
        assert_eq!(
            MediaType::decode(&list[list.len() - MediaType::WIRE_LEN..]),
            Some(MediaType::h264(ADVERTISED_WIDTH, ADVERTISED_HEIGHT, ADVERTISED_FPS)),
            "광고한 형식이 그대로 실려야 한다"
        );

        // StartStreams(서버가 640x480@15 를 고름) → 그 사양이 렌더러로 올라간다
        let mut start = vec![0x02, 0x0F, 0x00];
        let mut wire = vec![0_u8; MediaType::WIRE_LEN];
        MediaType::h264(640, 480, 15).encode_into(&mut WriteCursor::new(&mut wire));
        start.extend_from_slice(&wire);
        on_channel(&mut client, DEV_CHANNEL, start);

        assert_eq!(
            signal_rx.try_recv(),
            Ok(CameraSignal::Start {
                width: 640,
                height: 480,
                fps: 15
            }),
            "서버가 고른 사양을 그대로 올려야 한다 — 우리가 광고한 것과 다를 수 있다"
        );
        assert!(channel.streaming());
        assert_eq!(channel.ready(), None, "허락 없이는 보내지 않는다");

        // SampleRequest 한 번 = 한 장 허락
        on_channel(&mut client, DEV_CHANNEL, vec![0x02, 0x11, 0x00]);
        assert_eq!(signal_rx.try_recv(), Ok(CameraSignal::Credit));
        assert_eq!(channel.ready(), Some((DEV_CHANNEL, 0)));
        assert!(channel.take_credit());
        assert_eq!(channel.ready(), None, "한 장을 쓰면 허락이 없어진다");

        // StopStreams → 정지 신호
        on_channel(&mut client, DEV_CHANNEL, vec![0x02, 0x10]);
        assert_eq!(signal_rx.try_recv(), Ok(CameraSignal::Stop));
        assert!(!channel.streaming());
    }

    /// 허락이 0 이면 절대 보내면 안 된다. 보내도 서버가 버리고, 그동안 우리 프레임 큐만 밀린다.
    #[test]
    fn credit_never_goes_negative() {
        let channel = CameraChannel::default();
        assert!(!channel.take_credit(), "허락이 없으면 실패해야 한다");
        channel.credit.store(1, Ordering::Relaxed);
        assert!(channel.take_credit());
        assert!(!channel.take_credit());
    }

    /// 장치 채널이 닫히면 캡처를 멈추라고 알려야 한다 — 렌더러가 카메라를 계속 잡고 있으면
    /// 표시등이 켜진 채로 남는다.
    #[test]
    fn closing_the_device_channel_stops_the_capture() {
        let channel = Arc::new(CameraChannel::default());
        let (signal_tx, signal_rx) = mpsc::channel();
        let mut device = CameraDevice::new(Arc::clone(&channel), signal_tx);

        device.start(DEV_CHANNEL).expect("start");
        channel.streaming.store(true, Ordering::Relaxed);
        device.close(DEV_CHANNEL);

        assert!(!channel.streaming());
        assert_eq!(signal_rx.try_recv(), Ok(CameraSignal::Stop));
    }

    /// 개설 요청마다 새 처리기를 내줘야 한다. 마이크·소리에서 고친 그 함정이다.
    #[test]
    fn listeners_create_a_processor_for_every_request() {
        let channel = Arc::new(CameraChannel::default());
        let (signal_tx, _rx) = mpsc::channel();
        let mut enumerator = CameraEnumeratorListener;
        let mut device = CameraDeviceListener::new(channel, signal_tx);

        assert!(enumerator.create(1).is_some());
        assert!(enumerator.create(2).is_some(), "닫힌 뒤 재개설");
        assert!(device.create(3).is_some());
        assert!(device.create(4).is_some(), "닫힌 뒤 재개설");
    }
}
