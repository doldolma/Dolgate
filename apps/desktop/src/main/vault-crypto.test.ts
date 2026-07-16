import { describe, expect, it } from "vitest";
import { unwrapVaultDek } from "@dolssh/shared-core";
import vaultTestVectors from "@dolssh/shared-core/src/vault-test-vectors.json";
import { desktopArgon2idDerive } from "./vault-crypto";

// 데스크톱 Argon2id(@noble/hashes)가 공유 벡터와 일치하는지 검증한다.
// 같은 벡터를 모바일 Rust(uniffi) 테스트도 사용하므로, 이 테스트가 통과하면
// 세 구현(Go 생성기·Rust·noble)이 상호 교환 가능하다는 뜻이다.
describe("desktop argon2id derive", () => {
  it("matches the shared KDF test vectors", async () => {
    for (const vector of vaultTestVectors.kdf) {
      // 공유 벡터는 primitive 상호운용성 검사용 저비용 프로필이다. 제품 descriptor
      // allowlist를 거치는 deriveVaultKek 대신 플랫폼 primitive를 직접 검증한다.
      const kek = await desktopArgon2idDerive(
        new TextEncoder().encode(vector.passphrase.normalize("NFC")),
        new Uint8Array(Buffer.from(vector.saltBase64, "base64")),
        {
          memoryKib: vector.memoryKib,
          timeCost: vector.timeCost,
          parallelism: vector.parallelism,
          outputLength: 32,
        },
      );
      expect(Buffer.from(kek).toString("base64")).toBe(vector.kekBase64);
    }
  });

  it("round-trips the shared wrap vectors with derived keys", () => {
    for (const vector of vaultTestVectors.wrap) {
      const kek = new Uint8Array(Buffer.from(vector.kekBase64, "base64"));
      const dek = unwrapVaultDek(vector.wrappedBase64, kek);
      expect(Buffer.from(dek).toString("base64")).toBe(vector.dekBase64);
    }
  });
});
