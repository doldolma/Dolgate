import { RnRussh } from '@fressh/react-native-uniffi-russh';
import type { Argon2idDerive } from '@dolssh/shared-core';

// uniffi Rust 의 네이티브 Argon2id 를 shared-core 계약(Argon2idDerive)에 맞춘 어댑터.
// Hermes 순수 JS 로는 메모리-하드 KDF 가 비현실적으로 느려 네이티브로 내려보낸다.
// 구현 일치는 shared-core 의 vault-test-vectors.json 을 Rust 테스트가 검증한다.
export const nativeArgon2idDerive: Argon2idDerive = async (
  passphrase,
  salt,
  params,
) => RnRussh.deriveArgon2idKey(passphrase, salt, params);
