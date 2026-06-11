import { describe, expect, it } from "vitest";
import type { TerminalTab } from "@shared";
import {
  resolveConnectionOverlayMessage,
  resolveConnectionOverlayTitle,
} from "./terminalSessionHelpers";

function createErrorTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    sessionId: "session-1",
    title: "nas",
    source: "host",
    status: "error",
    hostId: "host-1",
    shellKind: "ssh",
    errorMessage:
      "Error invoking remote method 'known-hosts:probe-host': Error: dial failed: dial tcp 192.168.1.201:22: connect: network is unreachable",
    connectionProgress: {
      stage: "connecting",
      message:
        "dial failed: dial tcp 192.168.1.201:22: connect: network is unreachable",
      blockingKind: "none",
      retryable: true,
    },
    hasReceivedOutput: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastEventAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as TerminalTab;
}

describe("terminalSessionHelpers connection error presentation", () => {
  it("uses friendly connection failure copy for terminal error overlays", () => {
    const tab = createErrorTab();

    expect(resolveConnectionOverlayTitle(tab)).toBe("Connection Failed");
    expect(resolveConnectionOverlayMessage(tab)).toBe(
      "192.168.1.201:22에 연결할 수 없습니다. 현재 네트워크에서 해당 호스트로 가는 경로가 없습니다.",
    );
  });

  it("uses friendly AWS SSM exit copy for terminal error overlays", () => {
    const tab = createErrorTab({
      errorMessage: "AWS SSM session exited with code 254",
      connectionProgress: {
        stage: "connecting",
        message: "AWS SSM session exited with code 254",
        blockingKind: "none",
        retryable: true,
      },
    });

    expect(resolveConnectionOverlayMessage(tab)).toBe(
      "AWS SSM 세션이 종료되었습니다. (code 254)",
    );
  });

  it("keeps blocking progress messages for credential retry prompts", () => {
    const tab = createErrorTab({
      errorMessage: "permission denied",
      connectionProgress: {
        stage: "awaiting-credentials",
        message: "nas 인증 정보를 다시 확인해 주세요.",
        blockingKind: "dialog",
        retryable: true,
      },
    });

    expect(resolveConnectionOverlayMessage(tab)).toBe(
      "nas 인증 정보를 다시 확인해 주세요.",
    );
  });
});
