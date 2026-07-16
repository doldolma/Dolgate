import { Buffer } from "buffer";
import { toByteArray } from "base64-js";
import {
  assertValidNewVaultPassphrase,
  decideVaultAccess,
  createVaultDek,
  createVaultKdfDescriptor,
  deriveVaultKek,
  resolveVaultDescriptorState,
  unwrapVaultDek,
  VAULT_DEK_BYTE_LENGTH,
  VAULT_KDF_DEFAULT_COST,
  VAULT_KDF_SALT_BYTE_LENGTH,
  wrapVaultDek,
  wrapVaultDekWithIv,
  validateNewVaultPassphrase,
} from "@dolssh/shared-core";
import vaultLifecycleScenarios from "@dolssh/shared-core/src/vault-lifecycle-scenarios.json";
import vaultTestVectors from "@dolssh/shared-core/src/vault-test-vectors.json";

// E2EE 볼트 암호학(shared-core/vault.ts) 검증. wrap 벡터는 Go crypto(cipher.NewGCM)로
// 생성됐다 — 여기서 통과하면 noble 구현이 표준 AES-256-GCM 과 일치한다는 뜻이다.
// KDF(argon2id) 벡터는 네이티브 구현이 붙는 Rust(uniffi)·데스크톱 테스트에서 검증한다.
describe("vault crypto", () => {
  it("matches the shared AES-256-GCM wrap test vectors", () => {
    for (const vector of vaultTestVectors.wrap) {
      const kek = toByteArray(vector.kekBase64);
      const dek = toByteArray(vector.dekBase64);
      const iv = toByteArray(vector.ivBase64);

      expect(wrapVaultDekWithIv(dek, kek, iv)).toBe(vector.wrappedBase64);
      expect(unwrapVaultDek(vector.wrappedBase64, kek)).toEqual(dek);
    }
  });

  it("round-trips a random DEK and rejects a wrong passphrase KEK", () => {
    const dek = createVaultDek();
    expect(dek).toHaveLength(VAULT_DEK_BYTE_LENGTH);

    const kek = toByteArray(vaultTestVectors.wrap[0].kekBase64);
    const wrapped = wrapVaultDek(dek, kek);
    expect(unwrapVaultDek(wrapped, kek)).toEqual(dek);

    // 잘못된 동기화 암호 = 잘못된 KEK → GCM 인증 실패로 던져져야 한다.
    const wrongKek = new Uint8Array(kek);
    wrongKek[0] ^= 0xff;
    expect(() => unwrapVaultDek(wrapped, wrongKek)).toThrow();
  });

  it("normalizes passphrases to NFC before deriving the KEK", async () => {
    const observedPassphrases: string[] = [];
    const observedParams: Array<Record<string, number>> = [];
    const fakeArgon2id = jest.fn(
      async (
        passphrase: Uint8Array,
        _salt: Uint8Array,
        params: {
          memoryKib: number;
          timeCost: number;
          parallelism: number;
          outputLength: number;
        },
      ) => {
        observedPassphrases.push(Buffer.from(passphrase).toString("utf8"));
        observedParams.push(params);
        return new Uint8Array(32);
      },
    );

    const kdf = createVaultKdfDescriptor();
    expect(toByteArray(kdf.saltBase64)).toHaveLength(
      VAULT_KDF_SALT_BYTE_LENGTH,
    );
    expect(kdf.memoryKib).toBe(VAULT_KDF_DEFAULT_COST.memoryKib);

    // "한글" — NFC(완성형)와 NFD(자모 분해)는 바이트열이 다르지만 같은 KEK 가 나와야 한다.
    const composed = "\ud55c\uae00";
    const decomposed = "\u1112\u1161\u11ab\u1100\u1173\u11af";
    expect(composed).not.toBe(decomposed);
    await deriveVaultKek(fakeArgon2id, composed, kdf);
    await deriveVaultKek(fakeArgon2id, decomposed, kdf);

    expect(observedPassphrases[0]).toBe(observedPassphrases[1]);
    expect(fakeArgon2id).toHaveBeenCalledTimes(2);
    expect(observedParams[0]).toMatchObject({
      memoryKib: kdf.memoryKib,
      timeCost: kdf.timeCost,
      parallelism: kdf.parallelism,
      outputLength: 32,
    });
  });

  it("requires four characters only when creating a new passphrase", () => {
    expect(validateNewVaultPassphrase("abc")).toBe(
      "동기화 암호는 4자 이상이어야 합니다.",
    );
    expect(validateNewVaultPassphrase("abcd")).toBeNull();
    expect(validateNewVaultPassphrase("가나다라")).toBeNull();
    expect(() => assertValidNewVaultPassphrase("   ")).toThrow(
      "동기화 암호에 문자를 입력해 주세요.",
    );
  });

  it("rejects KDF descriptors with an unsupported algorithm", async () => {
    const kdf = { ...createVaultKdfDescriptor(), algorithm: "pbkdf2" };
    await expect(
      deriveVaultKek(async () => new Uint8Array(32), "passphrase", kdf),
    ).rejects.toThrow("지원하지 않는 KDF 알고리즘");
  });

  it("resolves vault bootstrap descriptors across server versions", () => {
    // v2 도입 이전 서버: version 필드 없음 → keyBase64 유무로 v1 판별.
    expect(
      resolveVaultDescriptorState({ keyBase64: "legacy-key" }),
    ).toEqual({ kind: "legacy", keyBase64: "legacy-key" });

    expect(
      resolveVaultDescriptorState({ version: 1, keyBase64: "legacy-key" }),
    ).toEqual({ kind: "legacy", keyBase64: "legacy-key" });

    expect(
      resolveVaultDescriptorState({
        version: 1,
        keyBase64: "legacy-key",
        epoch: 3,
        e2eeRequired: true,
      }),
    ).toEqual({
      kind: "legacy",
      keyBase64: "legacy-key",
      epoch: 3,
      e2eeRequired: true,
    });

    expect(resolveVaultDescriptorState({ version: 0 })).toEqual({
      kind: "setup-required",
    });

    const kdf = createVaultKdfDescriptor();
    expect(
      resolveVaultDescriptorState({
        version: 2,
        wrappedDekBase64: "wrapped",
        kdf,
      }),
    ).toEqual({ kind: "e2ee", wrappedDekBase64: "wrapped", kdf });

    expect(() => resolveVaultDescriptorState({ version: 1 })).toThrow();
    expect(() => resolveVaultDescriptorState({ version: 2 })).toThrow();
    expect(() => resolveVaultDescriptorState({ version: 9 })).toThrow(
      "앱을 업데이트",
    );
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
