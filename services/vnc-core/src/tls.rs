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
//! 망(SSH 터널·tailnet)에서만 써야 한다. X509 계열은 TOFU 신뢰 판정이 완성될 때까지 호출부가
//! 협상 전에 거부한다.

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
