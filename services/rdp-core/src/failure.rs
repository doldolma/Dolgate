//! 사용자에게 원인을 말할 수 있는 로그온 실패에 **코드**를 붙인다.
//!
//! `core_framing::neterr` 가 소켓 오류에 하는 일과 같고 다루는 계층만 다르다 — 여기 있는 것은
//! NLA(CredSSP) 로그온의 실패다. 코드는 앱이 문구를 고르는 열쇠이고
//! (`packages/shared-core/src/connection-failure.ts` 의 `ConnectionFailureCode` 와 **같은
//! 문자열**이어야 한다), 문구 자체는 앱이 자기 언어로 붙인다(vnc-core 의 failure.rs 와 같은 규칙).
//!
//! 서버는 거절의 까닭을 NTSTATUS 로 싣는다(CredSSP 3 판부터의 TSRequest errorCode). 지금까지는
//! 그 값이 `finalize connection: …` 문장 끝에만 남아, 앱이 비밀번호가 틀린 것과 계정이 잠긴 것을
//! 가를 수 없었다.

use std::fmt;

use ironrdp::connector::{ConnectorError, ConnectorErrorKind};
use sspi::credssp::NStatusCode;

/// NLA 로그온에서 사용자에게 원인을 말할 수 있는 실패.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// 서버가 NLA 를 골랐는데 보낼 비밀번호가 없다 — 보내기 전에 멈춘 것이다. 빈 값을 보내면
    /// 서버가 거절하며 그 계정의 실패 횟수만 는다(잠금 정책).
    PasswordRequired,
    /// 서버가 계정·비밀번호를 거절했다. 다시 넣으면 풀린다.
    AuthRejected,
    /// 계정이 잠겼다. 다시 넣어도 풀리지 않는다 — 넣을수록 잠금이 길어질 수 있다.
    AccountLocked,
    /// 계정이 사용 중지됐거나 만료됐다.
    AccountDisabled,
    /// 비밀번호가 만료됐거나 다음 로그인 때 바꿔야 한다. NLA 로는 바꿀 수 없다.
    PasswordExpired,
    /// 자격 증명은 맞지만 이 계정으로 원격 로그인할 수 없다(원격 데스크톱 사용자 권한, 로그인
    /// 시간·장치 제한, 빈 비밀번호 계정의 원격 로그인 금지).
    LogonDenied,
}

impl Failure {
    /// 앱이 쓰는 원인 코드.
    pub fn code(self) -> &'static str {
        match self {
            Self::PasswordRequired => "password-required",
            Self::AuthRejected => "auth-rejected",
            Self::AccountLocked => "account-locked",
            Self::AccountDisabled => "account-disabled",
            Self::PasswordExpired => "password-expired",
            Self::LogonDenied => "logon-denied",
        }
    }
}

/// 진단용 한 줄. **사용자 문구가 아니다** — 앱이 코드로 문구를 고르고 이 문장은 그 뒤에 남는
/// 상세(로그·버그 보고)다. 코어는 앱의 언어를 모르므로 영어로 적는다.
impl fmt::Display for Failure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::PasswordRequired => {
                "the server requires network level authentication and no password was stored"
            }
            Self::AuthRejected => "the server rejected the credentials",
            Self::AccountLocked => "the account is locked out",
            Self::AccountDisabled => "the account is disabled or expired",
            Self::PasswordExpired => "the password has expired or must be changed",
            Self::LogonDenied => "the account is not allowed to sign in remotely",
        })
    }
}

impl std::error::Error for Failure {}

/// `anyhow` 오류에서 이 계층의 원인 코드를 찾는다(`neterr::code` 와 같은 모양).
///
/// 우리가 직접 실은 것(`Failure`)을 먼저 보고, 없으면 커넥터의 CredSSP 오류를 본다.
/// `anyhow::Error` 자신의 `downcast_ref` 는 문맥(`.context`)을 몇 겹 얹어도 그 아래의 오류까지
/// 본다(vnc-core 의 failure.rs 가 적어 둔 대로 `chain()` 을 돌며 찾으면 문맥으로 실린 값은 놓친다).
pub fn code(error: &anyhow::Error) -> Option<&'static str> {
    if let Some(failure) = error.downcast_ref::<Failure>() {
        return Some(failure.code());
    }
    let connector = error.downcast_ref::<ConnectorError>()?;
    classify(connector.kind()).map(Failure::code)
}

fn classify(kind: &ConnectorErrorKind) -> Option<Failure> {
    match kind {
        ConnectorErrorKind::Credssp(error) => match error.nstatus {
            Some(status) => classify_status(status),
            // 까닭 없이 '로그온 거부'만 온 경우(sspi 의 SEC_E_LOGON_DENIED).
            None => {
                (error.error_type == sspi::ErrorKind::LogonDenied).then_some(Failure::AuthRejected)
            }
        },
        // HYBRID_EX 의 Early User Authorization Result 가 거부다 — 자격 증명은 맞았고, 이 계정에
        // 원격 로그인 권한이 없다(MS-RDPBCGR 2.2.10.2).
        ConnectorErrorKind::AccessDenied => Some(Failure::LogonDenied),
        _ => None,
    }
}

/// 서버가 실은 NTSTATUS(MS-ERREF 2.3.1)를 까닭으로. 모르는 값은 None — 추측하지 않는다(앱이
/// 원문을 그대로 보인다).
fn classify_status(status: NStatusCode) -> Option<Failure> {
    // sspi 의 목록에 없는 값.
    const ACCOUNT_EXPIRED: NStatusCode = NStatusCode(0xC000_0193);
    match status {
        NStatusCode::LOGON_FAILURE
        | NStatusCode::WRONG_PASSWORD
        | NStatusCode::NO_SUCH_USER
        | NStatusCode::INVALID_ACCOUNT_NAME => Some(Failure::AuthRejected),
        NStatusCode::ACCOUNT_LOCKED_OUT => Some(Failure::AccountLocked),
        NStatusCode::ACCOUNT_DISABLED | ACCOUNT_EXPIRED => Some(Failure::AccountDisabled),
        NStatusCode::PASSWORD_EXPIRED | NStatusCode::PASSWORD_MUST_CHANGE => {
            Some(Failure::PasswordExpired)
        }
        NStatusCode::LOGON_TYPE_NOT_GRANTED
        | NStatusCode::ACCOUNT_RESTRICTION
        | NStatusCode::INVALID_LOGON_HOURS
        | NStatusCode::INVALID_WORKSTATION => Some(Failure::LogonDenied),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Context as _;
    use sspi::credssp::TsRequest;

    /// 서버가 보낸 TSRequest(errorCode 실림)를 받아 커넥터가 만드는 모양 그대로 — sspi 가 읽고
    /// (`check_error`), ironrdp-blocking 이 "CredSSP" 로 싸고, 우리가 문맥을 두 겹 얹는다.
    fn rejected_with(status: NStatusCode) -> anyhow::Error {
        let mut wire = Vec::new();
        TsRequest {
            version: 6,
            error_code: Some(status),
            ..TsRequest::default()
        }
        .encode_ts_request(&mut wire)
        .expect("encode");
        let received = TsRequest::from_buffer(&wire).expect("decode");
        let sspi_error = received
            .check_error()
            .expect_err("the server reported an error");
        let result: Result<(), ConnectorError> = Err(ConnectorError::new(
            "CredSSP",
            ConnectorErrorKind::Credssp(sspi_error),
        ));
        result
            .context("finalize connection")
            .context("connect")
            .expect_err("failed")
    }

    #[test]
    fn a_wrong_password_is_a_rejection_we_can_ask_again_for() {
        for status in [
            NStatusCode::LOGON_FAILURE,
            NStatusCode::WRONG_PASSWORD,
            NStatusCode::NO_SUCH_USER,
            NStatusCode::INVALID_ACCOUNT_NAME,
        ] {
            assert_eq!(
                code(&rejected_with(status)),
                Some("auth-rejected"),
                "{status}"
            );
        }
    }

    #[test]
    fn failures_retyping_cannot_fix_carry_their_own_code() {
        let cases = [
            (NStatusCode::ACCOUNT_LOCKED_OUT, "account-locked"),
            (NStatusCode::ACCOUNT_DISABLED, "account-disabled"),
            (NStatusCode(0xC000_0193), "account-disabled"),
            (NStatusCode::PASSWORD_EXPIRED, "password-expired"),
            (NStatusCode::PASSWORD_MUST_CHANGE, "password-expired"),
            (NStatusCode::LOGON_TYPE_NOT_GRANTED, "logon-denied"),
            (NStatusCode::ACCOUNT_RESTRICTION, "logon-denied"),
            (NStatusCode::INVALID_LOGON_HOURS, "logon-denied"),
            (NStatusCode::INVALID_WORKSTATION, "logon-denied"),
        ];
        for (status, expected) in cases {
            assert_eq!(code(&rejected_with(status)), Some(expected), "{status}");
        }
    }

    #[test]
    fn the_rejection_message_keeps_the_server_status() {
        // 로그에서는 이 문장만이 단서다.
        let error = rejected_with(NStatusCode::LOGON_FAILURE);
        assert!(
            format!("{error:#}").contains("STATUS_LOGON_FAILURE"),
            "{error:#}"
        );
    }

    #[test]
    fn unknown_statuses_are_not_guessed() {
        assert_eq!(code(&rejected_with(NStatusCode(0xC000_0001))), None);
        assert_eq!(code(&rejected_with(NStatusCode::NO_LOGON_SERVERS)), None);
    }

    #[test]
    fn an_early_user_authorization_denial_is_logon_denied() {
        let result: Result<(), ConnectorError> = Err(ConnectorError::new(
            "CredSSP",
            ConnectorErrorKind::AccessDenied,
        ));
        let error = result.context("finalize connection").expect_err("failed");
        assert_eq!(code(&error), Some("logon-denied"));
    }

    #[test]
    fn a_logon_denial_without_a_status_is_a_rejection() {
        let sspi_error = sspi::Error::new(sspi::ErrorKind::LogonDenied, "logon denied");
        let result: Result<(), ConnectorError> = Err(ConnectorError::new(
            "CredSSP",
            ConnectorErrorKind::Credssp(sspi_error),
        ));
        let error = result.context("finalize connection").expect_err("failed");
        assert_eq!(code(&error), Some("auth-rejected"));

        let other = sspi::Error::new(sspi::ErrorKind::InternalError, "boom");
        let result: Result<(), ConnectorError> = Err(ConnectorError::new(
            "CredSSP",
            ConnectorErrorKind::Credssp(other),
        ));
        assert_eq!(
            code(&result.context("finalize connection").expect_err("failed")),
            None
        );
    }

    #[test]
    fn finds_a_failure_we_attached_ourselves() {
        let error = anyhow::Error::new(Failure::PasswordRequired).context("connect");
        assert_eq!(code(&error), Some("password-required"));
    }

    #[test]
    fn unrelated_errors_have_no_code() {
        let result: Result<(), ConnectorError> = Err(ConnectorError::new(
            "Initiation",
            ConnectorErrorKind::Reason("standard RDP security is not supported".to_owned()),
        ));
        assert_eq!(
            code(&result.context("begin connection").expect_err("failed")),
            None
        );
        assert_eq!(
            code(&anyhow::anyhow!("server certificate was not trusted")),
            None
        );
    }
}
