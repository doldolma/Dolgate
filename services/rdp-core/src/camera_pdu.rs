//! MS-RDPECAM PDU — 카메라 리디렉션의 메시지 정의와 직렬화.
//!
//! **헤더는 두 바이트다**: `[Version u8][MessageId u8]`. 모든 메시지에 붙는다. 그리고 메시지
//! 번호는 제어 채널과 장치 채널이 **하나의 표를 공유한다** — 채널별로 1부터 다시 세지 않는다.
//!
//! 여기 값들은 FreeRDP 의 `channels/rdpecam` 와 대조해 넣었다. 마이크(audin)에서 버전 하나를
//! 틀려 협상이 조용히 멈추는 데 하루를 썼기 때문에, 이 파일의 테스트는 **상수를 참조하지 않고
//! 바이트를 직접 적어** 검사한다.

use ironrdp_core::{Encode, EncodeResult, WriteCursor};
use ironrdp_dvc::{DvcEncode, DvcMessage};

/// 우리가 말하는 프로토콜 버전. FreeRDP 도 2 다(`ECAM_PROTO_VERSION`).
pub const PROTO_VERSION: u8 = 0x02;

/// 제어 채널 이름. 서버가 이 이름으로 채널을 연다.
pub const ENUMERATOR_CHANNEL_NAME: &str = "RDCamera_Device_Enumerator";

pub mod msg {
    pub const SUCCESS_RESPONSE: u8 = 0x01;
    pub const ERROR_RESPONSE: u8 = 0x02;
    pub const SELECT_VERSION_REQUEST: u8 = 0x03;
    pub const SELECT_VERSION_RESPONSE: u8 = 0x04;
    pub const DEVICE_ADDED_NOTIFICATION: u8 = 0x05;
    pub const DEVICE_REMOVED_NOTIFICATION: u8 = 0x06;
    pub const ACTIVATE_DEVICE_REQUEST: u8 = 0x07;
    pub const DEACTIVATE_DEVICE_REQUEST: u8 = 0x08;
    pub const STREAM_LIST_REQUEST: u8 = 0x09;
    pub const STREAM_LIST_RESPONSE: u8 = 0x0A;
    pub const MEDIA_TYPE_LIST_REQUEST: u8 = 0x0B;
    pub const MEDIA_TYPE_LIST_RESPONSE: u8 = 0x0C;
    pub const CURRENT_MEDIA_TYPE_REQUEST: u8 = 0x0D;
    pub const CURRENT_MEDIA_TYPE_RESPONSE: u8 = 0x0E;
    pub const START_STREAMS_REQUEST: u8 = 0x0F;
    pub const STOP_STREAMS_REQUEST: u8 = 0x10;
    pub const SAMPLE_REQUEST: u8 = 0x11;
    pub const SAMPLE_RESPONSE: u8 = 0x12;
    pub const SAMPLE_ERROR_RESPONSE: u8 = 0x13;
    pub const PROPERTY_LIST_REQUEST: u8 = 0x14;
    pub const PROPERTY_LIST_RESPONSE: u8 = 0x15;
    pub const PROPERTY_VALUE_REQUEST: u8 = 0x16;
    pub const PROPERTY_VALUE_RESPONSE: u8 = 0x17;
    pub const SET_PROPERTY_VALUE_REQUEST: u8 = 0x18;
}

/// 미디어 포맷. **H.264 만 광고한다** — 렌더러의 VideoEncoder 가 하드웨어로 만들어 주고,
/// 무압축을 광고하면 1080p 한 장이 3MB 라 어떤 경로에서도 감당이 안 된다.
pub const MEDIA_FORMAT_H264: u8 = 0x01;

/// `CAM_MEDIA_TYPE_DESCRIPTION_FLAG_DecodingRequired`.
///
/// **압축 형식에는 반드시 세워야 한다.** 이것이 없으면 윈도우는 우리가 보내는 H.264 바이트를
/// 선언한 형식의 **무압축 픽셀**로 읽으려 하고, 원격 카메라 앱은 "카메라를 시작할 수 없습니다"
/// 로 끝난다(실측). FreeRDP 도 광고하는 모든 타입에 이 플래그를 세운다.
pub const MEDIA_TYPE_FLAG_DECODING_REQUIRED: u8 = 0x01;

/// 오류 코드. 우리가 쓰는 것만 둔다.
pub mod error_code {
    pub const INVALID_MESSAGE: u32 = 0x0000_0002;
    pub const INVALID_STREAM_NUMBER: u32 = 0x0000_0005;
    pub const OPERATION_NOT_SUPPORTED: u32 = 0x0000_000A;
}

/// 스트림 하나의 성격. 우리는 컬러 캡처 하나만 내민다.
mod stream_description {
    /// FrameSourceTypes = Color
    pub const FRAME_SOURCE_COLOR: u16 = 0x0001;
    /// StreamCategory = Capture
    pub const CATEGORY_CAPTURE: u8 = 0x01;
}

/// 미디어 타입 하나. 와이어에서 29바이트 고정이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MediaType {
    pub format: u8,
    pub width: u32,
    pub height: u32,
    pub frame_rate_numerator: u32,
    pub frame_rate_denominator: u32,
    pub aspect_numerator: u32,
    pub aspect_denominator: u32,
    pub flags: u8,
}

impl MediaType {
    pub const WIRE_LEN: usize = 1 + 4 * 6 + 1;

    /// H.264 로 이 해상도·프레임레이트를 광고한다.
    pub fn h264(width: u32, height: u32, fps: u32) -> Self {
        Self {
            format: MEDIA_FORMAT_H264,
            width,
            height,
            frame_rate_numerator: fps,
            frame_rate_denominator: 1,
            // 정사각 픽셀. 이 값을 0 으로 두면 서버가 종횡비를 계산하지 못한다.
            aspect_numerator: 1,
            aspect_denominator: 1,
            // 압축 형식이므로 DecodingRequired 다. 위 상수 주석에 이유가 있다.
            flags: MEDIA_TYPE_FLAG_DECODING_REQUIRED,
        }
    }

    pub fn encode_into(&self, dst: &mut WriteCursor<'_>) {
        dst.write_u8(self.format);
        dst.write_u32(self.width);
        dst.write_u32(self.height);
        dst.write_u32(self.frame_rate_numerator);
        dst.write_u32(self.frame_rate_denominator);
        dst.write_u32(self.aspect_numerator);
        dst.write_u32(self.aspect_denominator);
        dst.write_u8(self.flags);
    }

    /// 서버가 고른 형식을 읽는다. 길이가 모자라면 None.
    pub fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < Self::WIRE_LEN {
            return None;
        }
        let u32_at = |offset: usize| {
            u32::from_le_bytes([
                bytes[offset],
                bytes[offset + 1],
                bytes[offset + 2],
                bytes[offset + 3],
            ])
        };
        Some(Self {
            format: bytes[0],
            width: u32_at(1),
            height: u32_at(5),
            frame_rate_numerator: u32_at(9),
            frame_rate_denominator: u32_at(13),
            aspect_numerator: u32_at(17),
            aspect_denominator: u32_at(21),
            flags: bytes[25],
        })
    }

    /// 초당 프레임 수. 분모가 0 인 서버 값을 그대로 나누면 패닉이라 여기서 막는다.
    pub fn fps(&self) -> u32 {
        if self.frame_rate_denominator == 0 {
            return 0;
        }
        self.frame_rate_numerator / self.frame_rate_denominator
    }
}

/// 우리가 보내는 메시지.
#[derive(Debug, Clone)]
pub enum Outgoing {
    /// 제어 채널이 열리면 **우리가 먼저** 보낸다. audin·rdpsnd 와 반대다.
    SelectVersionRequest,
    /// 카메라 하나를 알린다. 서버는 `channel_name` 으로 장치 채널을 연다.
    DeviceAdded { name: String, channel_name: String },
    DeviceRemoved { channel_name: String },
    /// Activate·StartStreams·StopStreams 등에 대한 공용 성공 응답.
    Success,
    Error { code: u32 },
    /// 컬러 캡처 스트림 하나.
    StreamList,
    MediaTypeList(Vec<MediaType>),
    CurrentMediaType(MediaType),
    /// 속성은 지원하지 않는다 — 빈 목록으로 답한다.
    PropertyList,
    /// 인코딩된 프레임 한 장. **길이·타임스탬프 필드가 없다**(길이는 DVC 프레이밍이 준다).
    SampleResponse { stream_index: u8, sample: Vec<u8> },
    SampleError { stream_index: u8, code: u32 },
}

impl Outgoing {
    /// UTF-16LE + NUL 로 쓴 바이트 수.
    fn utf16_len(text: &str) -> usize {
        (text.encode_utf16().count() + 1) * 2
    }

    pub fn into_dvc_message(self) -> DvcMessage {
        Box::new(self) as DvcMessage
    }
}

impl Encode for Outgoing {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        dst.write_u8(PROTO_VERSION);
        match self {
            Self::SelectVersionRequest => dst.write_u8(msg::SELECT_VERSION_REQUEST),
            Self::DeviceAdded { name, channel_name } => {
                dst.write_u8(msg::DEVICE_ADDED_NOTIFICATION);
                // 장치 이름은 UTF-16LE, 채널 이름은 ASCII. 둘 다 NUL 로 끝난다.
                for unit in name.encode_utf16() {
                    dst.write_u16(unit);
                }
                dst.write_u16(0);
                dst.write_slice(channel_name.as_bytes());
                dst.write_u8(0);
            }
            Self::DeviceRemoved { channel_name } => {
                dst.write_u8(msg::DEVICE_REMOVED_NOTIFICATION);
                dst.write_slice(channel_name.as_bytes());
                dst.write_u8(0);
            }
            Self::Success => dst.write_u8(msg::SUCCESS_RESPONSE),
            Self::Error { code } => {
                dst.write_u8(msg::ERROR_RESPONSE);
                dst.write_u32(*code);
            }
            Self::StreamList => {
                dst.write_u8(msg::STREAM_LIST_RESPONSE);
                // **개수 바이트를 쓰지 않는다.** 규격 구조체에 `N_Descriptions` 가 있지만 그것은
                // 호스트 쪽 장부이고 와이어에는 없다 — 서버가 payload 길이로 센다(미디어 타입
                // 목록도 같다). 개수를 넣으면 서버가 FrameSourceTypes 를 0x0101 로 읽고 거부한
                // 뒤 Deactivate·Close 로 채널을 접는다(실측: 열고 닫기가 무한 반복됐다).
                dst.write_u16(stream_description::FRAME_SOURCE_COLOR);
                dst.write_u8(stream_description::CATEGORY_CAPTURE);
                dst.write_u8(1); // Selected
                dst.write_u8(0); // CanBeShared — 한 세션이 독점한다
            }
            Self::MediaTypeList(types) => {
                dst.write_u8(msg::MEDIA_TYPE_LIST_RESPONSE);
                for media_type in types {
                    media_type.encode_into(dst);
                }
            }
            Self::CurrentMediaType(media_type) => {
                dst.write_u8(msg::CURRENT_MEDIA_TYPE_RESPONSE);
                media_type.encode_into(dst);
            }
            Self::PropertyList => {
                // 헤더만 보낸다. FreeRDP 도 이 응답을 헤더만으로 보내고(속성 미구현), 개수
                // 바이트를 붙이면 서버가 그것을 속성 목록의 시작으로 읽는다.
                dst.write_u8(msg::PROPERTY_LIST_RESPONSE);
            }
            Self::SampleResponse {
                stream_index,
                sample,
            } => {
                dst.write_u8(msg::SAMPLE_RESPONSE);
                dst.write_u8(*stream_index);
                dst.write_slice(sample);
            }
            Self::SampleError { stream_index, code } => {
                dst.write_u8(msg::SAMPLE_ERROR_RESPONSE);
                dst.write_u8(*stream_index);
                dst.write_u32(*code);
            }
        }
        Ok(())
    }

    fn name(&self) -> &'static str {
        "RdpecamPdu"
    }

    fn size(&self) -> usize {
        let header = 2;
        header
            + match self {
                Self::SelectVersionRequest | Self::Success => 0,
                Self::DeviceAdded { name, channel_name } => {
                    Self::utf16_len(name) + channel_name.len() + 1
                }
                Self::DeviceRemoved { channel_name } => channel_name.len() + 1,
                Self::Error { .. } => 4,
                Self::StreamList => 2 + 1 + 1 + 1,
                Self::MediaTypeList(types) => types.len() * MediaType::WIRE_LEN,
                Self::CurrentMediaType(_) => MediaType::WIRE_LEN,
                Self::PropertyList => 0,
                Self::SampleResponse { sample, .. } => 1 + sample.len(),
                Self::SampleError { .. } => 1 + 4,
            }
    }
}

impl DvcEncode for Outgoing {}

/// 서버가 보낸 메시지. 우리가 다루는 것만 갈라 놓는다.
#[derive(Debug, PartialEq, Eq)]
pub enum Incoming {
    SelectVersionResponse { version: u8 },
    ActivateDevice,
    DeactivateDevice,
    StreamListRequest,
    MediaTypeListRequest { stream_index: u8 },
    CurrentMediaTypeRequest { stream_index: u8 },
    /// 서버가 고른 형식으로 캡처를 시작하라는 뜻이다.
    StartStreams { stream_index: u8, media_type: MediaType },
    StopStreams,
    /// **한 장을 보내라는 허락이다**(credit). 이것 없이 보내면 서버가 버린다.
    SampleRequest { stream_index: u8 },
    /// 속성 관련. 우리는 지원하지 않는다고 답한다.
    PropertyListRequest,
    PropertyRelated,
    /// 우리가 모르는 것. 무시한다(오류로 만들면 세션이 끊긴다).
    Unknown { message_id: u8 },
    /// 헤더조차 없는 조각.
    Malformed,
}

/// 서버 메시지를 갈라 준다. 길이가 모자란 것은 `Malformed` 로 접는다 — 패닉 대신 무시한다.
pub fn parse(payload: &[u8]) -> Incoming {
    let (Some(_version), Some(&message_id)) = (payload.first(), payload.get(1)) else {
        return Incoming::Malformed;
    };
    let body = &payload[2..];
    match message_id {
        msg::SELECT_VERSION_RESPONSE => Incoming::SelectVersionResponse {
            // 서버가 버전만 보내는 경우도 있어 본문이 비어 있으면 헤더의 값을 쓴다.
            version: payload[0],
        },
        msg::ACTIVATE_DEVICE_REQUEST => Incoming::ActivateDevice,
        msg::DEACTIVATE_DEVICE_REQUEST => Incoming::DeactivateDevice,
        msg::STREAM_LIST_REQUEST => Incoming::StreamListRequest,
        msg::MEDIA_TYPE_LIST_REQUEST => match body.first() {
            Some(&stream_index) => Incoming::MediaTypeListRequest { stream_index },
            None => Incoming::Malformed,
        },
        msg::CURRENT_MEDIA_TYPE_REQUEST => match body.first() {
            Some(&stream_index) => Incoming::CurrentMediaTypeRequest { stream_index },
            None => Incoming::Malformed,
        },
        msg::START_STREAMS_REQUEST => {
            // `[StreamIndex u8][MediaTypeDescription 26]`. **개수 바이트가 없다** — 규격 구조체의
            // `N_Infos` 는 와이어 필드가 아니다(StreamListResponse 와 같은 함정이고, FreeRDP 도
            // `1 + 26` 만 읽는다). 개수를 기대하면 이 메시지를 통째로 못 읽고 스트림이 시작되지
            // 않는다 — 실측 로그에서 29바이트가 Malformed 로 떨어졌다.
            let Some(&stream_index) = body.first() else {
                return Incoming::Malformed;
            };
            match MediaType::decode(&body[1..]) {
                Some(media_type) => Incoming::StartStreams {
                    stream_index,
                    media_type,
                },
                None => Incoming::Malformed,
            }
        }
        msg::STOP_STREAMS_REQUEST => Incoming::StopStreams,
        msg::SAMPLE_REQUEST => match body.first() {
            Some(&stream_index) => Incoming::SampleRequest { stream_index },
            None => Incoming::Malformed,
        },
        msg::PROPERTY_LIST_REQUEST => Incoming::PropertyListRequest,
        msg::PROPERTY_VALUE_REQUEST | msg::SET_PROPERTY_VALUE_REQUEST => Incoming::PropertyRelated,
        other => Incoming::Unknown { message_id: other },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironrdp_core::encode_vec;

    /// **상수를 참조하지 않고 바이트를 직접 적는다.** 상수만 보면 값이 틀려도 통과하고, 그러면
    /// 서버가 조용히 멈추는 것을 실기기에서야 알게 된다(마이크에서 그랬다).
    #[test]
    fn header_is_version_then_message_id() {
        assert_eq!(
            encode_vec(&Outgoing::SelectVersionRequest).unwrap(),
            vec![0x02, 0x03]
        );
        assert_eq!(encode_vec(&Outgoing::Success).unwrap(), vec![0x02, 0x01]);
    }

    #[test]
    fn device_added_writes_utf16_name_then_ascii_channel() {
        let bytes = encode_vec(&Outgoing::DeviceAdded {
            name: "Cam".to_owned(),
            channel_name: "dev0".to_owned(),
        })
        .unwrap();

        let mut want = vec![0x02, 0x05];
        want.extend_from_slice(&[b'C', 0, b'a', 0, b'm', 0, 0, 0]); // UTF-16LE + NUL
        want.extend_from_slice(b"dev0\0"); // ASCII + NUL
        assert_eq!(bytes, want);
    }

    /// **개수 바이트가 없다.** 규격 구조체의 `N_Descriptions` 는 와이어 필드가 아니다 — 넣으면
    /// 서버가 뒤 필드를 한 칸 밀려 읽고 채널을 접는다(실측).
    #[test]
    fn stream_list_advertises_one_selected_color_capture() {
        assert_eq!(
            encode_vec(&Outgoing::StreamList).unwrap(),
            // [ver][0x0A][FrameSourceTypes=Color(u16)][Category=Capture][Selected][CanBeShared]
            vec![0x02, 0x0A, 0x01, 0x00, 0x01, 0x01, 0x00]
        );
    }

    #[test]
    fn media_type_is_twenty_nine_bytes_little_endian() {
        let media_type = MediaType::h264(1280, 720, 30);
        let bytes = encode_vec(&Outgoing::CurrentMediaType(media_type)).unwrap();

        // 형식은 26바이트다: Format u8 + u32 여섯 개 + Flags u8.
        assert_eq!(bytes.len(), 2 + 26, "헤더 2 + 형식 26");
        assert_eq!(&bytes[0..3], &[0x02, 0x0E, 0x01], "헤더 + H264");
        assert_eq!(&bytes[3..7], &1280_u32.to_le_bytes());
        assert_eq!(&bytes[7..11], &720_u32.to_le_bytes());
        assert_eq!(&bytes[11..15], &30_u32.to_le_bytes());
        assert_eq!(&bytes[15..19], &1_u32.to_le_bytes());
        // **Flags 는 마지막 바이트이고 압축 형식이면 0x01(DecodingRequired) 이어야 한다.**
        // 0 으로 보내면 윈도우가 H.264 를 무압축으로 읽고 카메라를 시작하지 못한다.
        assert_eq!(bytes[27], 0x01, "H.264 에는 DecodingRequired 가 서야 한다");

        // 돌아온 값을 우리가 다시 읽을 수 있어야 한다(서버가 고른 형식이 이 모양으로 온다).
        assert_eq!(MediaType::decode(&bytes[2..]), Some(media_type));
    }

    /// 샘플에는 길이도 타임스탬프도 없다. 붙이면 서버가 그것을 픽셀로 읽는다.
    #[test]
    fn sample_response_is_header_index_then_raw_bytes() {
        let bytes = encode_vec(&Outgoing::SampleResponse {
            stream_index: 0,
            sample: vec![0xDE, 0xAD],
        })
        .unwrap();
        assert_eq!(bytes, vec![0x02, 0x12, 0x00, 0xDE, 0xAD]);
    }

    #[test]
    fn parses_the_requests_we_answer() {
        assert_eq!(parse(&[0x02, 0x07]), Incoming::ActivateDevice);
        assert_eq!(parse(&[0x02, 0x09]), Incoming::StreamListRequest);
        assert_eq!(
            parse(&[0x02, 0x0B, 0x00]),
            Incoming::MediaTypeListRequest { stream_index: 0 }
        );
        assert_eq!(
            parse(&[0x02, 0x11, 0x00]),
            Incoming::SampleRequest { stream_index: 0 }
        );
        assert_eq!(parse(&[0x02, 0x10]), Incoming::StopStreams);
        // 모르는 것은 무시한다. 오류로 만들면 채널이 끊긴다.
        assert_eq!(parse(&[0x02, 0x7F]), Incoming::Unknown { message_id: 0x7F });
        assert_eq!(parse(&[0x02]), Incoming::Malformed);
        assert_eq!(parse(&[]), Incoming::Malformed);
    }

    /// **실제 윈도우 11 이 보낸 모양으로 검사한다.**
    ///
    /// 개수 바이트를 기대하던 동안 이 메시지가 통째로 Malformed 로 떨어져 스트림이 시작되지
    /// 않았다. 아래 head 값은 실측 로그에서 그대로 옮긴 것이다
    /// (`bytes=29 head=[2, 15, 0, 1, 0, 5, 0, 0]`).
    #[test]
    fn parses_start_streams_with_the_chosen_media_type() {
        let mut payload = vec![0x02, 0x0F, 0x00];
        let mut wire = vec![0_u8; MediaType::WIRE_LEN];
        MediaType::h264(1280, 720, 30).encode_into(&mut WriteCursor::new(&mut wire));
        payload.extend_from_slice(&wire);

        assert_eq!(payload.len(), 29, "헤더 2 + 스트림 번호 1 + 형식 26");
        assert_eq!(
            &payload[..8],
            &[2, 15, 0, 1, 0, 5, 0, 0],
            "실측 로그의 앞 8바이트와 같아야 한다"
        );
        assert_eq!(
            parse(&payload),
            Incoming::StartStreams {
                stream_index: 0,
                media_type: MediaType::h264(1280, 720, 30),
            }
        );
        // 잘린 것은 무시한다 — 여기서 패닉하면 세션이 죽는다.
        assert_eq!(parse(&payload[..10]), Incoming::Malformed);
    }

    /// 속성 응답은 헤더만이다. 개수 바이트를 붙이면 서버가 속성 목록의 시작으로 읽는다.
    #[test]
    fn property_list_response_is_header_only() {
        assert_eq!(encode_vec(&Outgoing::PropertyList).unwrap(), vec![0x02, 0x15]);
    }

    #[test]
    fn fps_survives_a_zero_denominator() {
        let mut media_type = MediaType::h264(640, 480, 30);
        assert_eq!(media_type.fps(), 30);
        media_type.frame_rate_denominator = 0;
        assert_eq!(media_type.fps(), 0, "0 으로 나누면 패닉이다");
    }
}
