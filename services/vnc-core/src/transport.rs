//! 세션이 쓰는 바이트 통로. 평문 TCP 이거나 TLS 위다.
//!
//! **왜 하나로 감싸는가:** VeNCrypt 를 쓰면 보안 협상 이후의 **모든** RFB 트래픽이 TLS 안으로
//! 들어간다. 세션 코드가 `TcpStream` 에 묶여 있으면 그 경로를 만들 수 없다.
//!
//! **`SslStream` 은 복제할 수 없다.** TLS 상태는 하나뿐이라 읽기/쓰기 쪽을 나눠 가질 수 없고,
//! 그래서 "쓰기용 소켓을 복제해 입력 스레드가 직접 쓴다" 는 구조가 성립하지 않는다. 대신 세션
//! 스레드가 통로를 혼자 갖고, 입력은 큐로 받아 읽기가 쉴 때 내보낸다(session.rs 참고).
//!
//! 끊기 위한 파일 디스크립터는 따로 복제해 둔다 — `shutdown` 은 TLS 상태를 건드리지 않고 읽기에서
//! 막혀 있는 스레드를 그 자리에서 풀어 준다.

use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use openssl::ssl::SslStream;

pub enum Transport {
    Plain(TcpStream),
    Tls(Box<SslStream<TcpStream>>),
}

impl Transport {
    /// 바탕 TCP 소켓. 시간 제한·끊기처럼 TLS 와 무관한 조작에 쓴다.
    fn socket(&self) -> &TcpStream {
        match self {
            Self::Plain(stream) => stream,
            Self::Tls(stream) => stream.get_ref(),
        }
    }

    pub fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        self.socket().set_read_timeout(timeout)
    }

    /// 끊기 전용 복제본. 읽기에서 막힌 스레드를 깨우는 데만 쓴다.
    pub fn clone_for_shutdown(&self) -> io::Result<TcpStream> {
        self.socket().try_clone()
    }

    /// TLS 위인가. 세션이 진단에 남긴다 — 익명 TLS 는 상대를 보장하지 않으므로 어떤 통로로
    /// 붙었는지가 기록으로 남아야 한다.
    pub fn is_tls(&self) -> bool {
        matches!(self, Self::Tls(_))
    }
}

impl Read for Transport {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            Self::Plain(stream) => stream.read(buf),
            Self::Tls(stream) => stream.read(buf),
        }
    }
}

impl Write for Transport {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            Self::Plain(stream) => stream.write(buf),
            Self::Tls(stream) => stream.write(buf),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Self::Plain(stream) => stream.flush(),
            Self::Tls(stream) => stream.flush(),
        }
    }
}

/// 읽기가 "지금은 데이터가 없다" 로 끝난 것인가.
///
/// 소켓 시간 제한은 플랫폼마다 다른 오류로 온다(`WouldBlock` 또는 `TimedOut`). TLS 위에서는
/// OpenSSL 이 그것을 자기 오류로 감싸면서 종류가 바뀔 수 있으므로, 감싼 원인까지 들여다본다 —
/// 이걸 놓치면 조용한 화면에서 세션이 끊긴다.
pub fn is_idle_timeout(error: &io::Error) -> bool {
    if matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut | io::ErrorKind::Interrupted
    ) {
        return true;
    }
    match error.get_ref() {
        Some(inner) => match inner.downcast_ref::<io::Error>() {
            Some(nested) => is_idle_timeout(nested),
            None => {
                // OpenSSL 오류는 문자열로만 남는 경우가 있다. 마지막 수단으로 원인 사슬을 본다.
                let mut source = std::error::Error::source(inner);
                while let Some(cause) = source {
                    if let Some(nested) = cause.downcast_ref::<io::Error>() {
                        return is_idle_timeout(nested);
                    }
                    source = cause.source();
                }
                false
            }
        },
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_timeouts_are_idle() {
        assert!(is_idle_timeout(&io::Error::from(io::ErrorKind::WouldBlock)));
        assert!(is_idle_timeout(&io::Error::from(io::ErrorKind::TimedOut)));
        assert!(!is_idle_timeout(&io::Error::from(
            io::ErrorKind::ConnectionReset
        )));
    }

    // OpenSSL 은 시간 제한을 자기 오류로 감싼다. 그것을 못 알아보면 조용한 화면에서 세션이 끊긴다.
    #[test]
    fn wrapped_timeouts_are_idle() {
        let wrapped = io::Error::other(io::Error::from(io::ErrorKind::TimedOut));
        assert!(is_idle_timeout(&wrapped));
        let unrelated = io::Error::other(io::Error::from(io::ErrorKind::ConnectionAborted));
        assert!(!is_idle_timeout(&unrelated));
    }
}
