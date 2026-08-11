//! VeNCrypt(보안 타입 19) 협상.
//!
//! VeNCrypt 은 인증 방식이 아니라 **인증을 감싸는 층**이다. 서브타입을 하나 골라 TLS 를 세운 뒤,
//! 그 안에서 다시 None·VncAuth·Plain 중 하나로 인증한다.
//!
//! 바이트 순서(0.2):
//!
//! ```text
//! 서버 → 버전 2바이트 (major, minor)
//! 클라 → 쓸 버전 2바이트
//! 서버 → ack 1바이트 (0 = 이 버전으로는 못 한다)
//! 서버 → 서브타입 개수 1바이트, 이어서 u32 × 개수
//! 클라 → 고른 서브타입 u32
//! 서버 → ack 1바이트 (1 = 계속)   ← 실측으로 확인했다
//! 이후 TLS 핸드셰이크(클라이언트가 먼저 ClientHello 를 보낸다)
//! ```
//!
//! **마지막 ack 를 TLS 스트림으로 오해하면 안 된다.** 그 1바이트를 안 읽고 TLS 를 시작하면
//! 핸드셰이크가 `WRONG_VERSION_NUMBER` 로 깨진다(실제로 그렇게 한 번 틀렸다).
//!
//! **TLS 계열과 X509 계열은 필요한 TLS 스택이 다르다.** `TLS*` 는 인증서 없이 익명 DH 로 붙으므로
//! 익명 암호군을 지원하는 스택이 필요하고, rustls 는 그것을 의도적으로 넣지 않았다. `X509*` 는
//! 보통의 인증서 기반이라 rustls 로 된다(신뢰 판정은 RDP 의 지문 고정과 같은 모델을 쓰면 된다).
//! 그래서 이 모듈은 협상까지만 하고, 세울 수 있는 스택이 없으면 **무엇을 요구했는지 이름으로**
//! 알리고 멈춘다.

use std::io::{self, Read, Write};

/// 우리가 말하는 VeNCrypt 버전.
pub const VERSION: (u8, u8) = (0, 2);

/// VeNCrypt 서브타입. 숫자는 VeNCrypt 규격 값이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubType {
    /// TLS 없이 사용자 이름+비밀번호를 평문으로 보낸다. 쓰지 않는다.
    Plain,
    TlsNone,
    TlsVnc,
    TlsPlain,
    X509None,
    X509Vnc,
    X509Plain,
    TlsSasl,
    X509Sasl,
    Unknown(u32),
}

impl SubType {
    pub fn from_u32(value: u32) -> Self {
        match value {
            256 => Self::Plain,
            257 => Self::TlsNone,
            258 => Self::TlsVnc,
            259 => Self::TlsPlain,
            260 => Self::X509None,
            261 => Self::X509Vnc,
            262 => Self::X509Plain,
            263 => Self::TlsSasl,
            264 => Self::X509Sasl,
            other => Self::Unknown(other),
        }
    }

    pub fn to_u32(self) -> u32 {
        match self {
            Self::Plain => 256,
            Self::TlsNone => 257,
            Self::TlsVnc => 258,
            Self::TlsPlain => 259,
            Self::X509None => 260,
            Self::X509Vnc => 261,
            Self::X509Plain => 262,
            Self::TlsSasl => 263,
            Self::X509Sasl => 264,
            Self::Unknown(value) => value,
        }
    }

    /// 인증서 없이 익명 DH 로 TLS 를 세우는 계열인가.
    pub fn is_anonymous_tls(self) -> bool {
        matches!(self, Self::TlsNone | Self::TlsVnc | Self::TlsPlain | Self::TlsSasl)
    }

    /// 인증서 기반 TLS 계열인가.
    pub fn is_certificate_tls(self) -> bool {
        matches!(
            self,
            Self::X509None | Self::X509Vnc | Self::X509Plain | Self::X509Sasl
        )
    }

    /// 사람이 읽을 이름. 오류 문구에 그대로 쓴다 — 사용자가 서버 설정을 찾아갈 단어여야 한다.
    pub fn label(self) -> String {
        match self {
            Self::Plain => "Plain(평문)".to_owned(),
            Self::TlsNone => "TLSNone".to_owned(),
            Self::TlsVnc => "TLSVnc".to_owned(),
            Self::TlsPlain => "TLSPlain".to_owned(),
            Self::X509None => "X509None".to_owned(),
            Self::X509Vnc => "X509Vnc".to_owned(),
            Self::X509Plain => "X509Plain".to_owned(),
            Self::TlsSasl => "TLSSASL".to_owned(),
            Self::X509Sasl => "X509SASL".to_owned(),
            Self::Unknown(value) => format!("알 수 없는 방식({value})"),
        }
    }
}

/// 서버가 제시한 서브타입 목록을 읽는다. 버전 합의까지 마친 상태로 돌려준다.
pub fn negotiate(stream: &mut (impl Read + Write)) -> io::Result<Vec<SubType>> {
    let mut version = [0_u8; 2];
    stream.read_exact(&mut version)?;
    // 서버가 더 높은 버전을 말해도 우리가 아는 최고 버전으로 답한다. 더 낮으면 그쪽으로 맞춘다.
    let chosen = if (version[0], version[1]) < VERSION {
        (version[0], version[1])
    } else {
        VERSION
    };
    stream.write_all(&[chosen.0, chosen.1])?;
    stream.flush()?;

    let mut ack = [0_u8; 1];
    stream.read_exact(&mut ack)?;
    if ack[0] != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "서버가 VeNCrypt {}.{} 를 거절했습니다",
                chosen.0, chosen.1
            ),
        ));
    }

    let mut count = [0_u8; 1];
    stream.read_exact(&mut count)?;
    if count[0] == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "서버가 VeNCrypt 인증 방식을 하나도 제시하지 않았습니다",
        ));
    }
    let mut raw = vec![0_u8; usize::from(count[0]) * 4];
    stream.read_exact(&mut raw)?;
    Ok(raw
        .chunks_exact(4)
        .map(|bytes| SubType::from_u32(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])))
        .collect())
}

/// 서브타입을 고르고 서버의 계속 신호를 받는다.
///
/// 마지막 1바이트가 0 이면 서버가 거절한 것이다. 그 바이트를 읽지 않고 TLS 를 시작하면 핸드셰이크가
/// 깨지므로 여기서 반드시 소비한다.
pub fn select(stream: &mut (impl Read + Write), subtype: SubType) -> io::Result<()> {
    stream.write_all(&subtype.to_u32().to_be_bytes())?;
    stream.flush()?;
    let mut ack = [0_u8; 1];
    stream.read_exact(&mut ack)?;
    if ack[0] == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("서버가 {} 방식을 거절했습니다", subtype.label()),
        ));
    }
    Ok(())
}

/// 아직 세울 수 없는 서브타입뿐일 때 사용자에게 보일 문구.
///
/// **무엇을 요구했는지 이름으로 말한다.** "붙지 않는다" 만 말하면 서버 설정을 어떻게 바꿔야 할지
/// 알 수 없다 — TLSVnc 인지 X509Vnc 인지에 따라 할 일이 다르다.
pub fn describe_unsupported(offered: &[SubType]) -> String {
    let names: Vec<String> = offered.iter().map(|subtype| subtype.label()).collect();
    let anonymous = offered.iter().any(|subtype| subtype.is_anonymous_tls());
    let mut message = format!(
        "이 서버의 VeNCrypt 방식을 아직 지원하지 않습니다: {}",
        names.join(", ")
    );
    if anonymous {
        // 사용자가 실제로 할 수 있는 일을 적는다. 서버에 X509 인증서를 붙이면 지금 스택으로 붙는다.
        message.push_str(
            " — TLS 계열은 인증서 없이 익명 DH 로 붙는 방식이라 지원 준비가 필요합니다. \
             서버에 X509 인증서를 설정하면(X509Vnc) 붙을 수 있습니다",
        );
    }
    message
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Pipe {
        input: std::io::Cursor<Vec<u8>>,
        output: Vec<u8>,
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

    fn pipe(input: Vec<u8>) -> Pipe {
        Pipe {
            input: std::io::Cursor::new(input),
            output: Vec::new(),
        }
    }

    // 실측한 :5903(TigerVNC) 의 바이트를 그대로 재현한다.
    #[test]
    fn reads_the_subtype_list_a_real_tigervnc_offers() {
        let mut stream = pipe(vec![
            0, 2, // 버전 0.2
            0, // ack
            1, // 서브타입 1개
            0, 0, 1, 2, // 258 = TLSVnc
        ]);
        let offered = negotiate(&mut stream).unwrap();
        assert_eq!(offered, vec![SubType::TlsVnc]);
        assert_eq!(&stream.output, &[0, 2], "우리 버전을 되돌려줘야 한다");
    }

    #[test]
    fn falls_back_to_an_older_server_version() {
        let mut stream = pipe(vec![0, 1, 0, 1, 0, 0, 1, 1]);
        let offered = negotiate(&mut stream).unwrap();
        assert_eq!(offered, vec![SubType::TlsNone]);
        assert_eq!(&stream.output, &[0, 1], "서버 버전으로 맞춰야 한다");
    }

    #[test]
    fn zero_subtypes_is_a_refusal() {
        let mut stream = pipe(vec![0, 2, 0, 0]);
        let error = negotiate(&mut stream).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    }

    // 서브타입 선택 뒤의 1바이트를 반드시 소비해야 한다. 남기면 TLS 핸드셰이크가 그 바이트를
    // 레코드 헤더로 읽어 깨진다.
    #[test]
    fn select_consumes_the_continue_byte() {
        let mut stream = pipe(vec![1]);
        select(&mut stream, SubType::TlsVnc).unwrap();
        assert_eq!(&stream.output, &[0, 0, 1, 2]);
        assert_eq!(stream.input.position(), 1, "ack 를 읽어야 한다");
    }

    #[test]
    fn select_reports_a_refusal_with_the_method_name() {
        let mut stream = pipe(vec![0]);
        let error = select(&mut stream, SubType::X509Vnc).unwrap_err();
        assert!(error.to_string().contains("X509Vnc"), "{error}");
    }

    #[test]
    fn subtype_numbers_match_the_spec() {
        assert_eq!(SubType::from_u32(258), SubType::TlsVnc);
        assert_eq!(SubType::from_u32(261), SubType::X509Vnc);
        assert_eq!(SubType::TlsVnc.to_u32(), 258);
        assert!(SubType::TlsVnc.is_anonymous_tls());
        assert!(!SubType::TlsVnc.is_certificate_tls());
        assert!(SubType::X509Vnc.is_certificate_tls());
        assert!(!SubType::X509Vnc.is_anonymous_tls());
        // 모르는 번호는 그대로 들고 있어야 문구에 근거가 남는다.
        assert_eq!(SubType::from_u32(9999), SubType::Unknown(9999));
    }

    // 문구가 사용자가 할 수 있는 일을 말해야 한다.
    #[test]
    fn unsupported_message_names_the_methods_and_a_way_out() {
        let message = describe_unsupported(&[SubType::TlsVnc]);
        assert!(message.contains("TLSVnc"), "{message}");
        assert!(message.contains("X509"), "다른 길을 알려줘야 한다: {message}");
    }
}
