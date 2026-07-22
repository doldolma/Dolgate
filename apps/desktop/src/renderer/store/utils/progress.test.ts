import { describe, expect, it } from "vitest";
import type { HostRecord } from "@shared";
import {
  resolveCredentialRetryKind,
  resolveCredentialRetryProgress,
  resolveErrorProgress,
  resolveHostKeyCheckProgress,
} from "./progress";

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
    groupName: null,
    tags: [],
    terminalThemeId: null,
    ...overrides,
  }) as Extract<HostRecord, { kind: "ssh" }>;

describe("progress utils", () => {
  it("maps host-key progress with the host label", () => {
    expect(resolveHostKeyCheckProgress(sshHost())).toMatchObject({
      stage: "host-key-check",
      message: "Alpha 호스트 키를 확인하는 중입니다.",
    });
  });

  it("marks credential retry prompts as retryable dialogs", () => {
    expect(resolveCredentialRetryProgress(sshHost())).toMatchObject({
      stage: "awaiting-credentials",
      blockingKind: "dialog",
      retryable: true,
    });
    expect(resolveErrorProgress("boom")).toMatchObject({
      stage: "connecting",
      retryable: true,
      message: "boom",
    });
  });

  describe("resolveCredentialRetryKind", () => {
    it("does NOT prompt credential retry for host-key problems", () => {
      // A host key mismatch is a trust issue, not a credential issue. The Go error
      // carries "ssh handshake failed" too, which must not trigger the password
      // re-entry dialog (it can never fix a key mismatch).
      for (const message of [
        "ssh handshake failed: ssh: handshake failed: host key mismatch",
        "host key is not trusted yet",
        "trusted host key is required",
        "ssh: no common host key type",
      ]) {
        expect(
          resolveCredentialRetryKind(sshHost({ authType: "password" }), message),
          message,
        ).toBeNull();
        expect(
          resolveCredentialRetryKind(sshHost({ authType: "privateKey" }), message),
          message,
        ).toBeNull();
      }
    });

    it("still prompts credential retry for genuine auth failures", () => {
      expect(
        resolveCredentialRetryKind(
          sshHost({ authType: "password" }),
          "ssh: handshake failed: permission denied (password)",
        ),
      ).toBe("auth");
      expect(
        resolveCredentialRetryKind(
          sshHost({ authType: "password" }),
          "unable to authenticate",
        ),
      ).toBe("auth");
    });
  });
});
