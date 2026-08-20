import { forwardRef, useImperativeHandle } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '@shared';
import { HomeShell } from './HomeShell';

/**
 * 편집기를 떠나는 경로가 실제로 **배관까지** 연결돼 있는지 본다.
 *
 * 훅(useHostBrowser)과 확인 다이얼로그는 각자 테스트가 있는데도 기능이 동작하지 않은 적이 있다 —
 * HomeShell 이 veto 콜백을 HostBrowser 에 넘기지 않아서였다. 양쪽이 다 초록인데 화면에서는 아무
 * 일도 일어나지 않는 상태였고, 그것을 잡는 테스트가 여기다.
 */

let browserProps: Record<string, unknown> = {};
let drawerIsDirty = false;
const drawerSave = vi.fn().mockResolvedValue(true);

vi.mock('../components/HostBrowser', () => ({
  HostBrowser: (props: Record<string, unknown>) => {
    browserProps = props;
    return <div data-testid="host-browser">{props.hostEditor as never}</div>;
  },
}));

vi.mock('../components/HostDrawer', () => ({
  HostDrawer: forwardRef(
    (props: { host?: HostRecord | null }, ref: React.Ref<unknown>) => {
      useImperativeHandle(ref, () => ({
        isDirty: () => drawerIsDirty,
        save: drawerSave,
      }));
      return <div data-testid="host-drawer" data-host-id={props.host?.id ?? ''} />;
    },
  ),
}));

vi.mock('../view-models/settings', () => ({
  useSettingsViewModel: () => stub({ keychainEntries: [], activityLogs: [], settings: {} }),
}));

vi.mock('../services/desktop/tailnet', () => ({
  listTailnets: vi.fn().mockResolvedValue([]),
}));

function stub(overrides: Record<string, unknown>) {
  return new Proxy(overrides, {
    get: (target, key: string) => (key in target ? target[key] : vi.fn()),
  }) as never;
}

function createHost(id: string, label: string): HostRecord {
  return {
    id,
    kind: 'ssh',
    label,
    hostname: `${id}.example.test`,
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    privateKeyPath: null,
    secretRef: null,
    groupName: null,
    tags: [],
    terminalThemeId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as HostRecord;
}

const hosts = [createHost('host-1', 'App'), createHost('host-2', 'DB')];

function renderHome(openEditHostDrawer = vi.fn(), closeHostDrawer = vi.fn()) {
  const homeViewModel = stub({
    hosts,
    groups: [],
    snippets: [],
    portForwards: [],
    portForwardRuntimes: [],
    dnsOverrides: [],
    sessions: [],
    currentGroupPath: null,
    homeSection: 'hosts',
    hostDrawer: { mode: 'edit', hostId: 'host-1' },
    openEditHostDrawer,
    closeHostDrawer,
  });

  render(
    <HomeShell
      active
      authState={stub({ status: 'authenticated', session: {}, capabilities: {} })}
      offlineLeaseExpiryLabel={null}
      desktopPlatform="darwin"
      homeViewModel={homeViewModel}
      containersViewModel={stub({ tabs: [] })}
      modalViewModel={stub({})}
      loginController={stub({})}
      onRequestSecretEditor={vi.fn()}
    />,
  );

  return { openEditHostDrawer, closeHostDrawer };
}

describe('HomeShell 편집기 이탈 가드', () => {
  beforeEach(() => {
    browserProps = {};
    drawerIsDirty = false;
    drawerSave.mockClear();
  });

  it('호스트 목록과 그룹 이동에 가드 콜백을 넘긴다', () => {
    renderHome();

    expect(typeof browserProps.canSelectHost).toBe('function');
    expect(typeof browserProps.onLeaveGroupScope).toBe('function');
  });

  it('변경이 없으면 고른 호스트 편집으로 바로 넘어간다', () => {
    const { openEditHostDrawer } = renderHome();

    const canSelectHost = browserProps.canSelectHost as (hostId: string) => boolean;
    // 선택은 상위가 selectedHostId 로 옮긴다 — 목록 내부 상태는 움직이지 않는다.
    expect(canSelectHost('host-2')).toBe(false);
    expect(openEditHostDrawer).toHaveBeenCalledWith('host-2');
  });

  it('변경이 있으면 묻고, 저장을 고르면 저장한 뒤 넘어간다', async () => {
    drawerIsDirty = true;
    const { openEditHostDrawer } = renderHome();

    const canSelectHost = browserProps.canSelectHost as (hostId: string) => boolean;
    let allowed: boolean | null = null;
    act(() => {
      allowed = canSelectHost('host-2');
    });
    expect(allowed).toBe(false);
    expect(openEditHostDrawer).not.toHaveBeenCalled();

    // 선택지는 취소/저장 둘뿐이다. 저장하면 그때 이동한다.
    expect(screen.getByText('저장하지 않은 변경사항이 있습니다')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await waitFor(() => expect(drawerSave).toHaveBeenCalled());
    await waitFor(() => expect(openEditHostDrawer).toHaveBeenCalledWith('host-2'));
  });

  // 막기만 하면 확인 뒤에 이동을 실행할 주체가 없어 편집기만 닫혔다. 이동 자체가 이어서 실행돼야
  // 한다 — 이 테스트가 그 계속(continuation)을 지킨다.
  it('그룹 이동은 변경이 있으면 묻고, 저장한 뒤에 이동까지 실행한다', async () => {
    drawerIsDirty = true;
    const { closeHostDrawer } = renderHome();
    const proceed = vi.fn();

    const onLeaveGroupScope = browserProps.onLeaveGroupScope as (
      proceed: () => void,
    ) => void;
    act(() => {
      onLeaveGroupScope(proceed);
    });
    expect(proceed).not.toHaveBeenCalled();
    expect(closeHostDrawer).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await waitFor(() => expect(closeHostDrawer).toHaveBeenCalled());
    await waitFor(() => expect(proceed).toHaveBeenCalledTimes(1));
  });

  it('그룹 이동에 변경이 없으면 묻지 않고 바로 이동한다', () => {
    const { closeHostDrawer } = renderHome();
    const proceed = vi.fn();

    const onLeaveGroupScope = browserProps.onLeaveGroupScope as (
      proceed: () => void,
    ) => void;
    act(() => {
      onLeaveGroupScope(proceed);
    });

    expect(closeHostDrawer).toHaveBeenCalled();
    expect(proceed).toHaveBeenCalledTimes(1);
  });
});
