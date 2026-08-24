import { describe, expect, it } from "vitest";
import type { TerminalTab } from "@shared";
import { t } from "../../i18n";
import { resolveConnectionFailurePresentation } from "../../store/utils";
import {
  resolveAwsFailureNotice,
  resolveConnectionOverlayMessage,
  resolveConnectionOverlayTitle,
  resolveTailnetFailureGuidance,
  resolveTailnetLoginRejectedGuidance,
  resolveTailnetPhaseMessage,
  shouldShowSessionOverlay,
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

describe("shouldShowSessionOverlay", () => {
  it("folds the overlay once the server banner is on the terminal", () => {
    // 배너가 찍힌 시점엔 이 오버레이가 추적하는 것이 모두 끝나 있다(tailnet·TCP·키 교환·호스트 키).
    // 남은 것은 서버가 사람을 기다리는 일뿐인데, 카드가 덮으면 정작 그 안내를 가린다.
    const tab = createErrorTab({
      status: "connecting",
      errorMessage: undefined,
      serverBannerShown: true,
    });

    expect(shouldShowSessionOverlay(tab, null)).toBe(false);
  });

  it("still shows the overlay when the attempt failed after the banner", () => {
    const tab = createErrorTab({ serverBannerShown: true });

    expect(shouldShowSessionOverlay(tab, null)).toBe(true);
  });

  it("shows the overlay while connecting without a banner", () => {
    const tab = createErrorTab({ status: "connecting", errorMessage: undefined });

    expect(shouldShowSessionOverlay(tab, null)).toBe(true);
  });
});

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

  // 브라우저 대기 문구가 실패 화면에 남으면, "로그인을 마쳐 주세요" 라고 하면서 실패로 앉아 있는
  // 화면이 된다 — 실패 이유가 그 문구에 덮여서 무엇이 잘못됐는지 알 수 없다.
  it("실패하면 브라우저 대기 문구 대신 실패 이유를 보여준다", () => {
    const tab = createErrorTab({
    errorMessage: "tailnet: could not reach the host through the tailnet",
    connectionProgress: {
      stage: "tailnet-connecting",
      message: "basket 브라우저에서 로그인을 마쳐 주세요.",
      blockingKind: "browser",
      retryable: true,
    },
  });

  expect(resolveConnectionOverlayMessage(tab)).not.toBe(
    "basket 브라우저에서 로그인을 마쳐 주세요.",
  );
  expect(resolveConnectionOverlayMessage(tab)).toBe(
    resolveConnectionFailurePresentation(tab.errorMessage as string).message,
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

// 만료는 Tailscale 계층이 판정해 알려 준 것만 온다. 여기서 정하는 것은 "무엇이 일어났고 무엇이
// 필요한가" 뿐이다 — 복구 동작은 코어가 하므로 화면이 대신 결정하지 않는다.
describe("resolveTailnetFailureGuidance", () => {
  it("브라우저 로그인 tailnet 은 인증부터 다시 진행한다고 말한다", () => {
    const guidance = resolveTailnetFailureGuidance(false);

    expect(guidance.message).toContain(t("connectFailure.tailnetExpired"));
    expect(guidance.message).toContain(t("connectFailure.tailnetReauthHint"));
  });

  // auth key 는 다시 할 로그인이 없다. 눌러도 같은 키로 같은 결과이므로, 무엇을 확인해야
  // 하는지를 말해야 한다.
  it("auth key tailnet 에는 키를 확인하라고 말한다", () => {
    const guidance = resolveTailnetFailureGuidance(true);

    expect(guidance.message).toContain(t("connectFailure.tailnetAuthKeyHint"));
    expect(guidance.message).not.toContain(t("connectFailure.tailnetReauthHint"));
  });

  // 설정을 아직 못 읽었으면 브라우저 경로로 떨어진다 — 그쪽이 기본이다.
  it("인증 방식을 모르면 브라우저 경로로 떨어진다", () => {
    expect(resolveTailnetFailureGuidance(null).message).toContain(
      t("connectFailure.tailnetReauthHint"),
    );
  });
});

// 거부는 만료와 다른 사건이다 — 유효했던 등록이 수명을 다한 것이 아니라 애초에 받아들여지지
// 않은 것이다(없는 auth key). 만료라고 말하면 사용자는 멀쩡한 키를 의심하러 간다.
describe("resolveTailnetLoginRejectedGuidance", () => {
  it("만료가 아니라 거부됐다고 말한다", () => {
    const guidance = resolveTailnetLoginRejectedGuidance(true);

    expect(guidance.message).toContain(t("connectFailure.tailnetLoginRejected"));
    expect(guidance.message).not.toContain(t("connectFailure.tailnetExpired"));
  });

  // 뒤에 붙는 안내는 만료와 같다 — 어느 쪽이든 auth key 경로에는 다시 할 로그인이 없다.
  it("auth key tailnet 에는 새 키가 필요하다고 말한다", () => {
    expect(resolveTailnetLoginRejectedGuidance(true).message).toContain(
      t("connectFailure.tailnetAuthKeyHint"),
    );
    expect(resolveTailnetLoginRejectedGuidance(false).message).toContain(
      t("connectFailure.tailnetReauthHint"),
    );
  });
});

// 진행 문구를 시도를 시작한 세션에만 흘리면, 나머지 화면은 "연결하는 중" 만 보다가 갑자기
// 브라우저가 뜬다. 공유 상태에서 직접 만들어야 누가 시작했는지와 무관하게 같은 말을 한다.
describe("resolveTailnetPhaseMessage", () => {
  it("무엇을 기다리는지 단계별로 말한다", () => {
    expect(resolveTailnetPhaseMessage("회사망", { state: "starting" })).toBe(
      t("connectProgress.tailnetConnecting", { label: "회사망" }),
    );
    expect(
      resolveTailnetPhaseMessage("회사망", {
        state: "needsAuth",
        authUrl: "https://login.example",
      }),
    ).toBe(t("connectProgress.tailnetNeedsAuth", { label: "회사망" }));
    expect(resolveTailnetPhaseMessage("회사망", { state: "needsApproval" })).toBe(
      t("connectProgress.tailnetNeedsApproval", { label: "회사망" }),
    );
  });

  // 링크가 오기까지 몇 초 걸린다. 그동안 "로그인하세요" 라고 하면 누를 것을 찾다가 없다는 것만
  // 확인하게 된다.
  it("링크가 아직 없으면 링크를 받는 중이라고 한다", () => {
    expect(resolveTailnetPhaseMessage("회사망", { state: "needsAuth" })).toBe(
      t("connectProgress.tailnetPreparingAuth", { label: "회사망" }),
    );
  });

  // 붙어 있으면 tailnet 이 할 말이 없다. 여기서 문구를 내면 세션 자신의 진행을 덮어버린다.
  it("붙어 있거나 상태를 모르면 아무 말도 하지 않는다", () => {
    expect(resolveTailnetPhaseMessage("회사망", { state: "running" })).toBeNull();
    expect(resolveTailnetPhaseMessage("회사망", { state: "stopped" })).toBeNull();
    expect(resolveTailnetPhaseMessage("회사망", undefined)).toBeNull();
  });
});

describe("resolveAwsFailureNotice", () => {
  it("판정된 실패가 없으면 아무것도 얹지 않는다", () => {
    expect(
      resolveAwsFailureNotice({ reasonCode: null, errorMessage: "boom" }),
    ).toBeNull();
    expect(
      resolveAwsFailureNotice({
        reasonCode: "not-managed-instance",
        errorMessage: "",
      }),
    ).toBeNull();
  });

  // 문구가 "무엇을 하라" 를 말하지 않던 실패다 — 조치 줄이 새로 붙는다.
  it("조치가 없던 실패에는 할 일을 붙인다", () => {
    const notice = resolveAwsFailureNotice({
      reasonCode: "not-managed-instance",
      errorMessage: "[SSM 상태 확인] 인스턴스가 SSM 관리 대상으로 확인되지 않습니다.",
    });
    expect(notice?.title).toBe(t("awsDiagnostic.title.notManagedInstance"));
    expect(notice?.action).toBe(t("awsDiagnostic.action.notManagedInstance"));
  });

  // 권한 거부는 실패 문구가 이미 액션 이름까지 말한다 — 같은 말을 두 번 하면 둘 다 안 읽힌다.
  it("실패 문구가 이미 같은 액션을 말했으면 조치 줄을 접는다", () => {
    const notice = resolveAwsFailureNotice({
      reasonCode: "ssm-access-denied",
      errorMessage:
        "[SSM 터널 열기] User: arn:aws:sts::123456789012:assumed-role/DevRole/dolma is not authorized to perform: ssm:StartSession on resource: arn:aws:ec2:ap-northeast-2:123456789012:instance/i-0abc",
    });
    expect(notice?.title).toBe(t("awsDiagnostic.title.ssmAccessDenied"));
    expect(notice?.action).toBeNull();
  });

  // 같은 코드라도 문구가 액션 이름을 말하지 않았으면(단계로 판정된 경우) 조치 줄이 그것을 말한다.
  it("문구가 액션을 말하지 않았으면 조치 줄로 알려 준다", () => {
    const notice = resolveAwsFailureNotice({
      reasonCode: "ssm-access-denied",
      errorMessage: "[SSM 터널 열기] AccessDeniedException",
    });
    expect(notice?.action).toContain("ssm:StartSession");
  });
});
