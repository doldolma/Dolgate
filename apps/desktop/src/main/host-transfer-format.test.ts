import { describe, expect, it } from "vitest";
import type { DolgateHostBundleV1 } from "./host-transfer-format";
import {
  decryptDolgateHostBundle,
  encryptDolgateHostBundle,
} from "./host-transfer-format";

describe("Dolgate host transfer format", () => {
  it(
    "encrypts and decrypts a portable host bundle",
    async () => {
      const bundle: DolgateHostBundleV1 = {
        schemaVersion: 1,
        scope: "hosts",
        exportedAt: "2026-07-22T00:00:00.000Z",
        rootHostIds: [],
        groups: [],
        hosts: [],
        secrets: [],
        knownHosts: [],
        portForwards: [],
        dnsOverrides: [],
        awsProfiles: [],
        snippets: [],
      };

      const encrypted = await encryptDolgateHostBundle(bundle, "테스트 암호", "1.8.1");

      expect(encrypted.subarray(0, 8).toString("ascii")).toBe("DOLGATE\0");
      await expect(decryptDolgateHostBundle(encrypted, "테스트 암호")).resolves.toEqual(bundle);
      expect(encrypted.toString("utf8")).not.toContain("rootHostIds");
    },
    30_000,
  );
});
