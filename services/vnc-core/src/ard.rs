//! Apple Remote Desktop 인증(보안 타입 30) — macOS "화면 공유" 의 기본 경로.
//!
//! **VncAuth 와 완전히 다르다.** 챌린지-응답이 아니라 Diffie-Hellman 으로 공유 비밀을 만들고, 그
//! MD5 를 AES-128 키로 써서 **계정과 비밀번호를 함께** 암호화해 보낸다. 그래서 macOS 는 8자 제한이
//! 없고 계정이 반드시 필요하다.
//!
//! 순서:
//!
//! ```text
//! 서버 → generator(2) + keyLength(2) + modulus(keyLength) + serverPublic(keyLength)
//! 클라 → AES(128바이트 자격증명) + clientPublic(keyLength)
//! 서버 → SecurityResult(4)
//! ```
//!
//! 자격증명 블록은 **정확히 128바이트**다 — 계정 64, 비밀번호 64. 각각 널로 끝나고 남는 자리는
//! 난수로 채운다(0으로 채우면 길이가 그대로 드러난다).
//!
//! 암호는 openssl 로 한다. VeNCrypt 의 TLS 때문에 이미 있는 의존성이고, DH 모듈러 지수승·MD5·
//! AES-ECB 가 전부 거기 있다.

use anyhow::{bail, Result};
use openssl::bn::{BigNum, BigNumContext};
use openssl::hash::{hash, MessageDigest};
use openssl::rand::rand_bytes;
use openssl::symm::{Cipher, Crypter, Mode};

/// 자격증명 블록의 한 칸 크기(계정·비밀번호 각각).
const FIELD_LEN: usize = 64;

/// 자격증명 블록 전체 크기. 규격이 고정값으로 정했다.
pub const CREDENTIALS_LEN: usize = FIELD_LEN * 2;

/// 우리가 받아들이는 최대 키 길이.
///
/// 실제로는 128바이트(1024비트)가 온다. 상한이 없으면 서버가 알린 길이를 그대로 믿고 그만큼
/// 할당·연산하게 된다.
const MAX_KEY_LEN: usize = 512;

/// 서버가 보낸 DH 매개변수.
#[derive(Debug)]
pub struct ServerParams {
    pub generator: u16,
    pub modulus: Vec<u8>,
    pub public_key: Vec<u8>,
}

/// 우리가 보낼 것.
#[derive(Debug)]
pub struct ClientResponse {
    /// AES 로 암호화된 128바이트 자격증명.
    pub credentials: Vec<u8>,
    /// 우리 공개키. **모듈러스와 같은 길이로 왼쪽을 0으로 채운다** — 짧게 보내면 서버가 다른 수로
    /// 읽어 공유 비밀이 어긋난다(그 실패는 "비밀번호가 틀렸다" 로만 보인다).
    pub public_key: Vec<u8>,
}

/// 서버 매개변수의 앞부분(generator·keyLength)을 읽어 길이를 알아낸다.
pub fn parse_header(head: [u8; 4]) -> Result<(u16, usize)> {
    let generator = u16::from_be_bytes([head[0], head[1]]);
    let key_len = usize::from(u16::from_be_bytes([head[2], head[3]]));
    if generator < 2 {
        bail!("ARD: generator 가 비정상입니다({generator})");
    }
    if key_len == 0 || key_len > MAX_KEY_LEN {
        bail!("ARD: 키 길이가 비정상입니다({key_len})");
    }
    Ok((generator, key_len))
}

/// DH 를 맞추고 자격증명을 암호화한다.
pub fn respond(params: &ServerParams, username: &str, password: &str) -> Result<ClientResponse> {
    let key_len = params.modulus.len();
    if params.public_key.len() != key_len {
        bail!("ARD: 서버 공개키 길이가 모듈러스와 다릅니다");
    }

    let modulus = BigNum::from_slice(&params.modulus)?;
    let generator = BigNum::from_u32(u32::from(params.generator))?;
    let server_public = BigNum::from_slice(&params.public_key)?;

    // 우리 비밀값. 모듈러스와 같은 비트 수로 뽑는다.
    let mut private = BigNum::new()?;
    private.rand(
        (key_len * 8) as i32,
        openssl::bn::MsbOption::MAYBE_ZERO,
        false,
    )?;

    let mut context = BigNumContext::new()?;
    let mut public = BigNum::new()?;
    public.mod_exp(&generator, &private, &modulus, &mut context)?;
    let mut shared = BigNum::new()?;
    shared.mod_exp(&server_public, &private, &modulus, &mut context)?;

    // **왼쪽을 0으로 채워 고정 길이로 만든다.** to_vec() 는 앞의 0을 떼어 버려서, 그런 값이 나온
    // 세션에서만 인증이 실패한다(재현이 어려운 종류의 버그다).
    let secret = shared.to_vec_padded(key_len as i32)?;
    let digest = hash(MessageDigest::md5(), &secret)?;

    let plain = credentials_block(username, password)?;
    let credentials = encrypt_ecb(&digest, &plain)?;

    Ok(ClientResponse {
        credentials,
        public_key: public.to_vec_padded(key_len as i32)?,
    })
}

/// 계정 64바이트 + 비밀번호 64바이트. 각각 널로 끝나고 남는 자리는 난수다.
fn credentials_block(username: &str, password: &str) -> Result<Vec<u8>> {
    let mut block = vec![0_u8; CREDENTIALS_LEN];
    rand_bytes(&mut block)?;
    write_field(&mut block[..FIELD_LEN], username)?;
    write_field(&mut block[FIELD_LEN..], password)?;
    Ok(block)
}

fn write_field(slot: &mut [u8], value: &str) -> Result<()> {
    let bytes = value.as_bytes();
    // 널까지 들어가야 하므로 63바이트까지만 담을 수 있다.
    if bytes.len() >= FIELD_LEN {
        bail!("ARD: 계정 또는 비밀번호가 너무 깁니다(63바이트까지)");
    }
    slot[..bytes.len()].copy_from_slice(bytes);
    slot[bytes.len()] = 0;
    Ok(())
}

/// AES-128-ECB, **패딩 없이**. 입력이 이미 블록 크기의 배수다.
///
/// 패딩을 켜면 16바이트가 더 붙어 144바이트가 나가고, 서버는 그 뒤를 다음 메시지로 읽는다.
fn encrypt_ecb(key: &[u8], plain: &[u8]) -> Result<Vec<u8>> {
    let cipher = Cipher::aes_128_ecb();
    let mut crypter = Crypter::new(cipher, Mode::Encrypt, key, None)?;
    crypter.pad(false);
    let mut out = vec![0_u8; plain.len() + cipher.block_size()];
    let mut count = crypter.update(plain, &mut out)?;
    count += crypter.finalize(&mut out[count..])?;
    out.truncate(count);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 실제로 오는 1024비트 그룹 대신 작은 안전 소수로 대수를 확인한다.
    ///
    /// 여기서 보는 것은 "DH 양쪽이 같은 비밀에 도달하는가" 이고, 그것은 크기와 무관하다.
    fn small_params() -> (BigNum, BigNum) {
        // 2^127 - 1(메르센 소수)과 생성자 2.
        let modulus = BigNum::from_hex_str("7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF").unwrap();
        (modulus, BigNum::from_u32(2).unwrap())
    }

    #[test]
    fn both_sides_reach_the_same_secret() {
        // 서버 역할을 흉내내 우리 응답의 공개키로 같은 비밀이 나오는지 본다. 어긋나면 서버는
        // "비밀번호가 틀렸다" 만 말하므로, 여기서 걸러야 한다.
        let (modulus, generator) = small_params();
        let key_len = modulus.to_vec().len();
        let mut context = BigNumContext::new().unwrap();

        let mut server_private = BigNum::new().unwrap();
        server_private
            .rand(64, openssl::bn::MsbOption::MAYBE_ZERO, false)
            .unwrap();
        let mut server_public = BigNum::new().unwrap();
        server_public
            .mod_exp(&generator, &server_private, &modulus, &mut context)
            .unwrap();

        let params = ServerParams {
            generator: 2,
            modulus: modulus.to_vec_padded(key_len as i32).unwrap(),
            public_key: server_public.to_vec_padded(key_len as i32).unwrap(),
        };
        let response = respond(&params, "operator", "긴-비밀번호").unwrap();

        // 서버가 계산하는 비밀.
        let client_public = BigNum::from_slice(&response.public_key).unwrap();
        let mut server_secret = BigNum::new().unwrap();
        server_secret
            .mod_exp(&client_public, &server_private, &modulus, &mut context)
            .unwrap();
        let key = hash(
            MessageDigest::md5(),
            &server_secret.to_vec_padded(key_len as i32).unwrap(),
        )
        .unwrap();

        // 그 키로 풀면 우리가 넣은 계정·비밀번호가 나와야 한다.
        let cipher = Cipher::aes_128_ecb();
        let mut crypter = Crypter::new(cipher, Mode::Decrypt, &key, None).unwrap();
        crypter.pad(false);
        let mut plain = vec![0_u8; response.credentials.len() + cipher.block_size()];
        let mut count = crypter.update(&response.credentials, &mut plain).unwrap();
        count += crypter.finalize(&mut plain[count..]).unwrap();
        plain.truncate(count);

        let read_field = |slot: &[u8]| {
            let end = slot.iter().position(|byte| *byte == 0).unwrap();
            String::from_utf8(slot[..end].to_vec()).unwrap()
        };
        assert_eq!(read_field(&plain[..FIELD_LEN]), "operator");
        assert_eq!(read_field(&plain[FIELD_LEN..]), "긴-비밀번호");
    }

    #[test]
    fn encrypts_exactly_128_bytes() {
        // 패딩이 켜지면 144바이트가 나가고 서버는 그 뒤를 다음 메시지로 읽는다.
        let (modulus, generator) = small_params();
        let key_len = modulus.to_vec().len();
        let mut context = BigNumContext::new().unwrap();
        let mut server_public = BigNum::new().unwrap();
        server_public
            .mod_exp(&generator, &BigNum::from_u32(7).unwrap(), &modulus, &mut context)
            .unwrap();

        let params = ServerParams {
            generator: 2,
            modulus: modulus.to_vec_padded(key_len as i32).unwrap(),
            public_key: server_public.to_vec_padded(key_len as i32).unwrap(),
        };
        let response = respond(&params, "u", "p").unwrap();
        assert_eq!(response.credentials.len(), CREDENTIALS_LEN);
        // 공개키도 모듈러스와 같은 길이여야 한다.
        assert_eq!(response.public_key.len(), key_len);
    }

    #[test]
    fn fills_the_unused_room_with_random_bytes() {
        // 0으로 채우면 비밀번호 길이가 그대로 드러난다.
        let first = credentials_block("u", "p").unwrap();
        let second = credentials_block("u", "p").unwrap();
        assert_ne!(first, second, "남는 자리는 난수여야 한다");
        // 널 종료는 그대로 있어야 한다.
        assert_eq!(first[1], 0);
        assert_eq!(first[FIELD_LEN + 1], 0);
    }

    #[test]
    fn refuses_a_field_that_cannot_fit() {
        // 잘라 보내면 서버가 다른 계정으로 인증을 시도한다.
        assert!(credentials_block(&"a".repeat(64), "p").is_err());
        assert!(credentials_block("u", &"b".repeat(70)).is_err());
    }

    #[test]
    fn refuses_absurd_headers() {
        // 서버가 알린 길이를 그대로 믿으면 그만큼 할당·연산한다.
        assert!(parse_header([0, 2, 0, 128]).is_ok());
        assert!(parse_header([0, 0, 0, 128]).is_err(), "generator 0");
        assert!(parse_header([0, 2, 0, 0]).is_err(), "키 길이 0");
        assert!(parse_header([0, 2, 0xFF, 0xFF]).is_err(), "키 길이 65535");
    }
}
