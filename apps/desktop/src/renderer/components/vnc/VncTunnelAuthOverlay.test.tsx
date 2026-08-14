import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const respondInteractiveAuth = vi.fn();
const reopenInteractiveAuthUrl = vi.fn();
const clearPendingInteractiveAuth = vi.fn();
const disconnectTab = vi.fn();

// 스토어를 선택자 그대로 흉내낸다. 이 오버레이가 읽는 것은 인증 목록과 네 액션뿐이다.
const state: {
  pendingInteractiveAuths: Record<string, unknown>[];
  respondInteractiveAuth: typeof respondInteractiveAuth;
  reopenInteractiveAuthUrl: typeof reopenInteractiveAuthUrl;
  clearPendingInteractiveAuth: typeof clearPendingInteractiveAuth;
  disconnectTab: typeof disconnectTab;
} = {
  pendingInteractiveAuths: [],
  respondInteractiveAuth,
  reopenInteractiveAuthUrl,
  clearPendingInteractiveAuth,
  disconnectTab,
};

vi.mock("../../store/appStore", () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state),
}));

const { VncTunnelAuthOverlay } = await import("./VncTunnelAuthOverlay");

const tunnelAuth = {
  source: "vncTunnel",
  sessionId: "vnc-1",
  endpointId: "vnc:vnc-1",
  hostId: "gate",
  challengeId: "vnc:vnc-1-1",
  instruction: "",
  prompts: [{ label: "Verification code:", echo: false }],
  provider: "generic",
  autoSubmitted: false,
  hop: { host: "gate.example.com", username: "ops", port: 22 },
};

describe("VncTunnelAuthOverlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.pendingInteractiveAuths = [tunnelAuth];
  });

  it("경유 터널이 물으면 이 판 위에 입력창을 띄우고 답을 보낸다", () => {
    render(<VncTunnelAuthOverlay sessionId="vnc-1" />);

    // 누구의 코드인지 카드가 말해야 한다 — 점프 체인에서는 이 한 줄이 유일한 단서다.
    expect(screen.getByText("ops@gate.example.com:22")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Verification code:"), {
      target: { value: "424242" },
    });
    fireEvent.click(screen.getByRole("button", { name: "응답 보내기" }));

    expect(respondInteractiveAuth).toHaveBeenCalledWith("vnc:vnc-1-1", [
      "424242",
    ]);
  });

  it("닫기는 이 연결을 그만둔다", () => {
    render(<VncTunnelAuthOverlay sessionId="vnc-1" />);

    fireEvent.click(screen.getByRole("button", { name: "닫기" }));

    // 카드만 감추면 코어는 계속 답을 기다리고 화면은 "연결 중" 에 앉아 있다.
    expect(disconnectTab).toHaveBeenCalledWith("vnc-1");
    expect(clearPendingInteractiveAuth).toHaveBeenCalledWith("vnc:vnc-1-1");
  });

  it("다른 세션의 질문은 이 판에 그리지 않는다", () => {
    render(<VncTunnelAuthOverlay sessionId="vnc-2" />);

    expect(screen.queryByLabelText("Verification code:")).toBeNull();
  });

  it("터미널 세션의 인증 카드를 가져오지 않는다", () => {
    // 같은 세션 ID 라도 종류가 다르면 이 판의 것이 아니다. 터미널 판이 이미 그리므로 여기서 또
    // 그리면 같은 카드가 두 번 뜬다.
    state.pendingInteractiveAuths = [
      { ...tunnelAuth, source: "ssh", endpointId: undefined },
    ];

    render(<VncTunnelAuthOverlay sessionId="vnc-1" />);

    expect(screen.queryByLabelText("Verification code:")).toBeNull();
  });
});
