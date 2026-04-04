import { describe, expect, it } from "vitest";
import type { HostRecord, KeyboardInteractiveChallenge } from "@shared";
import {
  parseWarpgateApprovalUrl,
  parseWarpgateAuthCode,
  resolveInteractiveAuthUiState,
} from "./interactive-auth";

const warpgateHost = (
  overrides: Partial<Extract<HostRecord, { kind: "warpgate-ssh" }>> = {},
) =>
  ({
    kind: "warpgate-ssh",
    id: "host-warpgate",
    label: "Warpgate",
    groupName: null,
    tags: [],
    terminalThemeId: null,
    warpgateBaseUrl: "https://gateway.example.com",
    warpgateSshHost: "gateway.example.com",
    warpgateSshPort: 2222,
    warpgateTargetId: "target-1",
    warpgateTargetName: "Target",
    warpgateUsername: "ubuntu",
    ...overrides,
  }) as Extract<HostRecord, { kind: "warpgate-ssh" }>;

describe("interactive-auth utils", () => {
  it("extracts Warpgate approval URL and auth code from prompt text", () => {
    expect(
      parseWarpgateApprovalUrl(
        "Open https://gateway.example.com/device to continue",
      ),
    ).toBe("https://gateway.example.com/device");
    expect(
      parseWarpgateAuthCode("Device code: ABCD-1234"),
    ).toBe("ABCD-1234");
  });

  it("builds auto-submittable Warpgate UI state", () => {
    const challenge: KeyboardInteractiveChallenge = {
      endpointId: "endpoint-1",
      challengeId: "challenge-1",
      attempt: 1,
      name: "Warpgate Device Authorization",
      instruction:
        "Open https://gateway.example.com/device and enter device code ABCD-1234",
      prompts: [
        { label: "Verification code", echo: true },
        { label: "Press Enter when done", echo: true },
      ],
    };

    expect(resolveInteractiveAuthUiState(warpgateHost(), challenge)).toMatchObject({
      provider: "warpgate",
      approvalUrl: "https://gateway.example.com/device",
      authCode: "ABCD-1234",
      autoResponses: ["ABCD-1234", ""],
      autoSubmitted: true,
    });
  });
});
