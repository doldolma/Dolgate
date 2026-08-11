//! RFB wire protocol: version handshake, security negotiation, init, and the message set.
//!
//! 규격은 RFC 6143(RFB 3.8)이다. 3.3·3.7 과 다른 부분은 각 함수 주석에 적어 두었다 — 오래된
//! 서버(BMC·임베디드)가 그쪽이라 버전에 따라 바이트 수가 달라지는 자리가 몇 군데 있다.

use std::io::{self, Read, Write};

/// 우리가 말하는 버전. 서버가 더 낮은 버전을 말하면 그쪽으로 내려간다.
pub const VERSION_3_8: Version = Version { major: 3, minor: 8 };

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Version {
    pub major: u32,
    pub minor: u32,
}

impl Version {
    /// 3.7 부터 보안 타입을 목록으로 협상한다. 그 이전은 서버가 하나를 통보한다.
    pub fn negotiates_security_list(self) -> bool {
        self.major > 3 || (self.major == 3 && self.minor >= 7)
    }

    /// 3.8 부터는 보안 타입이 None 이어도 SecurityResult 가 온다. 그 이전에는 오지 않는다 —
    /// 기다리면 첫 화면을 받기 전에 멈춘다.
    pub fn sends_security_result_for_none(self) -> bool {
        self.major > 3 || (self.major == 3 && self.minor >= 8)
    }

    /// 3.8 부터 실패 사유가 문자열로 따라온다. 사용자에게 이유를 보여줄 수 있는 유일한 자리다.
    pub fn sends_failure_reason(self) -> bool {
        self.sends_security_result_for_none()
    }
}

/// 보안 타입. 숫자는 IANA RFB 레지스트리 값이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecurityType {
    Invalid,
    None,
    VncAuth,
    /// TLS 위에서 다시 협상한다. 3단계에서 구현한다.
    VeNCrypt,
    /// macOS 화면 공유의 기본 경로(Diffie-Hellman + AES). 2단계에서 구현한다.
    AppleRemoteDesktop,
    /// RealVNC 독자 인증 등 우리가 다룰 수 없는 것. 숫자를 그대로 들고 있다 — 사용자에게
    /// "이 서버는 지원하지 않는 인증을 요구한다" 고 말할 때 근거가 된다.
    Unsupported(u8),
}

impl SecurityType {
    pub fn from_u8(value: u8) -> Self {
        match value {
            0 => Self::Invalid,
            1 => Self::None,
            2 => Self::VncAuth,
            19 => Self::VeNCrypt,
            30 => Self::AppleRemoteDesktop,
            other => Self::Unsupported(other),
        }
    }

    pub fn to_u8(self) -> u8 {
        match self {
            Self::Invalid => 0,
            Self::None => 1,
            Self::VncAuth => 2,
            Self::VeNCrypt => 19,
            Self::AppleRemoteDesktop => 30,
            Self::Unsupported(value) => value,
        }
    }
}

/// 클라이언트 → 서버 메시지 종류.
pub mod client_message {
    pub const SET_PIXEL_FORMAT: u8 = 0;
    pub const SET_ENCODINGS: u8 = 2;
    pub const FRAMEBUFFER_UPDATE_REQUEST: u8 = 3;
    pub const KEY_EVENT: u8 = 4;
    pub const POINTER_EVENT: u8 = 5;
    pub const CLIENT_CUT_TEXT: u8 = 6;
}

/// 서버 → 클라이언트 메시지 종류.
pub mod server_message {
    pub const FRAMEBUFFER_UPDATE: u8 = 0;
    pub const SET_COLOUR_MAP_ENTRIES: u8 = 1;
    pub const BELL: u8 = 2;
    pub const SERVER_CUT_TEXT: u8 = 3;
}

/// 이 단계에서 요청하는 인코딩. 숫자는 RFC 6143 이다.
///
/// Tight·ZRLE·Hextile 은 다음 단계에서 붙인다. 지금 목록에 넣으면 서버가 우리가 풀 수 없는
/// 사각형을 보낸다 — 인코딩 목록은 "우리가 해독할 수 있는 것" 의 선언이다.
pub mod encoding {
    pub const RAW: i32 = 0;
    pub const COPY_RECT: i32 = 1;
    /// 의사 인코딩. 서버가 프레임버퍼 크기 변경을 사각형으로 알려 준다.
    pub const DESKTOP_SIZE: i32 = -223;
}

/// 픽셀 포맷(ServerInit·SetPixelFormat 에 실리는 16바이트).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelFormat {
    pub bits_per_pixel: u8,
    pub depth: u8,
    pub big_endian: bool,
    pub true_colour: bool,
    pub red_max: u16,
    pub green_max: u16,
    pub blue_max: u16,
    pub red_shift: u8,
    pub green_shift: u8,
    pub blue_shift: u8,
}

impl PixelFormat {
    /// 우리가 요구하는 포맷: 메모리 바이트 순서가 R,G,B,X 인 32비트 트루컬러.
    ///
    /// 이걸 맞추면 Raw 사각형이 변환 없이 캔버스로 나간다(렌더러가 RGBA 를 기대한다). 리틀엔디언
    /// 32비트 픽셀에서 첫 바이트가 최하위 비트이므로 red_shift 가 0 이다.
    ///
    /// 네 번째 바이트는 규격상 **정의되지 않은 패딩**이다. 알파로 그대로 쓰면 화면이 통째로
    /// 투명해질 수 있으므로 디코더가 255 를 채운다(decode.rs 참고).
    pub fn rgba32() -> Self {
        Self {
            bits_per_pixel: 32,
            depth: 24,
            big_endian: false,
            true_colour: true,
            red_max: 255,
            green_max: 255,
            blue_max: 255,
            red_shift: 0,
            green_shift: 8,
            blue_shift: 16,
        }
    }

    pub fn bytes_per_pixel(self) -> usize {
        usize::from(self.bits_per_pixel) / 8
    }

    /// 우리가 요구한 그대로인가. 같으면 디코더가 빠른 경로를 탄다.
    pub fn is_rgba32(self) -> bool {
        self == Self::rgba32()
    }

    pub fn parse(bytes: &[u8; 16]) -> Self {
        Self {
            bits_per_pixel: bytes[0],
            depth: bytes[1],
            big_endian: bytes[2] != 0,
            true_colour: bytes[3] != 0,
            red_max: u16::from_be_bytes([bytes[4], bytes[5]]),
            green_max: u16::from_be_bytes([bytes[6], bytes[7]]),
            blue_max: u16::from_be_bytes([bytes[8], bytes[9]]),
            red_shift: bytes[10],
            green_shift: bytes[11],
            blue_shift: bytes[12],
            // [13..16] 은 패딩이다.
        }
    }

    pub fn to_bytes(self) -> [u8; 16] {
        let mut out = [0_u8; 16];
        out[0] = self.bits_per_pixel;
        out[1] = self.depth;
        out[2] = u8::from(self.big_endian);
        out[3] = u8::from(self.true_colour);
        out[4..6].copy_from_slice(&self.red_max.to_be_bytes());
        out[6..8].copy_from_slice(&self.green_max.to_be_bytes());
        out[8..10].copy_from_slice(&self.blue_max.to_be_bytes());
        out[10] = self.red_shift;
        out[11] = self.green_shift;
        out[12] = self.blue_shift;
        out
    }
}

/// ServerInit 이 알려주는 초기 상태.
#[derive(Debug, Clone)]
pub struct ServerInit {
    pub width: u16,
    pub height: u16,
    pub pixel_format: PixelFormat,
    pub name: String,
}

/// 서버가 말한 버전을 읽고, 우리가 쓸 버전을 골라 되돌려준다.
///
/// 서버가 우리보다 높은 버전을 말해도 우리 최고 버전으로 답한다 — 규격이 그렇게 요구한다
/// ("클라이언트는 자기가 지원하는 가장 높은 버전을 보내되 서버 버전을 넘지 않는다").
pub fn negotiate_version(stream: &mut (impl Read + Write)) -> io::Result<Version> {
    let mut banner = [0_u8; 12];
    stream.read_exact(&mut banner)?;
    let server = parse_version_banner(&banner)?;

    let chosen = if server.major == 3 && server.minor < 8 {
        // 3.3 과 3.7 은 실제로 남아 있다. 3.7 이 아닌 것은 3.3 으로 본다 — 그 사이 값을 말하는
        // 서버가 있는데 3.3 이 가장 좁은 공통분모다.
        Version {
            major: 3,
            minor: if server.minor >= 7 { 7 } else { 3 },
        }
    } else {
        VERSION_3_8
    };

    stream.write_all(&version_banner(chosen))?;
    stream.flush()?;
    Ok(chosen)
}

fn parse_version_banner(banner: &[u8; 12]) -> io::Result<Version> {
    // "RFB 003.008\n" 형태다. 숫자 자리만 읽는다.
    let text = std::str::from_utf8(banner)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "RFB 버전 배너가 텍스트가 아니다"))?;
    if !text.starts_with("RFB ") || !text.ends_with('\n') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("RFB 버전 배너가 아니다: {text:?}"),
        ));
    }
    let major = text[4..7]
        .parse::<u32>()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "RFB major 를 읽을 수 없다"))?;
    let minor = text[8..11]
        .parse::<u32>()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "RFB minor 를 읽을 수 없다"))?;
    Ok(Version { major, minor })
}

pub fn version_banner(version: Version) -> [u8; 12] {
    let text = format!("RFB {:03}.{:03}\n", version.major, version.minor);
    let mut out = [0_u8; 12];
    out.copy_from_slice(text.as_bytes());
    out
}

/// 서버가 제시하는 보안 타입 목록을 읽는다.
///
/// 3.7+ 는 개수 + 목록이고, 개수 0 은 거절이며 사유 문자열이 따라온다. 3.3 은 목록 없이 u32 로
/// 하나를 통보한다(그때 0 이면 같은 방식으로 사유가 따라온다).
pub fn read_security_types(
    stream: &mut impl Read,
    version: Version,
) -> io::Result<Vec<SecurityType>> {
    if !version.negotiates_security_list() {
        let mut raw = [0_u8; 4];
        stream.read_exact(&mut raw)?;
        let value = u32::from_be_bytes(raw);
        if value == 0 {
            return Err(rejection_error(stream, version));
        }
        return Ok(vec![SecurityType::from_u8(value as u8)]);
    }

    let mut count = [0_u8; 1];
    stream.read_exact(&mut count)?;
    if count[0] == 0 {
        return Err(rejection_error(stream, version));
    }
    let mut types = vec![0_u8; usize::from(count[0])];
    stream.read_exact(&mut types)?;
    Ok(types.into_iter().map(SecurityType::from_u8).collect())
}

/// 협상이 끝난 뒤의 SecurityResult. 실패 사유가 오면 그것을 오류 문구로 만든다.
pub fn read_security_result(stream: &mut impl Read, version: Version) -> io::Result<()> {
    let mut raw = [0_u8; 4];
    stream.read_exact(&mut raw)?;
    if u32::from_be_bytes(raw) == 0 {
        return Ok(());
    }
    Err(rejection_error(stream, version))
}

/// 서버가 붙인 실패 사유를 읽어 오류로 만든다.
///
/// 사유를 버리면 사용자에게 "붙지 않는다" 밖에 말할 수 없다. 비밀번호가 틀렸는지, 접속이 거부된
/// 것인지는 이 문자열에만 있다.
fn rejection_error(stream: &mut impl Read, version: Version) -> io::Error {
    if !version.sends_failure_reason() {
        return io::Error::new(io::ErrorKind::PermissionDenied, "VNC 서버가 연결을 거부했습니다");
    }
    match read_string(stream) {
        Ok(reason) if !reason.trim().is_empty() => {
            io::Error::new(io::ErrorKind::PermissionDenied, reason)
        }
        _ => io::Error::new(io::ErrorKind::PermissionDenied, "VNC 서버가 연결을 거부했습니다"),
    }
}

/// u32 길이 + 바이트로 된 문자열. RFB 는 인코딩을 정하지 않아 손실 없이 읽는다.
fn read_string(stream: &mut impl Read) -> io::Result<String> {
    let mut raw = [0_u8; 4];
    stream.read_exact(&mut raw)?;
    let length = u32::from_be_bytes(raw);
    // 사유·이름 문자열에 메가바이트가 올 이유가 없다. 이상한 값으로 할당하지 않는다.
    if length > 64 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("문자열 길이가 비정상이다: {length}"),
        ));
    }
    let mut bytes = vec![0_u8; length as usize];
    stream.read_exact(&mut bytes)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// ClientInit. shared 가 false 면 서버가 다른 클라이언트를 끊는다 — 기본은 공유다.
pub fn write_client_init(stream: &mut impl Write, shared: bool) -> io::Result<()> {
    stream.write_all(&[u8::from(shared)])?;
    stream.flush()
}

pub fn read_server_init(stream: &mut impl Read) -> io::Result<ServerInit> {
    let mut head = [0_u8; 20];
    stream.read_exact(&mut head)?;
    let width = u16::from_be_bytes([head[0], head[1]]);
    let height = u16::from_be_bytes([head[2], head[3]]);
    let mut format = [0_u8; 16];
    format.copy_from_slice(&head[4..20]);
    let name = read_string(stream)?;
    Ok(ServerInit {
        width,
        height,
        pixel_format: PixelFormat::parse(&format),
        name,
    })
}

pub fn write_set_pixel_format(stream: &mut impl Write, format: PixelFormat) -> io::Result<()> {
    let mut message = [0_u8; 20];
    message[0] = client_message::SET_PIXEL_FORMAT;
    // [1..4] 는 패딩이다.
    message[4..20].copy_from_slice(&format.to_bytes());
    stream.write_all(&message)?;
    stream.flush()
}

pub fn write_set_encodings(stream: &mut impl Write, encodings: &[i32]) -> io::Result<()> {
    let mut message = Vec::with_capacity(4 + encodings.len() * 4);
    message.push(client_message::SET_ENCODINGS);
    message.push(0); // 패딩
    message.extend_from_slice(&(encodings.len() as u16).to_be_bytes());
    for encoding in encodings {
        message.extend_from_slice(&encoding.to_be_bytes());
    }
    stream.write_all(&message)?;
    stream.flush()
}

/// 화면 갱신 요청.
///
/// `incremental` 이 false 면 그 영역을 전부 다시 보내라는 뜻이다. 처음 한 번과 화면 크기가 바뀐
/// 직후에만 false 로 부르고, 그 밖에는 true 여야 한다 — RFB 는 요청 기반이라 매번 false 로
/// 부르면 서버가 전체 화면을 계속 다시 보낸다.
pub fn write_framebuffer_update_request(
    stream: &mut impl Write,
    incremental: bool,
    x: u16,
    y: u16,
    width: u16,
    height: u16,
) -> io::Result<()> {
    let mut message = [0_u8; 10];
    message[0] = client_message::FRAMEBUFFER_UPDATE_REQUEST;
    message[1] = u8::from(incremental);
    message[2..4].copy_from_slice(&x.to_be_bytes());
    message[4..6].copy_from_slice(&y.to_be_bytes());
    message[6..8].copy_from_slice(&width.to_be_bytes());
    message[8..10].copy_from_slice(&height.to_be_bytes());
    stream.write_all(&message)?;
    stream.flush()
}

/// 키 이벤트. `keysym` 은 **X11 keysym** 이다 — RDP 의 스캔코드와 다른 체계다.
pub fn write_key_event(stream: &mut impl Write, keysym: u32, pressed: bool) -> io::Result<()> {
    let mut message = [0_u8; 8];
    message[0] = client_message::KEY_EVENT;
    message[1] = u8::from(pressed);
    // [2..4] 는 패딩이다.
    message[4..8].copy_from_slice(&keysym.to_be_bytes());
    stream.write_all(&message)?;
    stream.flush()
}

/// 포인터 이벤트. 버튼은 비트마스크이고(1=왼쪽, 2=가운데, 4=오른쪽, 8/16=휠 위·아래),
/// 휠은 눌렀다 떼는 것으로 표현한다.
pub fn write_pointer_event(
    stream: &mut impl Write,
    button_mask: u8,
    x: u16,
    y: u16,
) -> io::Result<()> {
    let mut message = [0_u8; 6];
    message[0] = client_message::POINTER_EVENT;
    message[1] = button_mask;
    message[2..4].copy_from_slice(&x.to_be_bytes());
    message[4..6].copy_from_slice(&y.to_be_bytes());
    stream.write_all(&message)?;
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Pipe {
        input: std::io::Cursor<Vec<u8>>,
        output: Vec<u8>,
    }

    impl Pipe {
        fn new(input: Vec<u8>) -> Self {
            Self {
                input: std::io::Cursor::new(input),
                output: Vec::new(),
            }
        }
    }

    impl Read for Pipe {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.input.read(buf)
        }
    }

    impl Write for Pipe {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.output.write(buf)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn negotiates_the_servers_version_when_it_is_older() {
        let mut pipe = Pipe::new(b"RFB 003.003\n".to_vec());
        let chosen = negotiate_version(&mut pipe).unwrap();
        assert_eq!(chosen, Version { major: 3, minor: 3 });
        assert_eq!(&pipe.output, b"RFB 003.003\n");

        let mut pipe = Pipe::new(b"RFB 003.007\n".to_vec());
        assert_eq!(
            negotiate_version(&mut pipe).unwrap(),
            Version { major: 3, minor: 7 }
        );

        // 서버가 더 높은 버전을 말해도 우리 최고 버전으로 답한다.
        let mut pipe = Pipe::new(b"RFB 004.001\n".to_vec());
        assert_eq!(negotiate_version(&mut pipe).unwrap(), VERSION_3_8);
        assert_eq!(&pipe.output, b"RFB 003.008\n");
    }

    #[test]
    fn rejects_a_banner_that_is_not_rfb() {
        let mut pipe = Pipe::new(b"SSH-2.0-Open".to_vec());
        assert!(negotiate_version(&mut pipe).is_err());
    }

    // 서버가 거절할 때 사유를 그대로 올려야 한다. 이걸 버리면 사용자는 비밀번호가 틀렸는지
    // 접속이 막혔는지 알 방법이 없다.
    #[test]
    fn surfaces_the_servers_rejection_reason() {
        let mut payload = vec![0_u8; 0];
        payload.push(0); // 보안 타입 개수 0 = 거절
        let reason = "too many security failures";
        payload.extend_from_slice(&(reason.len() as u32).to_be_bytes());
        payload.extend_from_slice(reason.as_bytes());

        let mut pipe = Pipe::new(payload);
        let error = read_security_types(&mut pipe, VERSION_3_8).unwrap_err();
        assert_eq!(error.to_string(), reason);
    }

    #[test]
    fn maps_security_types_and_keeps_unknown_numbers() {
        assert_eq!(SecurityType::from_u8(1), SecurityType::None);
        assert_eq!(SecurityType::from_u8(2), SecurityType::VncAuth);
        assert_eq!(SecurityType::from_u8(19), SecurityType::VeNCrypt);
        assert_eq!(SecurityType::from_u8(30), SecurityType::AppleRemoteDesktop);
        // 모르는 번호를 그대로 들고 있어야 "지원하지 않는 인증" 문구에 근거를 담을 수 있다.
        assert_eq!(SecurityType::from_u8(13), SecurityType::Unsupported(13));
        assert_eq!(SecurityType::Unsupported(13).to_u8(), 13);
    }

    #[test]
    fn version_decides_where_extra_bytes_appear() {
        let old = Version { major: 3, minor: 3 };
        assert!(!old.negotiates_security_list());
        assert!(!old.sends_security_result_for_none());
        assert!(VERSION_3_8.negotiates_security_list());
        assert!(VERSION_3_8.sends_security_result_for_none());
        assert!(Version { major: 3, minor: 7 }.negotiates_security_list());
        // 3.7 은 None 일 때 SecurityResult 를 보내지 않는다 — 기다리면 그 자리에서 멈춘다.
        assert!(!Version { major: 3, minor: 7 }.sends_security_result_for_none());
    }

    #[test]
    fn pixel_format_round_trips_through_the_wire_form() {
        let format = PixelFormat::rgba32();
        assert_eq!(PixelFormat::parse(&format.to_bytes()), format);
        assert!(format.is_rgba32());
        assert_eq!(format.bytes_per_pixel(), 4);

        // 첫 바이트가 R 이어야 렌더러가 기대하는 RGBA 와 맞는다.
        assert_eq!(format.red_shift, 0);
        assert_eq!(format.green_shift, 8);
        assert_eq!(format.blue_shift, 16);
        assert!(!format.big_endian);
    }

    #[test]
    fn server_init_carries_size_format_and_name() {
        let mut payload = Vec::new();
        payload.extend_from_slice(&1920_u16.to_be_bytes());
        payload.extend_from_slice(&1080_u16.to_be_bytes());
        payload.extend_from_slice(&PixelFormat::rgba32().to_bytes());
        payload.extend_from_slice(&4_u32.to_be_bytes());
        payload.extend_from_slice(b"lab1");

        let mut pipe = Pipe::new(payload);
        let init = read_server_init(&mut pipe).unwrap();
        assert_eq!((init.width, init.height), (1920, 1080));
        assert!(init.pixel_format.is_rgba32());
        assert_eq!(init.name, "lab1");
    }

    #[test]
    fn client_messages_match_the_wire_layout() {
        let mut pipe = Pipe::new(Vec::new());
        write_framebuffer_update_request(&mut pipe, true, 1, 2, 3, 4).unwrap();
        assert_eq!(pipe.output, vec![3, 1, 0, 1, 0, 2, 0, 3, 0, 4]);

        let mut pipe = Pipe::new(Vec::new());
        write_key_event(&mut pipe, 0xFF0D, true).unwrap();
        assert_eq!(pipe.output, vec![4, 1, 0, 0, 0, 0, 0xFF, 0x0D]);

        let mut pipe = Pipe::new(Vec::new());
        write_pointer_event(&mut pipe, 0b0000_0001, 640, 480).unwrap();
        assert_eq!(pipe.output, vec![5, 1, 2, 128, 1, 224]);

        let mut pipe = Pipe::new(Vec::new());
        write_set_encodings(&mut pipe, &[encoding::RAW, encoding::DESKTOP_SIZE]).unwrap();
        assert_eq!(
            pipe.output,
            vec![2, 0, 0, 2, 0, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0x21]
        );
    }
}
