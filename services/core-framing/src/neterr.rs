//! OS 소켓 오류를 **세 코어가 같은 문구로** 올리게 만드는 정규화.
//!
//! **왜 필요한가:** Rust 의 `io::Error` 는 윈도우에서 FormatMessage 를 시스템 언어로 요청한다
//! (Go 는 영어를 먼저 요청하지만 Rust 는 강제하지 않는다). 그래서 한국어 윈도우에서 연결 거부는
//! 이렇게 올라온다:
//!
//! ```text
//! 대상 컴퓨터에서 연결을 거부했으므로 연결하지 못했습니다. (os error 10061)
//! ```
//!
//! 앱은 실패 원인을 문구로 판정한다(`packages/shared-core/src/connection-failure.ts`). 위 문장은
//! 리눅스·macOS 문구("connection refused")와 한 글자도 겹치지 않아 판정이 unknown 으로 떨어지고,
//! 사용자에게는 원문이 그대로 뜬다 — 실패 단계 표시도, 다음에 할 일 안내도 없이.
//!
//! **그래서 코어가 정경 문구를 앞에 붙인다.** 새 슬러그를 만들지 않고 유닉스 문구를 그대로 쓰는
//! 것이 요점이다 — 이미 배포된 앱의 판정 규칙이 그 문구를 알고 있으므로, 코어만 갱신해도 옛 앱까지
//! 함께 고쳐진다.
//!
//! **원문은 지우지 않는다.** `(os error 10061)` 이 우리 표가 틀렸을 때 남는 유일한 단서다.

use std::io;

/// 유닉스·Go 계통의 정경 문구. 앱의 분류기가 이미 아는 표현이어야 한다.
const REFUSED: &str = "connection refused";
const TIMEOUT: &str = "i/o timeout";
const RESET: &str = "connection reset";
const ABORTED: &str = "connection aborted";
const NO_ROUTE: &str = "no route to host";
const NETWORK_UNREACHABLE: &str = "network is unreachable";
const ADDRESS_IN_USE: &str = "address already in use";
const NO_SUCH_HOST: &str = "no such host";

/// 이 오류의 정경 문구. 우리가 아는 원인이 아니면 `None`.
///
/// `ErrorKind` 를 먼저 본다 — Rust 가 플랫폼 errno 를 이미 크로스플랫폼으로 정규화해 둔 값이라
/// 번호 표보다 믿을 만하다. 번호 표는 `ErrorKind` 가 `Uncategorized` 로 남기는 것들(윈도우의
/// 이름 해석 실패 등)을 위한 보조다.
pub fn canonical(error: &io::Error) -> Option<&'static str> {
    match error.kind() {
        io::ErrorKind::ConnectionRefused => Some(REFUSED),
        io::ErrorKind::TimedOut => Some(TIMEOUT),
        io::ErrorKind::ConnectionReset => Some(RESET),
        io::ErrorKind::ConnectionAborted => Some(ABORTED),
        io::ErrorKind::HostUnreachable => Some(NO_ROUTE),
        io::ErrorKind::NetworkUnreachable | io::ErrorKind::NetworkDown => {
            Some(NETWORK_UNREACHABLE)
        }
        io::ErrorKind::AddrInUse => Some(ADDRESS_IN_USE),
        // `ErrorKind` 는 non_exhaustive 다 — 모르는 종류는 번호로 한 번 더 본다.
        _ => canonical_from_raw(error.raw_os_error()?),
    }
}

/// winsock 번호 보조 표.
///
/// 유닉스 errno 는 위의 `ErrorKind` 가 이미 덮는다(플랫폼마다 번호가 달라 여기 넣으면 오히려
/// 틀린다 — ECONNREFUSED 가 리눅스 111, macOS 61 이다). 여기 남는 것은 윈도우에서 Rust 가
/// 분류하지 않고 넘기는 값들이다.
fn canonical_from_raw(code: i32) -> Option<&'static str> {
    match code {
        10051 => Some(NETWORK_UNREACHABLE), // WSAENETUNREACH
        10053 => Some(ABORTED),             // WSAECONNABORTED
        10054 => Some(RESET),               // WSAECONNRESET
        10060 => Some(TIMEOUT),             // WSAETIMEDOUT
        10061 => Some(REFUSED),             // WSAECONNREFUSED
        10064 => Some(NO_ROUTE),            // WSAEHOSTDOWN
        10065 => Some(NO_ROUTE),            // WSAEHOSTUNREACH
        10048 => Some(ADDRESS_IN_USE),      // WSAEADDRINUSE
        11001 | 11004 => Some(NO_SUCH_HOST), // WSAHOST_NOT_FOUND, WSANO_DATA
        _ => None,
    }
}

/// 앱이 쓰는 원인 코드. `packages/shared-core/src/connection-failure.ts` 의
/// `ConnectionFailureCode` 와 **같은 문자열**이어야 한다 — 이벤트 payload 의 `failure` 필드로
/// 올라가고, 앱은 문구 판정이 아무것도 못 찾았을 때의 폴백으로 쓴다.
pub const CODE_REFUSED: &str = "refused";
pub const CODE_TIMEOUT: &str = "timeout";
pub const CODE_RESET: &str = "reset";
pub const CODE_NO_ROUTE: &str = "no-route";
pub const CODE_ADDRESS_IN_USE: &str = "address-in-use";
pub const CODE_DNS: &str = "dns-unresolved";

/// 정경 문구를 원인 코드로 접는다.
///
/// 여러 문구가 한 코드로 모인다 — 사용자가 할 일이 같기 때문이다(reset·aborted 는 둘 다 "다시
/// 붙어라", host·network unreachable 은 둘 다 "네트워크를 봐라").
fn code_for(reason: &str) -> Option<&'static str> {
    match reason {
        REFUSED => Some(CODE_REFUSED),
        TIMEOUT => Some(CODE_TIMEOUT),
        RESET | ABORTED => Some(CODE_RESET),
        NO_ROUTE | NETWORK_UNREACHABLE => Some(CODE_NO_ROUTE),
        ADDRESS_IN_USE => Some(CODE_ADDRESS_IN_USE),
        NO_SUCH_HOST => Some(CODE_DNS),
        _ => None,
    }
}

/// 이 소켓 오류의 원인 코드.
pub fn code_io(error: &io::Error) -> Option<&'static str> {
    code_for(canonical(error)?)
}

/// `anyhow` 체인에 실린 소켓 오류의 원인 코드.
pub fn code(error: &anyhow::Error) -> Option<&'static str> {
    error
        .chain()
        .find_map(|source| source.downcast_ref::<io::Error>())
        .and_then(code_io)
}

/// 소켓 오류 한 건을 정경 문구 + 원문으로 적는다.
pub fn describe_io(error: &io::Error) -> String {
    match canonical(error) {
        Some(reason) => format!("{reason} ({error})"),
        None => error.to_string(),
    }
}

/// `anyhow` 오류를 사용자에게 올릴 문장으로 적는다.
///
/// 체인 어딘가에 소켓 오류가 있으면 정경 문구를 **앞에** 붙인다. dial 뿐 아니라 세션 도중의
/// 읽기·쓰기 실패도 이 경로로 올라오므로, 여기 한 곳에서 붙이면 두 코어의 모든 실패가 덮인다.
pub fn describe(error: &anyhow::Error) -> String {
    let detail = format!("{error:#}");
    let reason = error
        .chain()
        .find_map(|source| source.downcast_ref::<io::Error>())
        .and_then(canonical);
    match reason {
        // 이미 정경 문구가 들어 있으면 덧붙이지 않는다 — 하위 계층에서 describe_io 를 이미
        // 통과한 문장이면 같은 말이 두 번 나온다.
        Some(reason) if !detail.contains(reason) => format!("{reason}: {detail}"),
        _ => detail,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_socket_error_kinds_to_canonical_wording() {
        let cases = [
            (io::ErrorKind::ConnectionRefused, REFUSED),
            (io::ErrorKind::TimedOut, TIMEOUT),
            (io::ErrorKind::ConnectionReset, RESET),
            (io::ErrorKind::ConnectionAborted, ABORTED),
            (io::ErrorKind::HostUnreachable, NO_ROUTE),
            (io::ErrorKind::NetworkUnreachable, NETWORK_UNREACHABLE),
            (io::ErrorKind::AddrInUse, ADDRESS_IN_USE),
        ];
        for (kind, expected) in cases {
            let error = io::Error::new(kind, "원문");
            assert_eq!(canonical(&error), Some(expected), "{kind:?}");
        }
    }

    #[test]
    fn leaves_unrelated_errors_alone() {
        let error = io::Error::new(io::ErrorKind::InvalidData, "이상한 픽셀");
        assert_eq!(canonical(&error), None);
        assert_eq!(describe_io(&error), "이상한 픽셀");
    }

    // 원문을 지우면 우리 표가 틀렸을 때 단서가 없다.
    #[test]
    fn keeps_the_original_sentence() {
        let error = io::Error::new(io::ErrorKind::ConnectionRefused, "대상 컴퓨터에서 거부했다");
        assert_eq!(
            describe_io(&error),
            "connection refused (대상 컴퓨터에서 거부했다)"
        );
    }

    // 윈도우가 분류하지 않고 넘기는 번호들. 이름 해석 실패가 여기에 있다.
    #[test]
    fn falls_back_to_winsock_numbers() {
        assert_eq!(canonical_from_raw(11001), Some(NO_SUCH_HOST));
        assert_eq!(canonical_from_raw(10061), Some(REFUSED));
        assert_eq!(canonical_from_raw(42), None);
    }

    #[test]
    fn prefixes_anyhow_chains_that_carry_a_socket_error() {
        let io_error = io::Error::new(io::ErrorKind::ConnectionReset, "강제로 끊겼다");
        let error = anyhow::Error::from(io_error).context("RFB 프레임을 읽는 중");
        let described = describe(&error);
        assert!(described.starts_with("connection reset: "), "{described}");
        assert!(described.contains("RFB 프레임을 읽는 중"), "{described}");
    }

    // 하위 계층이 이미 붙였으면 두 번 붙이지 않는다.
    #[test]
    fn does_not_repeat_a_reason_already_in_the_sentence() {
        let io_error = io::Error::new(io::ErrorKind::ConnectionRefused, "x");
        let error = anyhow::Error::msg(describe_io(&io_error));
        assert_eq!(describe(&error), describe_io(&io_error));
    }

    #[test]
    fn leaves_plain_errors_unchanged() {
        let error = anyhow::Error::msg("서버가 제시한 보안 타입을 지원하지 않습니다");
        assert_eq!(
            describe(&error),
            "서버가 제시한 보안 타입을 지원하지 않습니다"
        );
    }

    #[test]
    fn folds_wording_into_app_codes() {
        assert_eq!(code_for(REFUSED), Some(CODE_REFUSED));
        assert_eq!(code_for(ABORTED), Some(CODE_RESET));
        assert_eq!(code_for(NETWORK_UNREACHABLE), Some(CODE_NO_ROUTE));
        assert_eq!(code_for(NO_SUCH_HOST), Some(CODE_DNS));
        assert_eq!(code_for("무엇인지 모르는 실패"), None);
    }

    #[test]
    fn reads_the_code_from_an_anyhow_chain() {
        let io_error = io::Error::new(io::ErrorKind::ConnectionRefused, "거부됐다");
        let error = anyhow::Error::from(io_error).context("RFB 서버에 붙는 중");
        assert_eq!(code(&error), Some(CODE_REFUSED));
        // 소켓 오류가 없는 실패에는 코드를 붙이지 않는다.
        assert_eq!(code(&anyhow::Error::msg("비밀번호가 틀렸습니다")), None);
    }

    #[cfg(windows)]
    #[test]
    fn classifies_a_real_windows_refusal() {
        use std::net::{SocketAddr, TcpStream};
        use std::time::Duration;

        let addr: SocketAddr = "127.0.0.1:59999".parse().expect("주소");
        let Err(error) = TcpStream::connect_timeout(&addr, Duration::from_secs(3)) else {
            return; // 그 포트에 무언가 듣고 있다면 이 테스트는 확인할 것이 없다.
        };
        assert_eq!(error.raw_os_error(), Some(10061));
        assert_eq!(canonical(&error), Some(REFUSED));
    }
}
