//! VeNCrypt 의 TLS 계층.
//!
//! **왜 OpenSSL 인가:** TLSVnc 계열은 인증서 없이 익명 DH(ADH/AECDH)로 붙는다. rustls 는 익명
//! 암호군을 의도적으로 지원하지 않아서 이 경로를 세울 수 없다. 실측한 TigerVNC 두 대가 모두
//! TLSVnc 만 제시하므로(X509 없음) 이 스택 없이는 그 서버에 붙지 못한다.
//!
//! **익명 DH 는 TLS 1.2 까지만 있다.** TLS 1.3 은 인증서(또는 PSK)를 요구한다. 그래서 익명
//! 경로는 상한을 1.2 로 내리고 `aNULL` 을 명시적으로 켠다 — 기본 보안 수준에서는 걸러진다.
//!
//! **익명 경로의 보안 성질을 오해하지 않도록:** 인증서가 없으므로 중간자를 구분할 방법이 원리적으로
//! 없다. 도청은 막지만 상대가 누구인지는 보장하지 않는다. 그래서 이 경로를 쓰는 세션은 신뢰하는
//! 망(SSH 터널·tailnet)이나 인증서 기반(X509\*)으로 옮기는 것이 맞고, 그 사실을 호출부가 사용자에게
//! 알려야 한다.

use std::io;
use std::net::TcpStream;

use openssl::ssl::{SslConnector, SslMethod, SslStream, SslVerifyMode, SslVersion};

/// 익명 DH 로 TLS 를 세운다(TLSNone·TLSVnc·TLSPlain).
///
/// 인증서가 없으니 검증을 끌 수밖에 없다 — 켜 두면 핸드셰이크가 "peer did not return a
/// certificate" 로 끝난다.
pub fn connect_anonymous(stream: TcpStream, host: &str) -> io::Result<SslStream<TcpStream>> {
    let mut builder = SslConnector::builder(SslMethod::tls_client()).map_err(to_io)?;
    builder.set_verify(SslVerifyMode::NONE);
    // 익명 암호군은 1.2 에만 있다.
    builder
        .set_max_proto_version(Some(SslVersion::TLS1_2))
        .map_err(to_io)?;
    // @SECLEVEL=0 이 없으면 aNULL 이 보안 수준에서 걸러진다. AECDH 를 먼저 둔다 — TigerVNC 의
    // GnuTLS 우선순위가 ANON-ECDH 를 앞에 두므로 그쪽이 먼저 맞는다.
    builder
        .set_cipher_list("AECDH:ADH:@SECLEVEL=0")
        .map_err(to_io)?;

    let connector = builder.build();
    let mut config = connector.configure().map_err(to_io)?;
    // 익명 세션에는 인증서가 없으므로 SNI·호스트명 검증이 의미가 없다. 끄지 않으면 openssl 이
    // 호스트명 대조를 시도한다.
    config.set_use_server_name_indication(false);
    config.set_verify_hostname(false);
    config
        .connect(host, stream)
        .map_err(|error| io::Error::other(format!("익명 TLS 핸드셰이크 실패: {error}")))
}

/// 인증서 기반으로 TLS 를 세운다(X509None·X509Vnc·X509Plain).
///
/// 검증은 여기서 하지 않고 지문을 돌려준다. RDP 와 같은 TOFU 모델을 쓰기 위한 것이다 — VNC 서버도
/// 대개 자체 서명이라 CA 검증은 성립하지 않고, 처음 본 지문을 기억해 두고 달라질 때 묻는 편이
/// 실제 위협(서버가 바뀜)을 잡는다.
pub fn connect_with_certificate(
    stream: TcpStream,
    host: &str,
) -> io::Result<(SslStream<TcpStream>, String)> {
    let mut builder = SslConnector::builder(SslMethod::tls_client()).map_err(to_io)?;
    // 검증은 우리가 지문으로 한다. 여기서 CA 검증을 켜면 자체 서명 서버를 전부 거절한다.
    builder.set_verify(SslVerifyMode::NONE);
    let connector = builder.build();
    let mut config = connector.configure().map_err(to_io)?;
    config.set_verify_hostname(false);
    let session = config
        .connect(host, stream)
        .map_err(|error| io::Error::other(format!("TLS 핸드셰이크 실패: {error}")))?;

    let fingerprint = session
        .ssl()
        .peer_certificate()
        .ok_or_else(|| io::Error::other("서버가 인증서를 보내지 않았습니다"))
        .and_then(|certificate| {
            certificate
                .digest(openssl::hash::MessageDigest::sha256())
                .map_err(to_io)
        })
        .map(|digest| {
            digest
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<Vec<_>>()
                .join(":")
        })?;

    Ok((session, fingerprint))
}

fn to_io(error: openssl::error::ErrorStack) -> io::Error {
    io::Error::other(format!("TLS 설정 실패: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // 익명 암호군을 실제로 켤 수 있는 빌드인지 확인한다.
    //
    // vendored OpenSSL 의 빌드 설정에 따라 aNULL 이 아예 컴파일에서 빠질 수 있다. 그러면 이
    // 경로는 런타임에야 실패하고, 증상은 "TLSVnc 서버에만 붙지 않는다" 로만 보인다.
    #[test]
    fn the_openssl_build_has_anonymous_cipher_suites() {
        let mut builder = SslConnector::builder(SslMethod::tls_client()).unwrap();
        builder
            .set_max_proto_version(Some(SslVersion::TLS1_2))
            .unwrap();
        builder
            .set_cipher_list("AECDH:ADH:@SECLEVEL=0")
            .expect("이 OpenSSL 빌드에는 익명 암호군이 없다 — TLSVnc 를 쓸 수 없다");
    }
}
