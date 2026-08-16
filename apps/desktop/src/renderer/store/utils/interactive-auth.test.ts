import { describe, expect, it } from "vitest";
import type { HostRecord, KeyboardInteractiveChallenge } from "@shared";
import {
  clearEndpointPendingInteractiveAuth,
  clearSessionPendingInteractiveAuth,
  findEndpointPendingInteractiveAuth,
  findPendingInteractiveAuthByChallengeId,
  findSessionPendingInteractiveAuth,
  formatInteractiveHop,
  parseWarpgateApprovalUrl,
  parseWarpgateAuthCode,
  resolveInteractiveAuthUiState,
  toKeyboardInteractiveHop,
  upsertPendingInteractiveAuth,
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

  it("labels the hop that asked so a jump chain is unambiguous", () => {
    const hop = toKeyboardInteractiveHop({
      username: "ubuntu",
      host: "192.168.200.37",
      port: 22,
    });
    expect(hop).toEqual({
      username: "ubuntu",
      host: "192.168.200.37",
      port: 22,
    });
    expect(formatInteractiveHop(hop)).toBe("ubuntu@192.168.200.37:22");
  });

  // 사용자는 주소가 아니라 자기가 붙인 이름을 기억한다. 점프 체인에서 어느 쪽 코드를 넣어야
  // 하는지 판단하려면 그 이름이 먼저 보여야 한다.
  it("등록된 호스트면 이름을 앞에 붙인다", () => {
    const hosts = [
      { id: "h1", kind: "ssh", label: "Lime-GW", hostname: "192.168.200.37", port: 22 },
    ] as never;
    const hop = toKeyboardInteractiveHop({
      username: "ubuntu",
      host: "192.168.200.37",
      port: 22,
    });

    expect(formatInteractiveHop(hop, hosts)).toBe(
      "Lime-GW (ubuntu@192.168.200.37:22)",
    );
  });

  // 포트가 다르게 등록돼 있어도 같은 기기다 — 이름은 맞다.
  it("포트가 안 맞으면 주소만으로 찾는다", () => {
    const hosts = [
      { id: "h1", kind: "ssh", label: "Lime-GW", hostname: "192.168.200.37", port: 2222 },
    ] as never;
    const hop = toKeyboardInteractiveHop({
      username: "ubuntu",
      host: "192.168.200.37",
      port: 22,
    });

    expect(formatInteractiveHop(hop, hosts)).toBe(
      "Lime-GW (ubuntu@192.168.200.37:22)",
    );
  });

  // 등록하지 않은 경유지는 예전처럼 주소만 나온다 — 없는 이름을 지어내지 않는다.
  it("목록에 없는 주소면 주소만 보여준다", () => {
    const hop = toKeyboardInteractiveHop({
      username: "ubuntu",
      host: "10.9.9.9",
      port: 22,
    });

    expect(formatInteractiveHop(hop, [] as never)).toBe("ubuntu@10.9.9.9:22");
  });

  it("drops a hop with no host instead of showing an empty name", () => {
    expect(toKeyboardInteractiveHop({ username: "ubuntu", port: 22 })).toBeNull();
    expect(toKeyboardInteractiveHop(undefined)).toBeNull();
    expect(formatInteractiveHop(null)).toBe("");
  });

  it("omits the parts the core did not send", () => {
    expect(formatInteractiveHop(toKeyboardInteractiveHop({ host: "bastion" }))).toBe(
      "bastion",
    );
    expect(
      formatInteractiveHop(
        toKeyboardInteractiveHop({ host: "bastion", port: 0, username: "  " }),
      ),
    ).toBe("bastion");
  });
});

// 실기기 증상: 터미널이 "추가 인증 응답이 필요합니다" 만 띄운 채 멈췄다. 슬롯이 앱 전체에 하나여서
// 다른 대상(실패한 프로브)의 챌린지가 먼저 뜬 카드를 밀어냈고, 그 연결은 아무 표시 없이 기다렸다.
describe("여러 대상이 동시에 인증을 기다릴 때", () => {
  const sessionAuth = {
    source: "ssh" as const,
    sessionId: "session-1",
    challengeId: "session-1-1",
    name: null,
    instruction: "",
    prompts: [],
    provider: "generic" as const,
    autoSubmitted: false,
  };
  const sftpAuth = {
    source: "sftp" as const,
    paneId: "left" as const,
    endpointId: "endpoint-1",
    hostId: "host-1",
    challengeId: "endpoint-1-1",
    name: null,
    instruction: "",
    prompts: [],
    provider: "generic" as const,
    autoSubmitted: false,
  };

  it("서로를 밀어내지 않는다", () => {
    const auths = upsertPendingInteractiveAuth(
      upsertPendingInteractiveAuth([], sessionAuth),
      sftpAuth,
    );

    expect(auths).toHaveLength(2);
    expect(findSessionPendingInteractiveAuth(auths, "session-1")?.challengeId).toBe(
      "session-1-1",
    );
    expect(findEndpointPendingInteractiveAuth(auths, "endpoint-1")?.challengeId).toBe(
      "endpoint-1-1",
    );
  });

  it("같은 대상의 새 요청은 앞의 것을 갈아 끼운다", () => {
    const auths = upsertPendingInteractiveAuth(
      upsertPendingInteractiveAuth([], sessionAuth),
      { ...sessionAuth, challengeId: "session-1-2" },
    );

    expect(auths).toHaveLength(1);
    expect(auths[0]?.challengeId).toBe("session-1-2");
  });

  it("한 대상을 내려도 다른 대상은 남는다", () => {
    const auths = upsertPendingInteractiveAuth(
      upsertPendingInteractiveAuth([], sessionAuth),
      sftpAuth,
    );

    const afterSession = clearSessionPendingInteractiveAuth(auths, "session-1");
    expect(afterSession).toHaveLength(1);
    expect(afterSession[0]?.challengeId).toBe("endpoint-1-1");

    const afterEndpoint = clearEndpointPendingInteractiveAuth(auths, "endpoint-1");
    expect(afterEndpoint).toHaveLength(1);
    expect(afterEndpoint[0]?.challengeId).toBe("session-1-1");
  });

  it("답을 보낼 때 챌린지 ID 로 그 요청을 찾는다", () => {
    const auths = upsertPendingInteractiveAuth(
      upsertPendingInteractiveAuth([], sessionAuth),
      sftpAuth,
    );

    expect(
      findPendingInteractiveAuthByChallengeId(auths, "endpoint-1-1")?.source,
    ).toBe("sftp");
    expect(findPendingInteractiveAuthByChallengeId(auths, "nobody")).toBeNull();
  });
});
