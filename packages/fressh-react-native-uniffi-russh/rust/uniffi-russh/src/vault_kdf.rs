//! E2EE 동기화 볼트의 KEK 유도(Argon2id, RFC 9106).
//!
//! JS 쪽 계약은 packages/shared-core/src/vault.ts 의 `Argon2idDerive` 이고, 구현 간
//! 일치는 packages/shared-core/src/vault-test-vectors.json 공유 벡터로 보장한다.
//! Hermes(JIT 없음)에서 순수 JS 메모리-하드 KDF 는 비현실적으로 느려서 이 함수만
//! 네이티브로 내려보낸다.

use argon2::{Algorithm, Argon2, Params, Version};
use thiserror::Error;

#[derive(Debug, Error, uniffi::Error)]
pub enum VaultKdfError {
    #[error("invalid kdf params: {0}")]
    InvalidParams(String),
    #[error("kdf derive failed: {0}")]
    Derive(String),
}

fn derive_argon2id_key_sync(
    passphrase: Vec<u8>,
    salt: Vec<u8>,
    memory_kib: u32,
    time_cost: u32,
    parallelism: u32,
    output_length: u32,
) -> Result<Vec<u8>, VaultKdfError> {
    let params = Params::new(
        memory_kib,
        time_cost,
        parallelism,
        Some(output_length as usize),
    )
    .map_err(|error| VaultKdfError::InvalidParams(error.to_string()))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut output = vec![0u8; output_length as usize];
    argon
        .hash_password_into(&passphrase, &salt, &mut output)
        .map_err(|error| VaultKdfError::Derive(error.to_string()))?;
    Ok(output)
}

#[uniffi::export(async_runtime = "tokio")]
pub async fn derive_argon2id_key(
    passphrase: Vec<u8>,
    salt: Vec<u8>,
    memory_kib: u32,
    time_cost: u32,
    parallelism: u32,
    output_length: u32,
) -> Result<Vec<u8>, VaultKdfError> {
    tokio::task::spawn_blocking(move || {
        derive_argon2id_key_sync(
            passphrase,
            salt,
            memory_kib,
            time_cost,
            parallelism,
            output_length,
        )
    })
    .await
    .map_err(|error| VaultKdfError::Derive(format!("kdf worker failed: {error}")))?
}

#[cfg(test)]
mod tests {
    use super::derive_argon2id_key_sync;
    use base64::Engine as _;

    // shared-core 의 공유 테스트 벡터 — JS(@noble/hashes)·Go(x/crypto) 구현과 같은 값이
    // 나와야 세 구현이 상호 교환 가능하다.
    const SHARED_VECTORS: &str =
        include_str!("../../../../shared-core/src/vault-test-vectors.json");

    #[test]
    fn matches_shared_kdf_test_vectors() {
        let parsed: serde_json::Value =
            serde_json::from_str(SHARED_VECTORS).expect("parse shared vectors");
        let vectors = parsed["kdf"].as_array().expect("kdf vectors");
        assert!(!vectors.is_empty());

        let base64 = base64::engine::general_purpose::STANDARD;
        for vector in vectors {
            let passphrase = vector["passphrase"].as_str().unwrap().as_bytes().to_vec();
            let salt = base64
                .decode(vector["saltBase64"].as_str().unwrap())
                .unwrap();
            let expected = base64
                .decode(vector["kekBase64"].as_str().unwrap())
                .unwrap();

            let derived = derive_argon2id_key_sync(
                passphrase,
                salt,
                vector["memoryKib"].as_u64().unwrap() as u32,
                vector["timeCost"].as_u64().unwrap() as u32,
                vector["parallelism"].as_u64().unwrap() as u32,
                32,
            )
            .expect("derive");
            assert_eq!(derived, expected, "vector mismatch: {vector}");
        }
    }

    #[test]
    fn rejects_invalid_params() {
        let result = derive_argon2id_key_sync(b"passphrase".to_vec(), vec![0u8; 16], 0, 0, 0, 32);
        assert!(result.is_err());
    }
}
