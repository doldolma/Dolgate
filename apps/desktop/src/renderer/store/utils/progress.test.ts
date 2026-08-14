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

    it("does NOT prompt credential retry when the handshake stalled", () => {
      // The server went silent waiting for a browser approval (Tailscale SSH check
      // mode sends the URL as a banner). Our error carries "ssh handshake failed"
      // as well, so without this guard a stall opens the password re-entry dialog —
      // which can never resolve it.
      for (const message of [
        "ssh handshake failed: ssh: handshake failed: read tcp 100.75.131.45:48501->100.113.87.118:22: i/o timeout",
        "ssh handshake failed: read tcp: i/o timeout — 인증 단계에서 서버 응답이 없습니다. 서버가 보낸 안내:\n# To authenticate, visit: https://login.tailscale.com/a/le7a9c3c3519ae",
        "ssh handshake failed: read tcp: i/o timeout — 키 교환 단계에서 서버 응답이 없습니다",
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

    it("does NOT prompt credential retry when the server only takes keyboard-interactive", () => {
      // PAM/2FA 서버는 keyboard-interactive 만 제시한다. 계정·비밀번호를 다시 받아도 그 방식은
      // 시도조차 되지 않으므로(x/crypto 는 서버가 제시한 방식만 쓴다) 이 창은 소용이 없다.
      const message =
        "ssh handshake failed: ssh: handshake failed: ssh: unable to authenticate," +
        " attempted methods [none keyboard-interactive], no supported methods remain";

      expect(
        resolveCredentialRetryKind(sshHost({ authType: "password" }), message),
      ).toBeNull();
      expect(
        resolveCredentialRetryKind(sshHost({ authType: "privateKey" }), message),
      ).toBeNull();
    });

    it("still prompts credential retry when password was actually attempted", () => {
      // 같은 문구 모양이지만 서버가 password 를 제시했고 그것이 틀린 경우다 — 다시 받는 것이 맞다.
      expect(
        resolveCredentialRetryKind(
          sshHost({ authType: "password" }),
          "ssh: unable to authenticate, attempted methods [none password], no supported methods remain",
        ),
      ).toBe("auth");
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
