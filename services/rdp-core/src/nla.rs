//! NLA(CredSSP)를 우리가 직접 돌린다 — ironrdp-blocking 의 `connect_finalize` 가 맨 먼저 하는 일
//! (`perform_credssp_step`)과 같고, 공개 API 만 쓴다. 이 단계가 끝나면 커넥터가 표시를 바꿔 두므로
//! 나머지 접속 단계는 지금처럼 `connect_finalize` 가 한다.
//!
//! **직접 돌리는 까닭은 하나다:** 계정·비밀번호의 증명을 보낸 바로 다음에 서버가 연결을 끊으면 그것을
//! 거절로 알아야 한다. Windows 는 거절의 까닭(NTSTATUS)을 실어 보내지만, FreeRDP 계열 서버(GNOME 원격
//! 데스크톱 등이 쓰는 서버 쪽 NLA)는 틀린 비밀번호를 NTLM 무결성 검사 실패로 알고 까닭 없이 끊는다.
//! `connect_finalize` 안에서는 그 끊김이 '프레임을 다 못 읽음'으로만 남아 어느 단계였는지 알 수 없다.
//! FreeRDP 클라이언트도 이 경우를 인증 실패("check credentials")로 다룬다.

use std::io::{self, Read, Write};

use anyhow::Context as _;
use ironrdp::connector::credssp::{CredsspProcessGenerator, CredsspSequence};
use ironrdp::connector::{
    ClientConnector, ClientConnectorState, ConnectorError, ConnectorErrorKind, ServerName,
};
use ironrdp_pdu::ironrdp_core::WriteBuf;
use sspi::credssp::ClientState;
use sspi::generator::GeneratorState;
use sspi::network_client::NetworkClient;
use tracing::debug;

use crate::failure::Failure;

/// CredSSP 를 끝까지 돌리고 커넥터에 끝났다고 적는다. 서버가 NLA 를 고른 커넥터에서만 부른다.
pub(crate) fn perform_credssp<S: Read + Write>(
    connector: &mut ClientConnector,
    framed: &mut ironrdp_blocking::Framed<S>,
    network_client: &mut impl NetworkClient,
    server_name: ServerName,
    server_public_key: Vec<u8>,
) -> anyhow::Result<()> {
    let ClientConnectorState::Credssp { selected_protocol } = connector.state else {
        anyhow::bail!("CredSSP was requested outside its connector state");
    };
    let (mut sequence, mut ts_request) = CredsspSequence::init(
        connector.config.credentials.clone(),
        connector.config.domain.as_deref(),
        selected_protocol,
        server_name,
        server_public_key,
        None,
    )?;

    let mut buf = WriteBuf::new();
    // 계정·비밀번호의 증명(pubKeyAuth 가 실린 메시지 — NTLM 이면 AUTHENTICATE 와 함께 간다)을 보내고
    // 서버의 판정을 기다리는 중인지.
    let mut awaiting_verdict = false;
    loop {
        let client_state = {
            let mut generator = sequence.process_ts_request(ts_request);
            resolve_generator(&mut generator, network_client)?
        };
        let proves_credentials = carries_proof(&client_state);

        buf.clear();
        let written = sequence.handle_process_result(client_state, &mut buf)?;
        if let Some(length) = written.size() {
            framed
                .write_all(&buf[..length])
                .context("send the CredSSP message")?;
            awaiting_verdict = proves_credentials;
        }

        let Some(hint) = sequence.next_pdu_hint() else {
            break;
        };
        debug!(awaiting_verdict, "waiting for the CredSSP reply");
        let pdu = framed
            .read_by_hint(hint)
            .map_err(|error| reply_read_error(error, awaiting_verdict))?;
        awaiting_verdict = false;

        match sequence.decode_server_message(&pdu)? {
            Some(next_request) => ts_request = next_request,
            None => break,
        }
    }

    connector.mark_credssp_as_done();
    Ok(())
}

/// 이 메시지가 계정·비밀번호를 증명하는지 — 서버의 판정이 바로 다음 답에 온다.
fn carries_proof(state: &ClientState) -> bool {
    match state {
        ClientState::ReplyNeeded(request) | ClientState::FinalMessage(request) => {
            request.pub_key_auth.is_some()
        }
    }
}

/// 서버의 답을 읽다 실패했다. 증명을 보낸 바로 다음에 서버가 끊었으면 거절이다(위 머리말).
fn reply_read_error(error: io::Error, awaiting_verdict: bool) -> anyhow::Error {
    let closed = matches!(
        error.kind(),
        io::ErrorKind::UnexpectedEof
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::ConnectionAborted
    );
    let error = anyhow::Error::new(error).context("read the CredSSP reply");
    if awaiting_verdict && closed {
        error.context(Failure::AuthRejected)
    } else {
        error
    }
}

/// ironrdp-blocking 의 것과 같다 — Kerberos 일 때만 네트워크 요청을 낸다(우리는 NTLM 이라 바로 끝난다).
fn resolve_generator(
    generator: &mut CredsspProcessGenerator<'_>,
    network_client: &mut impl NetworkClient,
) -> Result<ClientState, ConnectorError> {
    let mut state = generator.start();
    loop {
        match state {
            GeneratorState::Suspended(request) => {
                let response = network_client.send(&request).map_err(|error| {
                    ConnectorError::new("network client send", ConnectorErrorKind::Credssp(error))
                })?;
                state = generator.resume(Ok(response));
            }
            GeneratorState::Completed(client_state) => {
                break client_state.map_err(|error| {
                    ConnectorError::new("CredSSP", ConnectorErrorKind::Credssp(error))
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ErrorPayload;
    use sspi::credssp::TsRequest;

    #[test]
    fn a_close_right_after_the_proof_is_a_rejection() {
        for kind in [
            io::ErrorKind::UnexpectedEof,
            io::ErrorKind::ConnectionReset,
            io::ErrorKind::ConnectionAborted,
        ] {
            let error = reply_read_error(io::Error::new(kind, "not enough bytes"), true)
                .context("finalize connection");
            assert_eq!(
                crate::failure::code(&error),
                Some("auth-rejected"),
                "{kind:?}"
            );
            // 서버가 끊었다는 것은 오류 이벤트에서도 거절이다 — 소켓의 'reset' 보다 앞선다.
            assert_eq!(
                ErrorPayload::from_error(&error).failure,
                Some("auth-rejected"),
                "{kind:?}"
            );
            // 로그에는 실제로 무슨 일이 있었는지 남는다.
            assert!(
                format!("{error:#}").contains("not enough bytes"),
                "{error:#}"
            );
        }
    }

    #[test]
    fn a_close_before_the_proof_is_not_a_rejection() {
        let error = reply_read_error(
            io::Error::new(io::ErrorKind::UnexpectedEof, "not enough bytes"),
            false,
        );
        assert_eq!(crate::failure::code(&error), None);
        let reset = reply_read_error(io::Error::from(io::ErrorKind::ConnectionReset), false);
        assert_eq!(ErrorPayload::from_error(&reset).failure, Some("reset"));
    }

    #[test]
    fn a_slow_server_is_not_a_rejection() {
        let error = reply_read_error(io::Error::from(io::ErrorKind::TimedOut), true);
        assert_eq!(crate::failure::code(&error), None);
        assert_eq!(ErrorPayload::from_error(&error).failure, Some("timeout"));
    }

    #[test]
    fn only_the_message_with_the_public_key_proof_awaits_a_verdict() {
        let with_proof = TsRequest {
            pub_key_auth: Some(vec![1, 2, 3]),
            ..TsRequest::default()
        };
        assert!(carries_proof(&ClientState::ReplyNeeded(with_proof.clone())));
        assert!(carries_proof(&ClientState::FinalMessage(with_proof)));
        // 첫 메시지(NEGOTIATE)와 마지막 메시지(위임할 자격 증명)에는 증명이 없다.
        assert!(!carries_proof(&ClientState::ReplyNeeded(
            TsRequest::default()
        )));
        let credentials = TsRequest {
            auth_info: Some(vec![9]),
            ..TsRequest::default()
        };
        assert!(!carries_proof(&ClientState::FinalMessage(credentials)));
    }
}
