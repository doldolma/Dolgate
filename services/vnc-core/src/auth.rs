//! VNC Authentication (보안 타입 2).
//!
//! 서버가 16바이트 챌린지를 보내고, 클라이언트가 비밀번호로 만든 DES 키로 그것을 암호화해
//! 그대로 돌려준다. 8바이트 블록 두 개를 **각각** ECB 로 암호화한다.
//!
//! **키를 만드는 규칙이 함정이다.** 비밀번호를 8바이트로 자르거나 0 으로 채운 뒤, 각 바이트의
//! **비트 순서를 뒤집어** DES 키로 쓴다. 1998년 AT&T 구현이 DES 키의 비트를 반대 방향으로
//! 읽었고, 그 뒤 모든 서버가 그 동작에 맞춰졌다. 뒤집지 않으면 비밀번호가 맞아도 인증이
//! 실패하는데, 서버는 "authentication failed" 만 돌려주므로 원인을 알 수 없다.
//!
//! 보안 성질을 오해하지 않도록: 이 방식은 비밀번호를 8자로 자르고 DES 를 쓰므로 그 자체로는
//! 보호 수단이 아니다. 전송 보호는 VeNCrypt(TLS)나 SSH·tailnet 터널이 담당한다.

use des::cipher::{generic_array::GenericArray, BlockEncrypt, KeyInit};
use des::Des;

/// VncAuth 챌린지 길이. 응답도 같은 길이다.
pub const CHALLENGE_LEN: usize = 16;

/// DES 키로 쓰기 위해 비밀번호를 8바이트로 맞춘다.
///
/// 8자를 넘으면 잘린다 — 규격이 그렇다. 사용자에게는 9자 이상이 무시된다는 사실을 알려야 한다.
fn key_from_password(password: &str) -> [u8; 8] {
    let mut key = [0_u8; 8];
    for (slot, byte) in key.iter_mut().zip(password.as_bytes()) {
        *slot = reverse_bits(*byte);
    }
    key
}

/// 한 바이트의 비트 순서를 뒤집는다(0b1000_0000 ↔ 0b0000_0001).
fn reverse_bits(byte: u8) -> u8 {
    byte.reverse_bits()
}

/// 챌린지에 대한 응답을 만든다.
pub fn respond_to_challenge(password: &str, challenge: &[u8; CHALLENGE_LEN]) -> [u8; CHALLENGE_LEN] {
    let key = key_from_password(password);
    let cipher = Des::new(GenericArray::from_slice(&key));

    let mut response = [0_u8; CHALLENGE_LEN];
    response.copy_from_slice(challenge);
    // 8바이트 블록 두 개를 각각 암호화한다. CBC 가 아니므로 블록 사이에 연결이 없다.
    for block in response.chunks_exact_mut(8) {
        let mut buffer = GenericArray::clone_from_slice(block);
        cipher.encrypt_block(&mut buffer);
        block.copy_from_slice(&buffer);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reverses_bits_within_each_byte() {
        assert_eq!(reverse_bits(0b0000_0001), 0b1000_0000);
        assert_eq!(reverse_bits(0b1111_0000), 0b0000_1111);
        assert_eq!(reverse_bits(0x00), 0x00);
        assert_eq!(reverse_bits(0xFF), 0xFF);
        // 'a' = 0x61 = 0b0110_0001 → 0b1000_0110 = 0x86
        assert_eq!(reverse_bits(b'a'), 0x86);
    }

    #[test]
    fn truncates_and_pads_the_password_to_eight_bytes() {
        // 8자를 넘으면 잘린다 — 규격이 그렇고, 서버도 같은 키를 만든다.
        assert_eq!(
            key_from_password("passwordX"),
            key_from_password("password")
        );
        // 짧으면 0 으로 채운다(0 은 뒤집어도 0 이다).
        let short = key_from_password("ab");
        assert_eq!(short[0], reverse_bits(b'a'));
        assert_eq!(short[1], reverse_bits(b'b'));
        assert_eq!(&short[2..], &[0, 0, 0, 0, 0, 0]);
    }

    // 독립 구현(OpenSSL DES-ECB)으로 만든 골든 벡터.
    //
    // 우리 코드끼리 비교하면 비트 반전을 빼먹어도 통과한다. 그래서 키·평문을 고정해 외부
    // 구현으로 미리 뽑은 암호문을 박아 둔다 — 비트 반전이나 블록 분할을 잘못 고치면 여기서
    // 깨진다.
    //
    // 비밀번호 "dolgate" → 비트 반전 키 26F636E6862EA600. 두 구현이 같은 값을 냈다:
    //   openssl enc -des-ecb -provider legacy -provider default -K 26F636E6862EA600 -nopad
    //   cryptography 의 TripleDES(key*3)  (세 키가 같은 3DES 는 단일 DES 와 같다)
    #[test]
    fn matches_an_independent_des_implementation() {
        let challenge: [u8; CHALLENGE_LEN] = [
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, //
            0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF,
        ];
        let response = respond_to_challenge("dolgate", &challenge);
        assert_eq!(
            response,
            [
                0x5F, 0x0F, 0xCF, 0x3F, 0x24, 0xC3, 0xF0, 0x78, //
                0xB9, 0x37, 0x93, 0x11, 0x06, 0x03, 0x66, 0x58,
            ]
        );
    }

    #[test]
    fn encrypts_each_block_independently() {
        // 두 블록이 같으면 응답도 같아야 한다. 다르면 CBC 처럼 연결한 것이다.
        let challenge = [0xAB_u8; CHALLENGE_LEN];
        let response = respond_to_challenge("secret", &challenge);
        assert_eq!(&response[0..8], &response[8..16]);
    }
}
