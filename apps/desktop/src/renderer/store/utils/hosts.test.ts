import { describe, expect, it } from "vitest";
import type { HostRecord } from "@shared";
import {
  buildDuplicateHostLabel,
  matchesSelectedTags,
  normalizeTagValue,
} from "./hosts";

const sshHost = (overrides: Partial<Extract<HostRecord, { kind: "ssh" }>> = {}) =>
  ({
    kind: "ssh",
    id: "host-1",
    label: "Alpha",
    hostname: "alpha.example.com",
    port: 22,
    username: "ubuntu",
    authType: "password",
    privateKeyPath: null,
    secretRef: null,
    groupName: "team/a",
    tags: ["Prod", "Blue"],
    terminalThemeId: null,
    ...overrides,
  }) as Extract<HostRecord, { kind: "ssh" }>;

describe("hosts utils", () => {
  it("builds the next duplicate label within the same group path", () => {
    const original = sshHost({ label: "Alpha" });
    const existing: HostRecord[] = [
      original,
      sshHost({ id: "host-2", label: "Alpha Copy" }),
      sshHost({ id: "host-3", label: "Alpha Copy 2" }),
      sshHost({ id: "host-4", label: "Alpha Copy", groupName: "team/b" }),
    ];

    expect(buildDuplicateHostLabel(original, existing)).toBe("Alpha Copy 3");
  });

  it("matches selected tags case-insensitively", () => {
    const host = sshHost();

    expect(normalizeTagValue("  Prod ")).toBe("prod");
    expect(matchesSelectedTags(host, ["prod"])).toBe(true);
    expect(matchesSelectedTags(host, ["green"])).toBe(false);
  });
});
