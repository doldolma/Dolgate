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
///
/// 아직 보내지 않는 것도 표에 남긴다 — 번호 표가 반쪽이면 다음 사람이 규격을 다시 찾아야 한다.
#[allow(dead_code)]
pub mod client_message {
    pub const SET_PIXEL_FORMAT: u8 = 0;
    pub const SET_ENCODINGS: u8 = 2;
    pub const FRAMEBUFFER_UPDATE_REQUEST: u8 = 3;
    pub const KEY_EVENT: u8 = 4;
    pub const POINTER_EVENT: u8 = 5;
    pub const CLIENT_CUT_TEXT: u8 = 6;
    /// 연속 갱신 켜기/끄기. 서버가 `END_OF_CONTINUOUS_UPDATES` 를 **보낸 뒤에만** 보낼 수 있다.
    pub const ENABLE_CONTINUOUS_UPDATES: u8 = 150;
    /// 울타리. 서버가 request 비트를 세워 보낸 것에는 **반드시** 같은 payload 로 답해야 한다 —
    /// 답하지 않으면 서버가 그 울타리를 기다리며 갱신을 멈춘다.
    pub const CLIENT_FENCE: u8 = 248;
    /// QEMU 확장 메시지. 첫 바이트 뒤의 서브메시지로 갈린다(우리는 키 이벤트만 쓴다).
    pub const QEMU: u8 = 255;
    /// 화면 크기 요청. `ExtendedDesktopSize` 를 서버가 쓰는 것을 **본 뒤에만** 보낼 수 있다 —
    /// 모르는 서버는 이 바이트부터 스트림 해석이 어긋난다(RFB 메시지에는 길이 필드가 없다).
    pub const SET_DESKTOP_SIZE: u8 = 251;
}

/// 서버 → 클라이언트 메시지 종류.
pub mod server_message {
    pub const FRAMEBUFFER_UPDATE: u8 = 0;
    pub const SET_COLOUR_MAP_ENTRIES: u8 = 1;
    pub const BELL: u8 = 2;
    pub const SERVER_CUT_TEXT: u8 = 3;
    /// 연속 갱신이 끝났다는 통보. 본문이 없다.
    ///
    /// **처음 받은 것은 "서버가 이 확장을 안다" 는 증거다** — 규격이 목록에서 의사 인코딩을 본
    /// 서버는 이 메시지를 한 번 보내라고 정했다. 그것이 우리가 켜도 되는지 아는 유일한 방법이다.
    pub const END_OF_CONTINUOUS_UPDATES: u8 = 150;
    /// 울타리. 클라이언트 쪽과 같은 번호를 쓴다(방향으로 구분한다).
    pub const SERVER_FENCE: u8 = 248;
}

/// 인코딩 번호. 숫자는 RFC 6143 과 그 뒤의 community 확장이다.
///
/// 목록에 넣는 것은 "우리가 해독할 수 있다" 는 선언이므로, 여기 있는 값을 실제로 처리하지 않으면
/// 서버가 우리가 못 읽는 사각형을 보낸다. Tight·Hextile 은 아직 해독기가 없어 넣지 않는다.
pub mod encoding {
    pub const RAW: i32 = 0;
    pub const COPY_RECT: i32 = 1;
    /// 압축 방법을 사각형마다 고르는 인코딩. TigerVNC 의 기본값이고 ZRLE 보다 더 줄인다
    /// (넓은 단색 면·팔레트·JPEG 를 각각 다르게 처리한다, tight.rs 참고).
    pub const TIGHT: i32 = 7;
    /// zlib + 64x64 타일. 화면 한 장을 Raw 의 몇십 분의 일로 줄인다.
    pub const ZRLE: i32 = 16;
    /// 의사 인코딩. 서버가 프레임버퍼 크기 변경을 사각형으로 알려 준다.
    pub const DESKTOP_SIZE: i32 = -223;
    /// 의사 인코딩. `DESKTOP_SIZE` 의 확장으로, **클라이언트가 크기를 요청**할 수 있게 한다.
    ///
    /// 목록에 넣는 것만으로는 아무 일도 없다. 서버가 지원하면 이 인코딩의 사각형을 보내오고,
    /// 그것이 곧 "이제 SetDesktopSize 를 보내도 된다" 는 신호다.
    pub const EXTENDED_DESKTOP_SIZE: i32 = -308;
    /// 의사 인코딩. 커서 **모양**을 사각형으로 받아 우리가 그린다.
    ///
    /// 이걸 선언하면 서버는 커서를 화면에 그려 보내지 않는다 — 그래서 받은 모양을 실제로 그려야
    /// 한다. 대신 커서가 네트워크 왕복 없이 움직인다.
    pub const CURSOR: i32 = -239;
    /// 의사 인코딩. 울타리 메시지를 주고받을 수 있다는 선언.
    pub const FENCE: i32 = -312;
    /// 의사 인코딩. 요청 없이 서버가 계속 갱신을 보내게 한다.
    pub const CONTINUOUS_UPDATES: i32 = -313;
    /// 의사 인코딩. **스캔코드**로 키를 보낼 수 있다(QEMU 확장 키 이벤트).
    ///
    /// keysym 만으로는 표현할 수 없는 키가 있다 — 한/영·한자 키, 그리고 같은 keysym 에 여러 물리
    /// 키가 걸리는 경우다. 서버가 이 인코딩의 사각형을 보내오면 그때부터 스캔코드를 실어 보낸다.
    pub const QEMU_KEY_EVENT: i32 = -258;
    /// 의사 인코딩. UTF-8 클립보드(clipboard.rs).
    ///
    /// **이 선언이 협상의 시작이다.** 이것을 목록에 넣은 것을 본 서버만 caps 를 보내고, 그 caps 를
    /// 받은 뒤에야 우리가 확장 메시지를 보낼 수 있다. 선언을 빼먹으면 clipboard.rs 전체가 죽은
    /// 코드가 되고 한글이 고전 경로에서 `?` 로 뭉개진다 — 실제로 그런 상태였다.
    ///
    /// **값은 `0xc0a1e5ce` 다.** 다른 의사 인코딩처럼 작은 음수가 아니라서, 줄여 적으면(-1063 을
    /// 넣어 뒀었다) 아무 서버도 알아보지 못하는 번호가 된다 — 선언을 빼먹은 것과 결과가 같아서
    /// 어느 서버에 붙어도 "UTF-8 클립보드 미지원" 으로만 보인다. 눈으로 대조할 수 있게 16진수로 쓴다.
    pub const EXTENDED_CLIPBOARD: i32 = 0xc0a1_e5ceu32 as i32;
}

/// 화질 단계. 서버가 Tight 를 어떻게 쓸지 정한다.
///
/// **무손실이 기본이다.** JPEG 는 사진·영상 영역을 크게 줄이지만 글자가 뭉개진다 — 터미널이나 문서를
/// 보는 세션에서 기본으로 켜면 안 된다. 실제 클라이언트들도 LAN=무손실 / WAN=JPEG 로 갈라 둔다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ImageQuality {
    /// JPEG 를 쓰지 않는다. 서버는 팔레트·그라데이션 같은 무손실 방법만 쓴다.
    #[default]
    Lossless,
    /// 글자가 읽히는 선에서 사진을 줄인다.
    Balanced,
    /// 대역폭을 가장 아낀다. 사진이 눈에 보이게 뭉개진다.
    Fast,
}

impl ImageQuality {
    /// 문자열에서. 데스크톱이 호스트 설정을 그대로 넘긴다.
    pub fn from_name(name: &str) -> Self {
        match name {
            "balanced" => Self::Balanced,
            "fast" => Self::Fast,
            // 모르는 값은 무손실이다 — 옛 설정이나 오타로 화면이 조용히 뭉개지면 안 된다.
            _ => Self::Lossless,
        }
    }

    /// 이 단계가 요구하는 JPEG 품질(0~9). 무손실은 아무것도 선언하지 않는다.
    ///
    /// **선언하지 않으면 서버가 JPEG 를 아예 쓰지 않는다**(TigerVNC 실측: 품질 선언이 없으면
    /// palette·fill 만 온다). 그래서 이 값이 곧 JPEG 스위치다.
    fn jpeg_level(self) -> Option<u8> {
        match self {
            Self::Lossless => None,
            Self::Balanced => Some(8),
            Self::Fast => Some(4),
        }
    }
}

/// 품질 의사 인코딩. 0 이 가장 낮은 품질(-32)이고 9 가 가장 높다(-23).
fn quality_encoding(level: u8) -> i32 {
    -32 + i32::from(level.min(9))
}

/// 이 세션에서 선언할 인코딩 목록.
///
/// 화질 단계에 따라 품질 의사 인코딩이 붙는다. 그 외에는 늘 같다 — 목록이 세션마다 달라지면 어떤
/// 서버가 무엇을 보냈는지 견줄 수 없다.
pub fn client_encodings(quality: ImageQuality) -> Vec<i32> {
    let mut encodings = CLIENT_ENCODINGS.to_vec();
    if let Some(level) = quality.jpeg_level() {
        encodings.push(quality_encoding(level));
    }
    encodings
}

/// 우리가 서버에 선언하는 인코딩 목록.
///
/// **앞이 더 좋다** — 실제 인코딩의 순서가 곧 선호도다. 의사 인코딩은 순서와 무관해서 뒤에 모아
/// 둔다. 상수로 빼 둔 이유는 테스트가 이 목록을 볼 수 있어야 하기 때문이다: 인라인 배열이었을 때
/// 확장 클립보드 선언이 빠진 것을 아무 테스트도 잡지 못했다.
pub const CLIENT_ENCODINGS: &[i32] = &[
    encoding::COPY_RECT,
    encoding::TIGHT,
    encoding::ZRLE,
    encoding::RAW,
    encoding::CURSOR,
    encoding::QEMU_KEY_EVENT,
    encoding::DESKTOP_SIZE,
    encoding::EXTENDED_DESKTOP_SIZE,
    encoding::FENCE,
    encoding::CONTINUOUS_UPDATES,
    encoding::EXTENDED_CLIPBOARD,
];

/// 울타리 메시지의 flags.
///
/// 우리는 답할 때 아무 비트도 세우지 않는다(`write_client_fence` 주석 참고). 표는 받은 값을 로그로
/// 읽을 때 쓴다.
#[allow(dead_code)]
pub mod fence_flag {
    pub const BLOCK_BEFORE: u32 = 1;
    pub const BLOCK_AFTER: u32 = 1 << 1;
    pub const SYNC_NEXT: u32 = 1 << 2;
    /// 이 비트가 서 있으면 **답해야 한다**.
    pub const REQUEST: u32 = 1 << 31;
}

/// `ExtendedDesktopSize` 사각형의 `x` 자리에 오는 이유 코드.
///
/// 지금 쓰지 않는 값도 표에 남긴다 — 번호 표가 반쪽이면 다음 사람이 규격을 다시 찾아야 한다
/// (client_message 와 같은 이유).
#[allow(dead_code)]
pub mod desktop_size_reason {
    /// 서버 쪽 사정으로 바뀌었다(또는 최초 통보).
    pub const SERVER: u16 = 0;
    /// 이 클라이언트가 요청한 결과다. `result` 를 봐야 성공인지 알 수 있다.
    pub const THIS_CLIENT: u16 = 1;
    /// 다른 클라이언트가 요청해서 바뀌었다.
    pub const OTHER_CLIENT: u16 = 2;
}

/// 우리 요청에 대한 결과 코드(`y` 자리). 0 이 아니면 화면은 그대로다.
pub fn describe_desktop_size_result(result: u16) -> &'static str {
    match result {
        0 => "성공",
        1 => "서버가 크기 변경을 허용하지 않습니다",
        2 => "서버 자원이 부족합니다",
        3 => "요청한 화면 배치가 올바르지 않습니다",
        4 => "요청이 다른 곳으로 전달되었습니다",
        _ => "알 수 없는 결과",
    }
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

/// QEMU 확장 키 이벤트. keysym 과 **스캔코드**를 함께 보낸다.
///
/// 스캔코드는 PS/2 set 1(XT) 이다 — RDP 가 쓰는 것과 같은 체계라 렌더러의 표를 그대로 쓴다.
/// 서버는 스캔코드를 우선으로 보고, 0 이면 keysym 으로 되돌아간다.
///
/// **서버가 이 확장의 사각형을 보낸 뒤에만 부른다.** 모르는 서버는 이 바이트부터 스트림 해석이
/// 어긋난다(RFB 메시지에는 길이 필드가 없다).
pub fn write_qemu_key_event(
    stream: &mut impl Write,
    keysym: u32,
    keycode: u32,
    pressed: bool,
) -> io::Result<()> {
    let mut message = [0_u8; 12];
    message[0] = client_message::QEMU;
    message[1] = 0; // 서브메시지 0 = 확장 키 이벤트
    message[2..4].copy_from_slice(&u16::from(pressed).to_be_bytes());
    message[4..8].copy_from_slice(&keysym.to_be_bytes());
    message[8..12].copy_from_slice(&keycode.to_be_bytes());
    stream.write_all(&message)?;
    stream.flush()
}

/// 연속 갱신을 켜거나 끈다.
///
/// 켜면 서버가 `FramebufferUpdateRequest` 없이도 바뀐 곳을 계속 보낸다 — 갱신 하나마다 요청을
/// 한 번 왕복하던 것이 사라진다. 끄면 서버가 `EndOfContinuousUpdates` 로 답한다.
///
/// **서버가 그 메시지를 보낸 것을 본 뒤에만 부른다.** 모르는 서버는 이 바이트부터 스트림 해석이
/// 어긋난다(RFB 메시지에는 길이 필드가 없다).
pub fn write_enable_continuous_updates(
    stream: &mut impl Write,
    enable: bool,
    x: u16,
    y: u16,
    width: u16,
    height: u16,
) -> io::Result<()> {
    let mut message = [0_u8; 10];
    message[0] = client_message::ENABLE_CONTINUOUS_UPDATES;
    message[1] = u8::from(enable);
    message[2..4].copy_from_slice(&x.to_be_bytes());
    message[4..6].copy_from_slice(&y.to_be_bytes());
    message[6..8].copy_from_slice(&width.to_be_bytes());
    message[8..10].copy_from_slice(&height.to_be_bytes());
    stream.write_all(&message)?;
    stream.flush()
}

/// 울타리 본문 최대 길이. 규격이 정한 값이다.
pub const FENCE_MAX_PAYLOAD: usize = 64;

/// 울타리를 보낸다. 서버가 request 비트를 세워 보낸 것에 답하는 자리다.
///
/// **flags 는 0 으로 답한다.** 울타리의 flags 는 "이 지점 앞/뒤를 갈라서 처리하겠다" 는 약속인데,
/// 우리는 메시지를 한 줄로 순서대로 처리할 뿐 그런 경계를 만들 수단이 없다. 지키지 못할 약속을
/// 돌려주는 것보다 아무 비트도 세우지 않는 것이 규격에 맞다(다른 클라이언트들도 그렇게 한다).
/// payload 는 서버가 자기 것을 알아보는 표식이므로 **그대로** 돌려줘야 한다.
pub fn write_client_fence(stream: &mut impl Write, flags: u32, payload: &[u8]) -> io::Result<()> {
    if payload.len() > FENCE_MAX_PAYLOAD {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "울타리 본문이 64바이트를 넘습니다",
        ));
    }
    let mut message = Vec::with_capacity(9 + payload.len());
    message.push(client_message::CLIENT_FENCE);
    message.extend_from_slice(&[0, 0, 0]); // 패딩
    message.extend_from_slice(&flags.to_be_bytes());
    message.push(payload.len() as u8);
    message.extend_from_slice(payload);
    stream.write_all(&message)?;
    stream.flush()
}

/// 울타리를 읽는다(종류 한 바이트는 호출부가 이미 읽었다).
///
/// 본문을 끝까지 읽는 것이 답하는 것보다 중요하다 — 남기면 다음 메시지 경계가 어긋나 세션이
/// 통째로 깨진다.
pub fn read_fence(stream: &mut impl Read) -> io::Result<(u32, Vec<u8>)> {
    let mut head = [0_u8; 8];
    stream.read_exact(&mut head)?;
    let flags = u32::from_be_bytes([head[3], head[4], head[5], head[6]]);
    let length = usize::from(head[7]);
    if length > FENCE_MAX_PAYLOAD {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("울타리 본문 길이가 비정상입니다({length})"),
        ));
    }
    let mut payload = vec![0_u8; length];
    stream.read_exact(&mut payload)?;
    Ok((flags, payload))
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

/// 로컬 클립보드를 원격에 알린다(ClientCutText).
///
/// **latin-1 만 실을 수 있다.** RFB 3.3 의 이 메시지는 바이트 하나 = 문자 하나이고, 규격이
/// ISO 8859-1 로 못 박아 뒀다. UTF-8 은 `ExtendedClipboard` 의사 인코딩이 있어야 한다.
///
/// 그래서 latin-1 로 옮길 수 없는 문자는 `?` 로 바꾼다. 통째로 안 보내는 쪽도 생각할 수 있는데,
/// 그러면 한글이 섞인 문단을 복사할 때 **아무 일도 일어나지 않아** 사용자가 원인을 알 수 없다.
/// 일부라도 붙는 편이 낫다.
///
/// 줄바꿈은 LF 로 맞춘다 — 규격이 CR 을 쓰지 말라고 정해 두었고, CRLF 를 그대로 보내면 원격
/// 편집기에서 빈 줄이나 `^M` 으로 보인다.
pub fn write_client_cut_text(stream: &mut impl Write, text: &str) -> io::Result<()> {
    let body = to_latin1_clipboard(text);
    let mut message = Vec::with_capacity(8 + body.len());
    message.push(client_message::CLIENT_CUT_TEXT);
    message.extend_from_slice(&[0, 0, 0]); // 패딩
    message.extend_from_slice(&(body.len() as u32).to_be_bytes());
    message.extend_from_slice(&body);
    stream.write_all(&message)?;
    stream.flush()
}

/// `ExtendedDesktopSize` 사각형이 **실제 크기 변경**인가.
///
/// 세 경우를 가른다:
///
/// - **거부**(우리 요청 + 0 아닌 결과): 화면은 그대로다. 바꾸면 안 된다.
/// - **통보**(크기가 지금과 같음): 서버는 전체 갱신을 요청받을 때마다 이 사각형을 다시 보낸다.
///   이것을 변경으로 보면 화면을 지우고 전체를 다시 요청하는 무한 루프가 된다 — 픽셀을 한 장도
///   처리하지 못해 검은 화면으로 남는다(실측으로 겪었다).
/// - **변경**: 크기가 다르다. 이때만 프레임버퍼를 다시 만든다.
pub fn is_desktop_resize(
    rect_size: (u16, u16),
    current_size: (u16, u16),
    reason: u16,
    result: u16,
) -> bool {
    if reason == desktop_size_reason::THIS_CLIENT && result != 0 {
        return false;
    }
    rect_size != current_size
}

/// 화면 크기를 요청한다(SetDesktopSize).
///
/// **화면 배치를 함께 보내야 한다.** 규격이 "폭·높이" 만으로는 요청을 받지 않는다 — 여러 화면을
/// 다루는 메시지라 화면 목록이 본문이다. 우리는 한 화면만 쓰므로 서버가 알려 준 첫 화면의 id 를
/// 그대로 재사용하고 위치를 (0,0) 으로 둔다. **id 를 새로 만들면 서버가 "화면을 추가하라" 는
/// 요청으로 읽어 거부한다.**
///
/// 보내기 전에 서버가 `EXTENDED_DESKTOP_SIZE` 를 쓰는 것을 봤어야 한다(호출부가 확인한다).
pub fn write_set_desktop_size(
    stream: &mut impl Write,
    width: u16,
    height: u16,
    screen_id: u32,
) -> io::Result<()> {
    let mut message = Vec::with_capacity(24);
    message.push(client_message::SET_DESKTOP_SIZE);
    message.push(0); // 패딩
    message.extend_from_slice(&width.to_be_bytes());
    message.extend_from_slice(&height.to_be_bytes());
    message.push(1); // 화면 수
    message.push(0); // 패딩
    // 화면 하나: id, x, y, 폭, 높이, flags
    message.extend_from_slice(&screen_id.to_be_bytes());
    message.extend_from_slice(&0_u16.to_be_bytes());
    message.extend_from_slice(&0_u16.to_be_bytes());
    message.extend_from_slice(&width.to_be_bytes());
    message.extend_from_slice(&height.to_be_bytes());
    message.extend_from_slice(&0_u32.to_be_bytes()); // flags 는 예약이다
    stream.write_all(&message)?;
    stream.flush()
}

/// `ExtendedDesktopSize` 사각형 본문에서 첫 화면의 id 를 뽑는다.
///
/// 본문은 `화면 수(1) + 패딩(3) + 화면마다 16바이트` 다. id 가 필요한 이유는 위 주석과 같다 —
/// 우리 요청이 "있는 화면의 크기 변경" 으로 읽히려면 그 id 를 되돌려줘야 한다.
///
/// 화면이 없다고 하면(0개) `None`. 그때는 크기 요청을 보내지 않는다 — 어떤 id 를 쓸지 알 수 없다.
pub fn first_screen_id(body: &[u8]) -> Option<u32> {
    let count = *body.first()?;
    if count == 0 || body.len() < 4 + 16 {
        return None;
    }
    Some(u32::from_be_bytes([body[4], body[5], body[6], body[7]]))
}

/// 확장 클립보드 메시지를 보낸다(CutText, **길이를 음수로**).
///
/// 음수 길이가 곧 "확장 메시지" 라는 표시다. 확장을 모르는 상대는 이 값을 거대한 u32 로 읽고
/// 스트림이 깨지므로, **상대의 caps 를 본 뒤에만** 불러야 한다(호출부가 확인한다).
pub fn write_client_cut_text_extended(stream: &mut impl Write, body: &[u8]) -> io::Result<()> {
    let mut message = Vec::with_capacity(8 + body.len());
    message.push(client_message::CLIENT_CUT_TEXT);
    message.extend_from_slice(&[0, 0, 0]); // 패딩
    // 길이 = -(본문 크기)
    message.extend_from_slice(&(-(body.len() as i32)).to_be_bytes());
    message.extend_from_slice(body);
    stream.write_all(&message)?;
    stream.flush()
}

/// 클립보드 텍스트를 latin-1 바이트로. 옮길 수 없는 문자는 `?`.
/// latin-1 로 담을 수 없어 `?` 가 된 글자 수를 센다.
///
/// 이걸 세지 않으면 한글 복사가 **조용히** 망가진다 — 사용자는 원격에 `?` 가 붙는 것만 보고 이유를
/// 알 수 없다. 서버가 UTF-8 확장을 지원하지 않을 때 우리가 할 수 있는 일은 알리는 것뿐이다.
pub fn count_latin1_losses(text: &str) -> usize {
    text.chars()
        .filter(|character| u32::from(*character) > 0xFF)
        .count()
}

fn to_latin1_clipboard(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        match character {
            // CRLF 는 LF 하나로. 홀로 온 CR 도 LF 로 바꾼다(옛 맥 줄바꿈).
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push(b'\n');
            }
            _ => {
                let code = u32::from(character);
                out.push(if code <= 0xFF { code as u8 } else { b'?' });
            }
        }
    }
    out
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

    /// 선언 목록은 **협상의 시작점**이라 빠진 항목을 다른 방법으로는 알 수 없다.
    ///
    /// 확장 클립보드가 실제로 이렇게 빠져 있었다. 서버는 이 선언을 본 뒤에만 caps 를 보내므로,
    /// 선언이 없으면 clipboard.rs 가 한 줄도 실행되지 않는데 컴파일도 테스트도 통과한다.
    /// 의사 인코딩 번호를 규격 값에 못박는다.
    ///
    /// 목록에 들어 있는지만 보면 **번호가 틀려도 통과한다.** 확장 클립보드가 실제로 그랬다:
    /// `-1063` 이 들어가 있어서(규격은 `0xc0a1e5ce`) 선언은 나가는데 어느 서버도 알아보지
    /// 못했고, 모든 서버가 UTF-8 미지원으로만 보였다 — 맥·리눅스·TigerVNC 전부.
    ///
    /// 그래서 목록 여부와 별개로 값 자체를 대조한다. 다른 확장도 같은 방식으로 틀릴 수 있어
    /// 함께 적어 둔다(출처: RFB 규격 / TigerVNC rfbproto.h).
    #[test]
    fn pseudo_encoding_numbers_match_the_spec() {
        assert_eq!(encoding::EXTENDED_CLIPBOARD, 0xc0a1_e5ceu32 as i32);
        assert_eq!(encoding::EXTENDED_CLIPBOARD, -1_063_131_698);
        assert_eq!(encoding::CURSOR, -239);
        assert_eq!(encoding::DESKTOP_SIZE, -223);
        assert_eq!(encoding::EXTENDED_DESKTOP_SIZE, -308);
        assert_eq!(encoding::FENCE, -312);
        assert_eq!(encoding::CONTINUOUS_UPDATES, -313);
        assert_eq!(encoding::QEMU_KEY_EVENT, -258);
    }

    /// 선언이 실제로 바이트로 나가는지.
    ///
    /// 상수만 맞아도 SetEncodings 에 안 실리면 의미가 없다 — 그 메시지를 그대로 읽어 확인한다.
    #[test]
    fn set_encodings_carries_the_extended_clipboard_number() {
        let mut wire = Vec::new();
        write_set_encodings(&mut wire, &client_encodings(ImageQuality::default())).unwrap();
        let spec = (0xc0a1_e5ceu32).to_be_bytes();
        assert!(
            wire.windows(4).any(|chunk| chunk == spec),
            "SetEncodings 에 0xc0a1e5ce 가 없다 — 서버는 caps 를 보내지 않는다"
        );
    }

    #[test]
    fn declares_every_extension_we_implement() {
        for (value, name) in [
            (encoding::EXTENDED_CLIPBOARD, "확장 클립보드"),
            (encoding::CURSOR, "커서"),
            (encoding::FENCE, "울타리"),
            (encoding::CONTINUOUS_UPDATES, "연속 갱신"),
            (encoding::EXTENDED_DESKTOP_SIZE, "확장 화면 크기"),
            (encoding::QEMU_KEY_EVENT, "QEMU 확장 키"),
        ] {
            assert!(
                CLIENT_ENCODINGS.contains(&value),
                "{name}({value}) 를 서버에 선언하지 않으면 그 확장은 절대 켜지지 않는다"
            );
        }
        // 해독기가 없는 것을 선언하면 서버가 우리가 못 읽는 사각형을 보낸다.
        assert!(!CLIENT_ENCODINGS.contains(&5), "Hextile 은 해독기가 없다");
        // 순서가 곧 선호도다. Tight 가 ZRLE 보다 앞이어야 서버가 Tight 를 고른다.
        let tight = CLIENT_ENCODINGS
            .iter()
            .position(|value| *value == encoding::TIGHT);
        let zrle = CLIENT_ENCODINGS
            .iter()
            .position(|value| *value == encoding::ZRLE);
        assert!(tight.is_some() && tight < zrle, "Tight 가 ZRLE 보다 앞이어야 한다");
    }

    #[test]
    fn declares_a_quality_level_only_when_asked() {
        // 품질을 선언하지 않으면 서버가 JPEG 를 쓰지 않는다(TigerVNC 실측). 그래서 이 선언이 곧
        // JPEG 스위치이고, 기본은 꺼짐이어야 한다 — 글자가 뭉개지면 안 된다.
        let lossless = client_encodings(ImageQuality::Lossless);
        assert_eq!(lossless, CLIENT_ENCODINGS.to_vec());
        assert!(!lossless.iter().any(|value| (-32..=-23).contains(value)));

        // 품질 8 = -24, 품질 4 = -28.
        assert!(client_encodings(ImageQuality::Balanced).contains(&-24));
        assert!(client_encodings(ImageQuality::Fast).contains(&-28));
        // 화질 단계와 무관하게 나머지 선언은 그대로다.
        assert!(client_encodings(ImageQuality::Fast).contains(&encoding::TIGHT));
    }

    #[test]
    fn falls_back_to_lossless_for_unknown_names() {
        // 옛 설정이나 오타로 화면이 조용히 뭉개지면 안 된다.
        assert_eq!(ImageQuality::from_name(""), ImageQuality::Lossless);
        assert_eq!(ImageQuality::from_name("high"), ImageQuality::Lossless);
        assert_eq!(ImageQuality::from_name("balanced"), ImageQuality::Balanced);
        assert_eq!(ImageQuality::from_name("fast"), ImageQuality::Fast);
    }

    #[test]
    fn writes_a_qemu_key_event_with_the_scancode() {
        let mut pipe = Pipe::new(Vec::new());
        // Enter: keysym 0xFF0D, 스캔코드 0x1C.
        write_qemu_key_event(&mut pipe, 0xFF0D, 0x1C, true).unwrap();
        assert_eq!(
            pipe.output,
            vec![255, 0, 0, 1, 0, 0, 0xFF, 0x0D, 0, 0, 0, 0x1C]
        );

        let mut pipe = Pipe::new(Vec::new());
        write_qemu_key_event(&mut pipe, 0xFF0D, 0x1C, false).unwrap();
        assert_eq!(pipe.output[2..4], [0, 0], "떼는 이벤트는 down 이 0 이다");
    }

    #[test]
    fn writes_enable_continuous_updates() {
        let mut pipe = Pipe::new(Vec::new());
        write_enable_continuous_updates(&mut pipe, true, 0, 0, 1024, 768).unwrap();
        assert_eq!(pipe.output, vec![150, 1, 0, 0, 0, 0, 4, 0, 3, 0]);
    }

    #[test]
    fn echoes_a_fence_payload_without_claiming_any_flag() {
        // 서버가 request 비트를 세워 보낸 것을 읽고 그대로 되돌려 준다.
        let mut server = Vec::new();
        server.extend_from_slice(&[0, 0, 0]); // 패딩
        server.extend_from_slice(&(fence_flag::REQUEST | fence_flag::BLOCK_AFTER).to_be_bytes());
        server.push(4);
        server.extend_from_slice(b"abcd");

        let mut pipe = Pipe::new(server);
        let (flags, payload) = read_fence(&mut pipe).unwrap();
        assert_eq!(flags & fence_flag::REQUEST, fence_flag::REQUEST);
        assert_eq!(payload, b"abcd");

        write_client_fence(&mut pipe, 0, &payload).unwrap();
        assert_eq!(pipe.output, vec![248, 0, 0, 0, 0, 0, 0, 0, 4, b'a', b'b', b'c', b'd']);
    }

    #[test]
    fn refuses_an_oversized_fence_payload() {
        // 규격 한도를 넘겨 보내면 상대가 길이 바이트를 잘못 읽어 스트림이 깨진다.
        let mut pipe = Pipe::new(Vec::new());
        assert!(write_client_fence(&mut pipe, 0, &[0_u8; 65]).is_err());
        assert!(pipe.output.is_empty());
    }
}

#[cfg(test)]
mod clipboard_tests {
    use super::*;

    #[test]
    fn writes_the_client_cut_text_header_and_body() {
        let mut out = Vec::new();
        write_client_cut_text(&mut out, "hi").unwrap();

        // 종류(6) + 패딩 3 + 길이 4 + 본문
        assert_eq!(out, vec![6, 0, 0, 0, 0, 0, 0, 2, b'h', b'i']);
    }

    #[test]
    fn folds_crlf_to_lf() {
        // 규격이 CR 을 쓰지 말라고 정해 뒀다. 그대로 보내면 원격 편집기에 ^M 으로 보인다.
        assert_eq!(to_latin1_clipboard("a\r\nb\rc\nd"), b"a\nb\nc\nd".to_vec());
    }

    #[test]
    fn replaces_characters_latin1_cannot_carry() {
        // 한글은 이 메시지로 보낼 수 없다(ExtendedClipboard 가 있어야 한다). 통째로 버리면
        // 사용자에게는 "복사가 안 된다" 로만 보이므로, 옮길 수 있는 부분은 살린다.
        assert_eq!(to_latin1_clipboard("a한b"), b"a?b".to_vec());
        // latin-1 범위(0xE9 = é)는 그대로 간다.
        assert_eq!(to_latin1_clipboard("café"), vec![b'c', b'a', b'f', 0xE9]);
    }

    #[test]
    fn sends_an_empty_body_for_an_empty_clipboard() {
        // 길이 0 도 유효한 메시지다. 여기서 빼먹으면 "지웠다" 를 전할 방법이 없다.
        let mut out = Vec::new();
        write_client_cut_text(&mut out, "").unwrap();
        assert_eq!(out, vec![6, 0, 0, 0, 0, 0, 0, 0]);
    }
}

#[cfg(test)]
mod desktop_size_tests {
    use super::*;

    #[test]
    fn writes_a_single_screen_layout() {
        let mut out = Vec::new();
        write_set_desktop_size(&mut out, 1280, 800, 0x11223344).unwrap();

        assert_eq!(
            out,
            vec![
                251, 0, // 종류 + 패딩
                0x05, 0x00, // 폭 1280
                0x03, 0x20, // 높이 800
                1, 0, // 화면 수 + 패딩
                0x11, 0x22, 0x33, 0x44, // id
                0, 0, // x
                0, 0, // y
                0x05, 0x00, // 폭
                0x03, 0x20, // 높이
                0, 0, 0, 0, // flags
            ]
        );
    }

    #[test]
    fn reuses_the_id_the_server_gave_us() {
        // 서버가 알려 준 화면 id 를 그대로 되돌려야 "있는 화면의 크기 변경" 으로 읽힌다. 새 id 를
        // 만들면 "화면 추가" 요청이 되어 거부된다.
        let body = vec![
            1, 0, 0, 0, // 화면 수 + 패딩
            0xDE, 0xAD, 0xBE, 0xEF, // id
            0, 0, 0, 0, 0x05, 0x00, 0x03, 0x20, 0, 0, 0, 0,
        ];
        assert_eq!(first_screen_id(&body), Some(0xDEADBEEF));
    }

    #[test]
    fn refuses_a_layout_without_screens() {
        // 화면이 0개면 어떤 id 를 실을지 알 수 없다. 그때는 크기 요청을 보내지 않아야 한다.
        assert_eq!(first_screen_id(&[0, 0, 0, 0]), None);
        // 본문이 잘려 온 경우도 같다.
        assert_eq!(first_screen_id(&[1, 0, 0, 0, 0xDE, 0xAD]), None);
        assert_eq!(first_screen_id(&[]), None);
    }

    #[test]
    fn names_every_result_code() {
        // 거부 이유를 사용자에게 그대로 보여준다. 빠뜨리면 "알 수 없는 결과" 로만 남는다.
        for result in 0..=4_u16 {
            assert_ne!(describe_desktop_size_result(result), "알 수 없는 결과");
        }
        assert_eq!(describe_desktop_size_result(9), "알 수 없는 결과");
    }
}

#[cfg(test)]
mod desktop_resize_decision_tests {
    use super::*;

    #[test]
    fn a_repeat_of_the_current_size_is_not_a_resize() {
        // 서버는 전체 갱신 요청마다 이 사각형을 다시 보낸다. 변경으로 보면 화면을 지우고 전체를
        // 다시 요청하는 무한 루프가 된다 — 실제로 그렇게 검은 화면이 됐다.
        assert!(!is_desktop_resize((1280, 800), (1280, 800), 0, 0));
        assert!(!is_desktop_resize((1280, 800), (1280, 800), 2, 0));
    }

    #[test]
    fn a_different_size_is_a_resize() {
        assert!(is_desktop_resize((1600, 900), (1280, 800), 0, 0));
        // 우리 요청이 성공한 경우도 변경이다.
        assert!(is_desktop_resize((1600, 900), (1280, 800), 1, 0));
    }

    #[test]
    fn a_refusal_never_resizes() {
        // 거부되면 화면은 그대로다. 사각형에 실린 크기를 믿고 바꾸면 실제 화면과 어긋난다.
        for result in 1..=4_u16 {
            assert!(!is_desktop_resize((1600, 900), (1280, 800), 1, result));
        }
    }
}
