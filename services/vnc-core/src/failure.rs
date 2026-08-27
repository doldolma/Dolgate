//! 사용자에게 원인을 말할 수 있는 실패에 **코드**를 붙인다.
//!
//! `core_framing::neterr` 가 소켓 오류에 하는 일과 같고 다루는 계층만 다르다 — 여기 있는 것은
//! RFB 인증 계층의 실패다. 코드는 앱이 문구를 고르는 열쇠이고
//! (`packages/shared-core/src/connection-failure.ts` 의 `ConnectionFailureCode` 와 **같은
//! 문자열**이어야 한다), 문구 자체는 앱이 자기 언어로 붙인다.
//!
//! **왜 코어가 문장을 쓰지 않는가:** 코어는 앱의 언어 설정을 모른다. 여기서 문장을 정하면 그
//! 언어로 굳어, 다른 언어로 쓰는 사용자에게 그대로 나간다. 코어가 아는 것은 "무엇이 틀렸나"
//! 까지이고 "어떻게 말하나" 는 앱의 몫이다.

use std::fmt;
use std::io;

/// RFB 인증 계층에서 사용자에게 원인을 말할 수 있는 실패.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// 서버가 자격증명을 거부했다.
    AuthRejected,
    /// 계정 기반 인증(ARD)이 거부됐고 **같은 서버가 VncAuth 도 제시했다.**
    ///
    /// 갈 길이 다르다 — macOS 화면 공유에는 로그인 비밀번호와 별개로 "VNC 뷰어 암호" 가 있고,
    /// 계정을 비우면 그 암호로 붙는다. 그냥 "틀렸다" 고만 하면 VNC 암호를 넣은 사용자는 무엇을
    /// 바꿔야 하는지 알 수 없다.
    AccountAuthRejected,
    /// 서버가 비밀번호를 요구하는데 저장된 것이 없다.
    PasswordRequired,
    /// 계정이 필요한데 비어 있다(macOS 화면 공유).
    AccountRequired,
    /// 거부됐고 비밀번호가 8자를 넘는다.
    ///
    /// VNC 는 앞 8자만 쓰므로(1998년 규격) 긴 비밀번호를 넣었을 때 가장 흔한 원인이 이것이다.
    /// 서버는 왜 틀렸는지 말해 주지 않는다.
    PasswordTruncated,
}

impl Failure {
    /// 앱이 쓰는 원인 코드.
    pub fn code(self) -> &'static str {
        match self {
            Self::AuthRejected => "auth-rejected",
            Self::AccountAuthRejected => "account-auth-rejected",
            Self::PasswordRequired => "password-required",
            Self::AccountRequired => "account-required",
            Self::PasswordTruncated => "password-truncated",
        }
    }
}

/// 진단용 한 줄. **사용자 문구가 아니다** — 앱이 코드로 문구를 고르고 이 문장은 그 뒤에 남는
/// 상세(로그·버그 보고)다. 그래서 영어로 적는다: 코어는 붙일 언어를 고를 수 없다.
impl fmt::Display for Failure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::AuthRejected => "the server rejected the credentials",
            Self::AccountAuthRejected => {
                "the server rejected the account credentials (it also offers VNC password auth)"
            }
            Self::PasswordRequired => "the server requires a password and none was stored",
            Self::AccountRequired => "the server requires an account name and none was stored",
            Self::PasswordTruncated => {
                "the server rejected the password, which is longer than the 8 bytes VNC uses"
            }
        })
    }
}

impl std::error::Error for Failure {}

/// `anyhow` 오류에서 이 계층의 원인 코드를 찾는다(`neterr::code` 와 같은 모양).
///
/// 타입으로 실린 것을 먼저 본다. 없으면 RFB 보안 결과가 만드는 `io::Error` 를 본다 — 서버가
/// 붙인 거부 사유를 `PermissionDenied` 로 올리는 자리가 그곳이고(`rfb::rejection_error`),
/// 사유 문장은 서버가 정하므로 문구로 판정할 수 없다.
///
/// **`chain()` 을 돌며 찾지 않는다.** `.context(Failure::…)` 로 얹은 값은 체인에 anyhow 의
/// 포장 타입으로 들어가므로 `&dyn Error` 를 하나씩 downcast 해서는 걸리지 않는다(그렇게 썼다가
/// 아래 폴백이 전부 auth-rejected 로 접어 버리는 것을 테스트가 잡았다). `anyhow::Error` 자신의
/// `downcast_ref` 는 문맥으로 실린 값까지 본다.
pub fn code(error: &anyhow::Error) -> Option<&'static str> {
    if let Some(failure) = error.downcast_ref::<Failure>() {
        return Some(failure.code());
    }
    error
        .chain()
        .find_map(|source| source.downcast_ref::<io::Error>())
        .filter(|io_error| io_error.kind() == io::ErrorKind::PermissionDenied)
        .map(|_| Failure::AuthRejected.code())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 타입으로_실린_실패를_찾는다() {
        let error = anyhow::Error::new(Failure::PasswordRequired);
        assert_eq!(code(&error), Some("password-required"));
    }

    #[test]
    fn 문맥으로_실린_실패도_찾는다() {
        // 서버가 붙인 사유를 잃지 않으려고 io 오류 위에 코드를 얹는다.
        let rejected = io::Error::new(io::ErrorKind::PermissionDenied, "authentication failed");
        let error = anyhow::Error::new(rejected).context(Failure::PasswordTruncated);
        assert_eq!(code(&error), Some("password-truncated"));
        // 사유가 문장에 남아 있어야 한다 — 로그에서 그것만이 단서다.
        assert!(format!("{error:#}").contains("authentication failed"));
    }

    #[test]
    fn 코드가_없는_거부는_일반_거부로_본다() {
        let error = anyhow::Error::new(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "too many security failures",
        ));
        assert_eq!(code(&error), Some("auth-rejected"));
    }

    #[test]
    fn 인증과_무관한_오류에는_코드가_없다() {
        let error = anyhow::Error::new(io::Error::new(
            io::ErrorKind::InvalidData,
            "ZRLE run length out of range",
        ));
        assert_eq!(code(&error), None);
    }
}
