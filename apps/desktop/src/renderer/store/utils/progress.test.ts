import { describe, expect, it } from "vitest";
import type { HostRecord } from "@shared";
import {
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
    expect(resolveCredentialRetryProgress(sshHost(), "password")).toMatchObject({
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
});
