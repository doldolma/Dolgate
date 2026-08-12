import { describe, expect, it, vi } from 'vitest';
import type { HostRecord, TerminalTab } from '@shared';

import { createAppStore } from './createAppStore';
import { createMockApi } from './createAppStore.test-support';

// VNC 세션은 터미널이 아니라 원격 화면이다. 탭이 `paneKind: 'vnc'` 로 열려야 렌더러가 xterm 대신
// 캔버스를 띄우고, 닫을 때 ssh-core 가 아니라 vnc-core 로 끊어야 한다 — 그 두 갈림길을 잠근다.

const VNC_HOST: HostRecord = {
  id: 'vnc1',
  kind: 'vnc',
  label: 'Lab console',
  hostname: '10.0.2.90',
  port: 5901,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as HostRecord;

function seed() {
  const api = createMockApi();
  const store = createAppStore(api);
  store.setState({ hosts: [VNC_HOST] });
  return { api, store };
}

describe('VNC 세션 열기', () => {
  it('원격 화면 탭으로 열고 해상도를 싣는다', async () => {
    const { api, store } = seed();

    await store.getState().connectHost('vnc1', 80, 24);

    expect(api.vnc.connect).toHaveBeenCalledTimes(1);
    // 터미널 경로로 새면 xterm 이 붙고 화면이 안 뜬다.
    expect(api.ssh.connect).not.toHaveBeenCalled();

    const tab = store.getState().tabs.at(-1);
    expect(tab?.paneKind).toBe('vnc');
    expect(tab?.hostId).toBe('vnc1');
    expect(tab?.status).toBe('connected');
    // 붙은 뒤에는 진행 표시를 지운다 — 남으면 연결 화면이 캔버스를 가린다.
    expect(tab?.connectionProgress ?? null).toBeNull();
    expect(tab?.rdpDesktopSize).toEqual({ width: 1280, height: 800 });
  });

  it('접속 실패는 탭에 이유를 남긴다', async () => {
    const { api, store } = seed();
    // 다른 테스트와 같은 방식으로 갈아끼운다 — 모의 API 타입은 실제 API 를 따르므로 vi.fn 이
    // 아니라 함수 타입이다.
    api.vnc.connect = vi
      .fn()
      .mockRejectedValueOnce(new Error('authentication failed'));

    await store.getState().connectHost('vnc1', 80, 24);

    const tab = store.getState().tabs.at(-1);
    expect(tab?.status).toBe('error');
    // 서버가 붙인 사유가 그대로 보여야 한다 — 비밀번호가 틀렸는지 알 방법이 이것뿐이다.
    expect(tab?.errorMessage).toContain('authentication failed');
  });

  // 탭만 지우면 사이드카 세션이 살아남아 프레임을 계속 흘린다(RDP 에서 겪은 것과 같은 함정).
  it('탭을 닫으면 vnc-core 세션을 끊는다', async () => {
    const { api, store } = seed();
    await store.getState().connectHost('vnc1', 80, 24);
    const sessionId = store.getState().tabs.at(-1)?.sessionId as string;

    await store.getState().disconnectTab(sessionId);

    expect(api.vnc.disconnect).toHaveBeenCalledWith(sessionId);
    // ssh-core 로 가면 아무 일도 일어나지 않고 세션이 남는다.
    expect(api.ssh.disconnect).not.toHaveBeenCalledWith(sessionId);
    expect(
      store.getState().tabs.some((tab) => tab.sessionId === sessionId),
    ).toBe(false);
  });
});

// 원격 화면은 분할 화면에 들어가지 않는다. 프레임버퍼 하나를 반쪽 pane 에 넣으면 글자를 읽을 수
// 없고, 자동 리사이즈가 분할·복원마다 원격 배치를 다시 잡는다.
describe('VNC 연결 진행 보고', () => {
  // 통로(SSH 터널)를 여는 데 걸리는 시간이 길고 거기서 막히는 일이 흔하다. 그 사실이 탭에 닿지
  // 않으면 연결 화면은 "연결하는 중" 한 줄로 몇 분을 앉아 있는다.
  it('메인이 알린 관문을 탭에 싣는다', () => {
    const { store } = seed();
    store.setState({
      tabs: [
        {
          sessionId: 'vnc-s1',
          stableId: 'vnc-stable-1',
          hostId: 'vnc1',
          paneKind: 'vnc',
          status: 'pending',
          source: 'host',
          title: 'Lab console',
        } as unknown as TerminalTab,
      ],
    });

    store.getState().handleVncEvent({
      type: 'progress',
      sessionId: 'vnc-s1',
      stage: 'ssh-tunnel-gateway',
      message: '경유 SSH 호스트 Gate 에 접속합니다.',
    });

    const tab = store.getState().tabs[0];
    expect(tab.connectionProgress?.stage).toBe('ssh-tunnel-gateway');
    expect(tab.connectionProgress?.message).toBe(
      '경유 SSH 호스트 Gate 에 접속합니다.',
    );
  });

  // 통로 보고는 접속 요청 안에서 나오므로 실패한 뒤에 도착하는 순서가 실제로 생긴다. 그때 얹으면
  // 방금 띄운 실패 이유가 진행 문구로 덮인다.
  it('결과가 난 탭은 덮지 않는다', () => {
    const { store } = seed();
    const failed = {
      sessionId: 'vnc-s1',
      stableId: 'vnc-stable-1',
      hostId: 'vnc1',
      paneKind: 'vnc',
      status: 'error',
      source: 'host',
      title: 'Lab console',
      errorMessage: 'ssh: handshake failed',
    } as unknown as TerminalTab;
    store.setState({ tabs: [failed] });

    store.getState().handleVncEvent({
      type: 'progress',
      sessionId: 'vnc-s1',
      stage: 'connecting',
      message: '협상합니다',
    });

    const tab = store.getState().tabs[0];
    expect(tab.status).toBe('error');
    expect(tab.errorMessage).toBe('ssh: handshake failed');
  });
});

describe("원격 화면은 분할하지 않는다", () => {
  function seed() {
    const store = createAppStore(createMockApi());
    const tab = (sessionId: string, paneKind: "terminal" | "rdp" | "vnc") =>
      ({
        sessionId,
        stableId: `stable-${sessionId}`,
        title: sessionId,
        status: "connected",
        source: "host",
        hostId: `h-${sessionId}`,
        paneKind,
        lastEventAt: "2026-01-01T00:00:00.000Z",
      }) as unknown as TerminalTab;
    store.setState({
      tabs: [tab("ssh-1", "terminal"), tab("vnc-1", "vnc"), tab("rdp-1", "rdp")],
      tabStrip: [
        { kind: "session", sessionId: "ssh-1" },
        { kind: "session", sessionId: "vnc-1" },
        { kind: "session", sessionId: "rdp-1" },
      ],
      workspaces: [],
    });
    return store;
  }

  it("VNC·RDP 탭은 끌어도 분할되지 않는다", () => {
    const store = seed();

    expect(store.getState().splitSessionIntoWorkspace("vnc-1", "right")).toBe(false);
    expect(store.getState().splitSessionIntoWorkspace("rdp-1", "left")).toBe(false);
    expect(store.getState().workspaces).toHaveLength(0);
  });

  it("받는 쪽이 원격 화면이면 그것도 막는다", () => {
    // SSH 탭을 VNC 탭 위로 끌면 그 분할 안에 원격 화면이 들어간다. 끌고 있는 쪽만 보면 놓친다.
    const store = seed();

    expect(store.getState().splitSessionIntoWorkspace("ssh-1", "right")).toBe(false);
    expect(store.getState().workspaces).toHaveLength(0);
  });
});
