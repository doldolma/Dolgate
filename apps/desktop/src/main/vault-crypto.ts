import { argon2id } from "@noble/hashes/argon2.js";
import type { Argon2idDerive } from "@dolssh/shared-core";

// E2EE 동기화 볼트의 KEK 유도(Argon2id) — shared-core 계약(Argon2idDerive)에 맞춘
// 데스크톱 구현. 순수 JS(@noble/hashes)지만 V8에서는 기본 파라미터(64MiB, t=3) 기준
// ~2초로, 기기당 1회성 잠금해제 용도로 충분하다(네이티브 모듈 의존성 없음).
// 구현 간 일치는 shared-core 의 vault-test-vectors.json 공유 벡터로 검증한다.
export const desktopArgon2idDerive: Argon2idDerive = async (
  passphrase,
  salt,
  params,
) =>
  argon2id(passphrase, salt, {
    t: params.timeCost,
    m: params.memoryKib,
    p: params.parallelism,
    dkLen: params.outputLength,
  });
