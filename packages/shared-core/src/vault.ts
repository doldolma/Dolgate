import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes, utf8ToBytes } from "@noble/ciphers/utils.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { VaultBootstrap, VaultKdfDescriptor } from "./api";
// base64-js(CommonJS)는 vite dev 의 링크드 소스 경로에서 named import 인터롭이 깨져
// 렌더러를 통째로 죽인다 — shared-core 안에서는 무의존 구현을 쓴다(base64.ts 참고).
import { base64ToBytes, bytesToBase64 } from "./base64";

// E2EE 볼트(v2)의 클라이언트측 암호학.
//
//   동기화 암호 --NFC 정규화--> Argon2id(salt, cost) --> KEK(32B)
//   DEK(32B, 클라 생성) --AES-256-GCM wrap--> base64(iv(12) || ciphertext(32) || tag(16))
//
// wrap 결과(60바이트)는 서버 /auth/vault 의 형식 검증 범위(44~128바이트)와 짝을 이룬다.
// Argon2id 자체는 플랫폼별 구현(모바일: uniffi Rust, 데스크톱: @noble/hashes)을 주입받고,
// 구현 간 일치는 vault-test-vectors.json 공유 벡터로 보장한다.

export const VAULT_DEK_BYTE_LENGTH = 32;
export const VAULT_KEK_BYTE_LENGTH = 32;
export const VAULT_KDF_SALT_BYTE_LENGTH = 16;
export const VAULT_WRAP_IV_BYTE_LENGTH = 12;
export const VAULT_KDF_ALGORITHM = "argon2id";

// push 시 자기 DEK 세대(epoch)를 실어 보내는 헤더. 서버는 이 값을 트랜잭션 내 fence 로
// 대조해 옛 세대의 쓰기를 커밋 시점에 거부한다.
export const VAULT_EPOCH_HEADER = "X-Dolgate-Vault-Epoch";

// push 거부 응답의 code — 두 값 모두 "세션을 갱신해 볼트를 재판정하라"로 처리한다.
// (vault_reset: 볼트 부재(초기화 직후) / vault_dek_mismatch: DEK 세대 불일치)
export const VAULT_RESET_CODE = "vault_reset";
export const VAULT_DEK_MISMATCH_CODE = "vault_dek_mismatch";

export function isVaultEpochRejectionCode(
  code: string | null | undefined,
): boolean {
  return code === VAULT_RESET_CODE || code === VAULT_DEK_MISMATCH_CODE;
}

// verifier 유도 라벨. 값 변경 = 전 기기 재검증 실패이므로 버전 접미사로만 교체한다.
const VAULT_DEK_VERIFIER_LABEL = "dolgate-dek-verifier-v1";

// DEK 공개 검증자 — HMAC-SHA256(key=DEK, msg=고정라벨)의 base64. 256비트 랜덤 DEK 에서
// 역산·복호화가 불가능하므로 서버에 저장해도 zero-knowledge 가 유지되고, 클라이언트는
// 캐시한 DEK 가 현재 볼트의 DEK 인지 데이터 유무와 무관하게 즉시 판정할 수 있다.
export function computeVaultDekVerifier(dek: Uint8Array): string {
  if (dek.length !== VAULT_DEK_BYTE_LENGTH) {
    throw new Error("잘못된 DEK 길이입니다.");
  }
  return bytesToBase64(hmac(sha256, dek, utf8ToBytes(VAULT_DEK_VERIFIER_LABEL)));
}

// RFC 9106 second recommendation(m=64MiB, t=3, p=1) — 모바일 기기에서도 부담 없는 축.
// 파라미터는 서버 descriptor 에 저장되므로 이후 릴리스에서 자유롭게 올릴 수 있다.
export const VAULT_KDF_DEFAULT_COST = {
  memoryKib: 64 * 1024,
  timeCost: 3,
  parallelism: 1,
} as const;

// salt 는 포맷 범위로 검증하고, 비용은 앱이 실제 검증한 프로필과 정확히 일치해야 한다.
// 새 프로필은 클라이언트 지원을 먼저 배포한 뒤 이 목록과 서버 검증을 함께 확장한다.
export const VAULT_KDF_LIMITS = {
  saltBytesMin: 16,
  saltBytesMax: 64,
} as const;

export interface VaultKdfCost {
  memoryKib: number;
  timeCost: number;
  parallelism: number;
}

export interface VaultCacheRecord {
  version: 2;
  // Keychain 캐시가 인증 세션보다 오래 남을 수 있으므로 캐시의 계정/서버 소유자를 함께
  // 기록한다. owner 도입 전 desktop/mobile 캐시를 읽기 위해 optional이다.
  owner?: VaultCacheOwner;
  dekBase64: string;
  epoch: number;
  wrapRevision?: number;
  // v1 pre-seed 캐시에는 descriptor가 없다. 세 필드는 v2에서만 항상 함께 존재한다.
  wrappedDekBase64?: string;
  kdf?: VaultKdfDescriptor;
  dekVerifierBase64?: string;
}

export interface VaultCacheOwner {
  serverUrl: string;
  userId: string;
}

export const VAULT_PASSPHRASE_MIN_LENGTH = 4;

// 새로 설정하는 동기화 암호의 공통 정책. 입력값 자체는 trim하지 않는다. 앞뒤 공백도
// 암호의 일부이지만, 공백만으로 이루어진 값은 실수 가능성이 높아 거부한다.
export function validateNewVaultPassphrase(passphrase: string): string | null {
  const normalized = passphrase.normalize("NFC");
  if (normalized.trim().length === 0) {
    return "동기화 암호에 문자를 입력해 주세요.";
  }
  if (Array.from(normalized).length < VAULT_PASSPHRASE_MIN_LENGTH) {
    return `동기화 암호는 ${VAULT_PASSPHRASE_MIN_LENGTH}자 이상이어야 합니다.`;
  }
  return null;
}

export function assertValidNewVaultPassphrase(passphrase: string): void {
  const message = validateNewVaultPassphrase(passphrase);
  if (message) {
    throw new Error(message);
  }
}

export function isSupportedVaultKdfDescriptor(
  kdf: VaultKdfDescriptor,
): boolean {
  if (
    kdf.algorithm !== VAULT_KDF_ALGORITHM ||
    kdf.memoryKib !== VAULT_KDF_DEFAULT_COST.memoryKib ||
    kdf.timeCost !== VAULT_KDF_DEFAULT_COST.timeCost ||
    kdf.parallelism !== VAULT_KDF_DEFAULT_COST.parallelism
  ) {
    return false;
  }
  try {
    const salt = base64ToBytes(kdf.saltBase64);
    return (
      salt.length >= VAULT_KDF_LIMITS.saltBytesMin &&
      salt.length <= VAULT_KDF_LIMITS.saltBytesMax
    );
  } catch {
    return false;
  }
}

export function parseVaultCacheRecord(raw: string): VaultCacheRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<VaultCacheRecord>;
    if (
      value.version !== 2 ||
      typeof value.dekBase64 !== "string" ||
      typeof value.epoch !== "number" ||
      !Number.isSafeInteger(value.epoch) ||
      value.epoch < 0
    ) {
      return null;
    }
    if (
      value.owner !== undefined &&
      (typeof value.owner !== "object" ||
        value.owner === null ||
        typeof value.owner.serverUrl !== "string" ||
        value.owner.serverUrl.length === 0 ||
        typeof value.owner.userId !== "string" ||
        value.owner.userId.length === 0)
    ) {
      return null;
    }
    if (
      value.wrapRevision !== undefined &&
      (typeof value.wrapRevision !== "number" ||
        !Number.isSafeInteger(value.wrapRevision) ||
        value.wrapRevision < 0)
    ) {
      return null;
    }
    const hasAnyDescriptorField =
      value.wrappedDekBase64 !== undefined ||
      value.kdf !== undefined ||
      value.dekVerifierBase64 !== undefined;
    if (
      hasAnyDescriptorField &&
      (typeof value.wrappedDekBase64 !== "string" ||
        typeof value.dekVerifierBase64 !== "string" ||
        !value.kdf ||
        !isSupportedVaultKdfDescriptor(value.kdf))
    ) {
      return null;
    }
    const dek = base64ToBytes(value.dekBase64);
    if (
      dek.length !== VAULT_DEK_BYTE_LENGTH ||
      (value.dekVerifierBase64 !== undefined &&
        computeVaultDekVerifier(dek) !== value.dekVerifierBase64)
    ) {
      return null;
    }
    return value as VaultCacheRecord;
  } catch {
    return null;
  }
}

// 플랫폼별 Argon2id 구현 시그니처. outputLength 바이트의 유도 키를 돌려준다.
export type Argon2idDerive = (
  passphrase: Uint8Array,
  salt: Uint8Array,
  params: VaultKdfCost & { outputLength: number },
) => Promise<Uint8Array>;

export function createVaultDek(): Uint8Array {
  return randomBytes(VAULT_DEK_BYTE_LENGTH);
}

export function createVaultKdfDescriptor(
  cost: VaultKdfCost = VAULT_KDF_DEFAULT_COST,
): VaultKdfDescriptor {
  return {
    algorithm: VAULT_KDF_ALGORITHM,
    saltBase64: bytesToBase64(randomBytes(VAULT_KDF_SALT_BYTE_LENGTH)),
    memoryKib: cost.memoryKib,
    timeCost: cost.timeCost,
    parallelism: cost.parallelism,
  };
}

// 동기화 암호에서 KEK 를 유도한다. 유니코드 정규화(NFC)를 강제해 같은 암호가 입력기에
// 따라 다른 바이트열이 되는 문제(한글 자모 분해 등)를 막고, 서버가 내려준 KDF 파라미터를
// 실행 전에 지원 프로필을 검증한다(서버 descriptor 는 신뢰 대상이 아니다).
export async function deriveVaultKek(
  argon2id: Argon2idDerive,
  passphrase: string,
  kdf: VaultKdfDescriptor,
): Promise<Uint8Array> {
  if (kdf.algorithm !== VAULT_KDF_ALGORITHM) {
    throw new Error(`지원하지 않는 KDF 알고리즘입니다: ${kdf.algorithm}`);
  }
  if (
    kdf.memoryKib !== VAULT_KDF_DEFAULT_COST.memoryKib ||
    kdf.timeCost !== VAULT_KDF_DEFAULT_COST.timeCost ||
    kdf.parallelism !== VAULT_KDF_DEFAULT_COST.parallelism
  ) {
    throw new Error("지원하지 않는 KDF 파라미터입니다.");
  }
  let salt: Uint8Array;
  try {
    salt = base64ToBytes(kdf.saltBase64);
  } catch {
    throw new Error("잘못된 KDF salt 형식입니다.");
  }
  if (
    salt.length < VAULT_KDF_LIMITS.saltBytesMin ||
    salt.length > VAULT_KDF_LIMITS.saltBytesMax
  ) {
    throw new Error("잘못된 KDF salt 형식입니다.");
  }
  const normalized = passphrase.normalize("NFC");
  const passphraseBytes = utf8ToBytes(normalized);
  return argon2id(passphraseBytes, salt, {
    memoryKib: kdf.memoryKib,
    timeCost: kdf.timeCost,
    parallelism: kdf.parallelism,
    outputLength: VAULT_KEK_BYTE_LENGTH,
  });
}

export function wrapVaultDek(dek: Uint8Array, kek: Uint8Array): string {
  if (dek.length !== VAULT_DEK_BYTE_LENGTH) {
    throw new Error("잘못된 DEK 길이입니다.");
  }
  if (kek.length !== VAULT_KEK_BYTE_LENGTH) {
    throw new Error("잘못된 KEK 길이입니다.");
  }
  const iv = randomBytes(VAULT_WRAP_IV_BYTE_LENGTH);
  return wrapVaultDekWithIv(dek, kek, iv);
}

// 테스트 벡터 검증용으로 iv 를 주입받는 내부 변형. 프로덕션 경로는 wrapVaultDek 를 쓴다.
export function wrapVaultDekWithIv(
  dek: Uint8Array,
  kek: Uint8Array,
  iv: Uint8Array,
): string {
  const sealed = gcm(kek, iv).encrypt(dek);
  const wrapped = new Uint8Array(iv.length + sealed.length);
  wrapped.set(iv);
  wrapped.set(sealed, iv.length);
  return bytesToBase64(wrapped);
}

// 잘못된 동기화 암호(=잘못된 KEK)는 GCM 인증 실패로 여기서 throw 된다.
export function unwrapVaultDek(
  wrappedDekBase64: string,
  kek: Uint8Array,
): Uint8Array {
  const wrapped = base64ToBytes(wrappedDekBase64);
  if (wrapped.length <= VAULT_WRAP_IV_BYTE_LENGTH) {
    throw new Error("잘못된 볼트 키 형식입니다.");
  }
  const iv = wrapped.slice(0, VAULT_WRAP_IV_BYTE_LENGTH);
  const sealed = wrapped.slice(VAULT_WRAP_IV_BYTE_LENGTH);
  const dek = gcm(kek, iv).decrypt(sealed);
  if (dek.length !== VAULT_DEK_BYTE_LENGTH) {
    throw new Error("잘못된 볼트 키 형식입니다.");
  }
  return dek;
}

// 세션 응답의 vaultBootstrap 을 클라이언트 상태 분기로 정규화한다.
// version 필드가 없는 응답은 v2 도입 이전 서버 — keyBase64 유무로 v1 을 판별한다.
export type VaultDescriptorState =
  | { kind: "setup-required"; epoch?: number }
  | {
      kind: "legacy";
      keyBase64: string;
      epoch?: number;
      e2eeRequired?: boolean;
    }
  | {
      kind: "e2ee";
      wrappedDekBase64: string;
      kdf: VaultKdfDescriptor;
      // DEK 세대 번호. epoch 도입 이전 서버는 안 내려주므로 optional(0 취급).
      epoch?: number;
      // DEK 공개 검증자. 도입 이전 볼트/서버는 안 내려주므로 optional(검증 불가 취급).
      dekVerifierBase64?: string;
      // 같은 DEK 세대 안의 wrapper/KDF 개정 번호. 도입 이전 descriptor는 0 취급.
      wrapRevision?: number;
    };

// 서버 GET /sync 의 ETag / push 응답 revision 을 클라이언트가 If-None-Match 로 되돌려보낼
// 형식으로 만든다. 서버(fmt.Sprintf("\"%d\"", n))와 반드시 바이트 동일해야 304 가 걸린다.
export function formatSyncRevisionEtag(revision: number): string {
  return `"${revision}"`;
}

// ETag 문자열("\"42\"")에서 리비전 숫자를 꺼낸다. push 응답 리비전을 "직전 pull+1 일 때만
// 저장" 하는 규칙(중간에 낀 다른 기기의 push 를 건너뛰지 않기 위함)에 쓴다.
export function parseSyncRevisionEtag(etag: string | null): number | null {
  if (!etag) {
    return null;
  }
  const match = /^"(\d+)"$/.exec(etag.trim());
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

// e2ee 볼트에서 캐시된 DEK 를 어떻게 처리할지 결정하는 순수 함수. 데스크톱·모바일이
// 각자 런타임(키체인/시크릿스토어, 상태머신)에서 이 결정을 적용한다.
//
// 판정은 두 축뿐이다:
//  - epoch(세대 순서): descriptor 의 epoch 이 캐시보다 낮으면 낡은 응답(자기 재설정 직후
//    도착한 옛 descriptor 등)이므로 무시한다. 서버 epoch 은 절대 감소하지 않는다.
//  - verifier(정체성 증명): HMAC(캐시 DEK) == descriptor 의 verifier 면 이 DEK 가 현재
//    볼트의 DEK 임이 증명된다. 불일치면 세대가 바뀐 것(초기화+재설정) — 캐시를 버리고
//    잠근다.
// "로컬 unlocked 신뢰" 휴리스틱이나 최초 신뢰 채택(adopt) 같은 추정이 없다 — verifier 는
// 임의 시점에 로컬에서 계산·대조할 수 있으므로 추정이 필요 없다.
export type VaultAccessDecision =
  // verifier 일치(암호학적 증명) — 캐시 DEK 사용, descriptor 의 epoch 채택.
  | { kind: "unlocked"; epoch: number }
  // 캐시 DEK 없음 또는 verifier 불일치(세대 교체) — 캐시 폐기 후 잠금.
  | { kind: "locked" }
  // descriptor 가 캐시 epoch 보다 낡음 — 아무것도 바꾸지 말고 현 상태 유지.
  | { kind: "ignore-descriptor" }
  // verifier 이전 볼트/구서버 — 검증 수단이 없다. 기존 신뢰(캐시 사용)를 유지하되,
  // 호출자는 잠금해제(암호로 DEK 증명) 후 verifier 를 서버에 백필해 이 상태를 없앤다.
  | { kind: "unlocked-unverifiable"; epoch: number };

export function decideVaultAccess(params: {
  // descriptor(세션 응답) 쪽 — epoch 없으면 0 취급(도입 이전 서버).
  descriptorEpoch: number | undefined;
  descriptorVerifier: string | undefined;
  // 캐시 쪽 — cachedDekVerifier 는 캐시 DEK 로 computeVaultDekVerifier() 를 계산한 값
  // (캐시 DEK 자체가 없으면 null). cachedEpoch 은 캐시에 함께 저장된 epoch(이전 포맷
  // 캐시면 null).
  cachedDekVerifier: string | null;
  cachedEpoch: number | null;
  descriptorWrapRevision?: number;
  cachedWrapRevision?: number | null;
}): VaultAccessDecision {
  const descriptorEpoch = params.descriptorEpoch ?? 0;
  if (params.cachedDekVerifier === null) {
    return { kind: "locked" };
  }
  if (params.cachedEpoch !== null && descriptorEpoch < params.cachedEpoch) {
    return { kind: "ignore-descriptor" };
  }
  if (
    params.cachedEpoch !== null &&
    descriptorEpoch === params.cachedEpoch &&
    (params.descriptorWrapRevision ?? 0) < (params.cachedWrapRevision ?? 0)
  ) {
    return { kind: "ignore-descriptor" };
  }
  if (!params.descriptorVerifier) {
    return { kind: "unlocked-unverifiable", epoch: descriptorEpoch };
  }
  if (params.cachedDekVerifier === params.descriptorVerifier) {
    return { kind: "unlocked", epoch: descriptorEpoch };
  }
  return { kind: "locked" };
}

export function resolveVaultDescriptorState(
  bootstrap: VaultBootstrap,
): VaultDescriptorState {
  const version = bootstrap.version ?? (bootstrap.keyBase64 ? 1 : 0);
  switch (version) {
    case 0:
      return {
        kind: "setup-required",
        ...(bootstrap.epoch !== undefined ? { epoch: bootstrap.epoch } : {}),
      };
    case 1:
      if (!bootstrap.keyBase64) {
        throw new Error("볼트 응답에 키가 없습니다.");
      }
      return {
        kind: "legacy",
        keyBase64: bootstrap.keyBase64,
        ...(bootstrap.epoch !== undefined ? { epoch: bootstrap.epoch } : {}),
        ...(bootstrap.e2eeRequired === true ? { e2eeRequired: true } : {}),
      };
    case 2:
      if (!bootstrap.wrappedDekBase64 || !bootstrap.kdf) {
        throw new Error("볼트 응답에 암호화된 키가 없습니다.");
      }
      return {
        kind: "e2ee",
        wrappedDekBase64: bootstrap.wrappedDekBase64,
        kdf: bootstrap.kdf,
        ...(bootstrap.epoch !== undefined ? { epoch: bootstrap.epoch } : {}),
        ...(bootstrap.dekVerifierBase64
          ? { dekVerifierBase64: bootstrap.dekVerifierBase64 }
          : {}),
        ...(bootstrap.wrapRevision !== undefined
          ? { wrapRevision: bootstrap.wrapRevision }
          : {}),
      };
    default:
      throw new Error(
        `지원하지 않는 볼트 버전입니다(${version}). 앱을 업데이트해 주세요.`,
      );
  }
}
