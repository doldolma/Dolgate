import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const retryVncConnection = vi.fn();
const disconnectTab = vi.fn();

// 스토어를 선택자 그대로 흉내낸다. 오버레이가 읽는 것은 탭·호스트·tailnet 상태·액션뿐이다.
const openExternalUrl = vi.fn();

const state: {
  tabs: Record<string, unknown>[];
  hosts: Record<string, unknown>[];
  tailnetStatuses: Record<string, unknown>;
  retryVncConnection: typeof retryVncConnection;
  disconnectTab: typeof disconnectTab;
  openExternalUrl: typeof openExternalUrl;
} = {
  tabs: [],
  hosts: [],
  tailnetStatuses: {},
  retryVncConnection,
  disconnectTab,
  openExternalUrl,
};

function seed(
  tab: Record<string, unknown>,
  host: Record<string, unknown>,
  extraHosts: Record<string, unknown>[] = [],
) {
  state.tabs = [
    { sessionId: "vnc-1", hostId: "h1", paneKind: "vnc", connectionProgress: null, ...tab },
  ];
  state.hosts = [
    { id: "h1", kind: "vnc", label: "Lab", hostname: "10.0.0.6", port: 5900, ...host },
    ...extraHosts,
  ];
}

/** 경유용 SSH 호스트. tailnet 을 붙이면 그 노드가 이 연결의 관문이 된다. */
function gateHost(overrides: Record<string, unknown> = {}) {
  return {
    id: "gate",
    kind: "ssh",
    label: "Gate",
    hostname: "gate.example.ts.net",
    port: 22,
    username: "ops",
    authType: "password",
    ...overrides,
  };
}

vi.mock("../../store/appStore", () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state),
}));

// 감시는 붙지 못한 tailnet 세션 동안만 걸린다. 여기서는 그 왕복 자체를 재지 않는다.
vi.mock("../../services/desktop/tailnet-watch", () => ({
  acquireTailnetWatch: vi.fn(() => () => undefined),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { VncConnectionOverlay } = await import("./VncConnectionOverlay");

describe("VncConnectionOverlay", () => {
  beforeEach(() => {
    state.tailnetStatuses = {};
    seed(
      { status: "error", errorMessage: "Authentication or authorization failure" },
      {},
    );
  });

  // 스토어에는 IPC 원문이 담긴다. 화면이 공통 분류기를 지나지 않으면 사용자가
  // "Error invoking remote method 'vnc:connect': Error: ..." 를 그대로 읽게 된다.
  it("IPC 원문 대신 공통 분류기의 문장을 보여준다", () => {
    seed(
      {
        status: "error",
        errorMessage:
          "Error invoking remote method 'vnc:connect': Error: Host key is not trusted yet.",
        connectionProgress: null,
      },
      {},
    );

    render(<VncConnectionOverlay sessionId="vnc-1" />);

    expect(screen.queryByText(/invoking remote method/u)).toBeNull();
    expect(
      screen.getByText(/호스트 키를 아직 신뢰하지 않았습니다/u),
    ).toBeTruthy();
  });

  // 진행 중 문구는 우리가 만든 단계 설명이다. 분류기를 태우면 멀쩡한 문장이 바뀐다.
  it("연결 중 문구는 그대로 둔다", () => {
    seed(
      {
        status: "connecting",
        connectionProgress: { stage: "connecting", message: "VNC 포트까지 통로 개설" },
      },
      {},
    );

    render(<VncConnectionOverlay sessionId="vnc-1" />);

    expect(screen.getByText("VNC 포트까지 통로 개설")).toBeTruthy();
  });

  it("Close 는 탭을 닫는다", () => {
    // onClose 를 넘기지 않으면 버튼이 그려지긴 하는데 아무 일도 하지 않는다 — 그 상태로 나가 있었다.
    render(<VncConnectionOverlay sessionId="vnc-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(disconnectTab).toHaveBeenCalledWith("vnc-1");
  });

  it("Retry 는 같은 탭에 다시 붙는다", () => {
    render(<VncConnectionOverlay sessionId="vnc-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(retryVncConnection).toHaveBeenCalledWith("vnc-1");
  });

  it("tailnet 호스트는 그 관문을 단계로 보여준다", () => {
    // 한 줄 진행 문구로는 "연결하는 중" 밖에 말할 수 없다. tailnet 인증이 아직 안 끝났는지,
    // 넷맵에 대상이 없는지 알아야 한다 — 그게 안 보이면 그냥 멈춘 것처럼 보인다.
    seed({ status: "connecting" }, { tailnetId: "net-a" });
    state.tailnetStatuses = {
      "net-a": { id: "net-a", state: "needsAuth", ready: false },
    };

    render(<VncConnectionOverlay sessionId="vnc-1" />);

    expect(screen.getByRole("list").textContent).toContain("Tailscale");
  });

  it("tailnet 을 안 쓰는 호스트에는 그 관문을 세우지 않는다", () => {
    // 없는 관문을 세우면 무엇을 기다리는지 오히려 헷갈린다. 연결 한 줄만 남는다(RDP 와 같다).
    seed({ status: "connecting" }, {});

    render(<VncConnectionOverlay sessionId="vnc-1" />);

    expect(screen.getByRole("list").textContent).not.toContain("Tailscale");
  });
  // 터널은 경유 호스트의 tailnet 설정을 그대로 탄다. VNC 호스트 자신에 tailnet 이 없어도 노드가
  // 올라오고 브라우저 로그인을 기다리는 것은 그쪽이라, 그것을 안 보여주면 이 화면은 이유 없이 멈춘다.
  it("경유 SSH 호스트의 tailnet 도 관문으로 보여준다", () => {
    seed(
      { status: "connecting" },
      { sshTunnelHostId: "gate", hostname: "127.0.0.1" },
      [gateHost({ tailnetId: "net-a" })],
    );
    state.tailnetStatuses = {
      "net-a": { id: "net-a", state: "needsAuth", ready: false },
    };

    render(<VncConnectionOverlay sessionId="vnc-1" />);

    const list = screen.getByRole("list").textContent ?? "";
    expect(list).toContain("Tailscale");
    // 터널 관문도 함께 선다(라벨에 경유 호스트 이름이 들어간다).
    expect(list).toContain("Gate");
  });

  // 로그인 링크가 있으면 사용자가 할 일은 브라우저로 돌아가는 것뿐이다. 감추면 할 수 있는 일을
  // 못 찾는다 — 실패로 앉은 화면에서도 보여준다.
  it("tailnet 로그인 링크를 다시 열 수 있다", () => {
    seed({ status: "connecting" }, { tailnetId: "net-a" });
    state.tailnetStatuses = {
      "net-a": {
        id: "net-a",
        state: "needsAuth",
        ready: false,
        authUrl: "https://login.tailscale.com/a/abc",
      },
    };

    render(<VncConnectionOverlay sessionId="vnc-1" />);
    fireEvent.click(screen.getByRole("button", { name: "misc.reopenBrowser" }));

    expect(openExternalUrl).toHaveBeenCalledWith("https://login.tailscale.com/a/abc");
  });

  // 대상 주소를 VNC 호스트의 것으로 넘기면(터널 뒤라 대개 127.0.0.1) 넷맵에 있을 수 없어서
  // "대상 기기가 없습니다" 가 거짓으로 뜬다. 찾아야 하는 기기는 경유 호스트다.
  it("터널을 쓸 때 넷맵에서 경유 호스트를 찾는다", () => {
    seed(
      { status: "connecting" },
      { sshTunnelHostId: "gate", hostname: "127.0.0.1" },
      [gateHost({ tailnetId: "net-a" })],
    );
    state.tailnetStatuses = {
      "net-a": {
        id: "net-a",
        state: "running",
        ready: true,
        authorized: true,
        online: true,
        peers: [{ hostName: "gate", dnsName: "gate.example.ts.net", direct: true }],
      },
    };

    render(<VncConnectionOverlay sessionId="vnc-1" />);

    const list = screen.getByRole("list").textContent ?? "";
    expect(list).not.toContain("127.0.0.1");
    expect(list).toContain("gate.example.ts.net");
  });
});
