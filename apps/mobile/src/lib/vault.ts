import type { Argon2idDerive } from '@dolssh/shared-core';

import { getEngine } from '../engine';

// 활성 SSH 엔진의 네이티브 Argon2id 를 shared-core 계약(Argon2idDerive)에 맞춘 어댑터.
// Hermes 순수 JS 로는 메모리-하드 KDF 가 비현실적으로 느려 어느 쪽이든 네이티브로
// 내려보내는데, 엔진을 경유하면 볼트도 선택된 엔진을 따라가므로 구현이 한쪽에
// 고정되지 않는다.
//
// 두 구현 모두 shared-core 의 vault-test-vectors.json 으로 검증된다(Rust 는 자체
// 테스트, Go 는 mobile/vaultkdf). 그래서 엔진을 바꿔도 유도 키가 달라지지 않는다 —
// KEK 가 1바이트라도 다르면 기존 볼트를 복호화할 수 없으므로 이게 핵심이다.
export const nativeArgon2idDerive: Argon2idDerive = async (
  passphrase,
  salt,
  params,
) => getEngine().deriveArgon2idKey(passphrase, salt, params);
