import { describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '@shared';

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
