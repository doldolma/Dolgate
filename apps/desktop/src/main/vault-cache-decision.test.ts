import { describe, expect, it, vi } from "vitest";
import {
  computeVaultDekVerifier,
  decideVaultAccess,
  deriveVaultKek,
  formatSyncRevisionEtag,
  parseSyncRevisionEtag,
  VAULT_KDF_DEFAULT_COST,
} from "@dolssh/shared-core";
import vaultLifecycleScenarios from "@dolssh/shared-core/src/vault-lifecycle-scenarios.json";

describe("formatSyncRevisionEtag", () => {
  it("quotes the revision to match the server ETag format", () => {
    expect(formatSyncRevisionEtag(0)).toBe('"0"');
    expect(formatSyncRevisionEtag(42)).toBe('"42"');
  });
});

describe("parseSyncRevisionEtag", () => {
  it("round-trips the formatted etag", () => {
    expect(parseSyncRevisionEtag(formatSyncRevisionEtag(42))).toBe(42);
    expect(parseSyncRevisionEtag('"0"')).toBe(0);
  });

  it("returns null for missing or malformed values", () => {
    expect(parseSyncRevisionEtag(null)).toBeNull();
    expect(parseSyncRevisionEtag("")).toBeNull();
    expect(parseSyncRevisionEtag("42")).toBeNull();
    expect(parseSyncRevisionEtag('W/"42"')).toBeNull();
    expect(parseSyncRevisionEtag('"abc"')).toBeNull();
  });
});

describe("computeVaultDekVerifier", () => {
  it("is deterministic for the same DEK and differs across DEKs", () => {
    const dekA = new Uint8Array(32).fill(0xa1);
    const dekB = new Uint8Array(32).fill(0xb2);
    expect(computeVaultDekVerifier(dekA)).toBe(computeVaultDekVerifier(dekA));
    expect(computeVaultDekVerifier(dekA)).not.toBe(
      computeVaultDekVerifier(dekB),
    );
  });

  it("rejects a wrong-length DEK (corrupt cache guard)", () => {
    expect(() => computeVaultDekVerifier(new Uint8Array(16))).toThrow();
  });
});

describe("deriveVaultKek parameter bounds", () => {
  // E2EE 의 위협 모델은 서버 불신 — 손상된 서버가 내려준 거대 KDF 파라미터(OOM/행 유발)
  // 를 실행 전에 거부해야 한다.
  const validSalt = Buffer.alloc(16, 0x01).toString("base64");
  const stubArgon2 = vi.fn(async () => new Uint8Array(32));

  it("rejects out-of-range or non-integer params before running the KDF", async () => {
    const badKdfs = [
      { memoryKib: 2 * 1024 * 1024 }, // 2GiB — 모바일 OOM 급
      { memoryKib: 256 * 1024 }, // 상한(128MiB) 초과
      { memoryKib: 1024 }, // 하한 미달(고의로 약화된 KDF)
      { memoryKib: 65536.5 }, // 정수 아님
      { timeCost: 0 },
      { timeCost: 9 },
      { parallelism: 5 },
    ];
    for (const override of badKdfs) {
      stubArgon2.mockClear();
      await expect(
        deriveVaultKek(stubArgon2, "pass", {
          algorithm: "argon2id",
          saltBase64: validSalt,
          ...VAULT_KDF_DEFAULT_COST,
          ...override,
        }),
      ).rejects.toThrow("지원하지 않는 KDF 파라미터입니다.");
      expect(stubArgon2).not.toHaveBeenCalled();
    }
  });

  it("rejects a salt outside 16..64 bytes", async () => {
    stubArgon2.mockClear();
    await expect(
      deriveVaultKek(stubArgon2, "pass", {
        algorithm: "argon2id",
        saltBase64: Buffer.alloc(4, 0x01).toString("base64"),
        ...VAULT_KDF_DEFAULT_COST,
      }),
    ).rejects.toThrow("잘못된 KDF salt 형식입니다.");
    expect(stubArgon2).not.toHaveBeenCalled();
  });

  it("accepts the default cost parameters", async () => {
    stubArgon2.mockClear();
    await expect(
      deriveVaultKek(stubArgon2, "pass", {
        algorithm: "argon2id",
        saltBase64: validSalt,
        ...VAULT_KDF_DEFAULT_COST,
      }),
    ).resolves.toBeInstanceOf(Uint8Array);
    expect(stubArgon2).toHaveBeenCalledTimes(1);
  });
});

describe("decideVaultAccess", () => {
  const verifier = computeVaultDekVerifier(new Uint8Array(32).fill(1));
  const otherVerifier = computeVaultDekVerifier(new Uint8Array(32).fill(2));

  it("locks when there is no cached DEK", () => {
    expect(
      decideVaultAccess({
        descriptorEpoch: 3,
        descriptorVerifier: verifier,
        cachedDekVerifier: null,
        cachedEpoch: null,
      }),
    ).toEqual({ kind: "locked" });
  });

  it("unlocks when the cached DEK verifier matches the descriptor", () => {
    expect(
      decideVaultAccess({
        descriptorEpoch: 3,
        descriptorVerifier: verifier,
        cachedDekVerifier: verifier,
        cachedEpoch: 3,
      }),
    ).toEqual({ kind: "unlocked", epoch: 3 });
  });

  it("adopts the descriptor epoch when the cache has none (pre-epoch cache / pre-seed)", () => {
    // pre-seed/이전 포맷 캐시 — verifier 일치가 곧 증명이므로 epoch 만 채택한다.
    expect(
      decideVaultAccess({
        descriptorEpoch: 1,
        descriptorVerifier: verifier,
        cachedDekVerifier: verifier,
        cachedEpoch: null,
      }),
    ).toEqual({ kind: "unlocked", epoch: 1 });
  });

  it("locks and implies cache drop when the verifier differs (reset + re-setup)", () => {
    expect(
      decideVaultAccess({
        descriptorEpoch: 5,
        descriptorVerifier: verifier,
        cachedDekVerifier: otherVerifier,
        cachedEpoch: 3,
      }),
    ).toEqual({ kind: "locked" });
  });

  it("ignores a descriptor older than the cached epoch (own re-setup in-flight race)", () => {
    // 자기 재설정 직후 도착한 낡은 응답 — verifier 가 달라도 epoch 이 낮으면 무시한다.
    expect(
      decideVaultAccess({
        descriptorEpoch: 3,
        descriptorVerifier: otherVerifier,
        cachedDekVerifier: verifier,
        cachedEpoch: 5,
      }),
    ).toEqual({ kind: "ignore-descriptor" });
  });

  it("ignores an older wrapper revision within the same DEK epoch", () => {
    expect(
      decideVaultAccess({
        descriptorEpoch: 3,
        descriptorVerifier: verifier,
        descriptorWrapRevision: 1,
        cachedDekVerifier: verifier,
        cachedEpoch: 3,
        cachedWrapRevision: 2,
      }),
    ).toEqual({ kind: "ignore-descriptor" });
  });

  it("accepts a newer wrapper revision within the same DEK epoch", () => {
    expect(
      decideVaultAccess({
        descriptorEpoch: 3,
        descriptorVerifier: verifier,
        descriptorWrapRevision: 2,
        cachedDekVerifier: verifier,
        cachedEpoch: 3,
        cachedWrapRevision: 1,
      }),
    ).toEqual({ kind: "unlocked", epoch: 3 });
  });

  it("treats a missing descriptor epoch as 0 (old server) and keeps trust without verifier", () => {
    expect(
      decideVaultAccess({
        descriptorEpoch: undefined,
        descriptorVerifier: undefined,
        cachedDekVerifier: verifier,
        cachedEpoch: null,
      }),
    ).toEqual({ kind: "unlocked-unverifiable", epoch: 0 });
  });

  it("still ignores a stale descriptor even when it lacks a verifier", () => {
    // epoch 규칙이 verifier 유무보다 먼저다 — 낡은 구서버 응답이 새 캐시를 못 건드린다.
    expect(
      decideVaultAccess({
        descriptorEpoch: undefined,
        descriptorVerifier: undefined,
        cachedDekVerifier: verifier,
        cachedEpoch: 2,
      }),
    ).toEqual({ kind: "ignore-descriptor" });
  });
});

describe("shared vault lifecycle scenarios", () => {
  it.each(vaultLifecycleScenarios.accessDecisions)(
    "$name",
    (scenario) => {
      const decision = decideVaultAccess({
        descriptorEpoch: scenario.descriptorEpoch,
        descriptorVerifier: scenario.descriptorVerifier,
        cachedDekVerifier: scenario.cachedDekVerifier,
        cachedEpoch: scenario.cachedEpoch,
      });
      expect(decision.kind).toBe(scenario.expectedKind);
      if ("expectedEpoch" in scenario) {
        expect("epoch" in decision ? decision.epoch : undefined).toBe(
          scenario.expectedEpoch,
        );
      }
    },
  );
});
