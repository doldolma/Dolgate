import {
  createRemoteDesktopSlice,
  getLiveRemoteDesktopSessions,
  guardRemoteDesktopEngine,
  setRemoteDesktopHandle,
  getRemoteDesktopHandle,
  removeRemoteDesktopHandle,
  getAllRemoteDesktopHandles,
  _resetHandlesForTests,
} from '../src/store/remoteDesktopSlice';
import type { MobileRemoteDesktopSessionRecord } from '@dolssh/shared-core';

type SliceState = {
  remoteDesktopSessions: MobileRemoteDesktopSessionRecord[];
  remoteDesktopImmersive: boolean;
};

let state: SliceState;
let slice: ReturnType<typeof createRemoteDesktopSlice>;

beforeEach(() => {
  jest.useFakeTimers();
  state = { remoteDesktopSessions: [], remoteDesktopImmersive: false };
  slice = createRemoteDesktopSlice(
    partial => {
      if (typeof partial === 'function') {
        Object.assign(state, partial(state));
      } else {
        Object.assign(state, partial);
      }
    },
    () => state,
  );
});

afterEach(() => {
  jest.useRealTimers();
  _resetHandlesForTests();
});

describe('remoteDesktopSlice', () => {

  describe('createRemoteDesktopSession', () => {
    it('adds a new RDP session in connecting state', () => {
      slice.createRemoteDesktopSession({
        id: 'rd-1',
        hostId: 'host-1',
        protocol: 'rdp',
        title: 'My RDP',
      });

      expect(state.remoteDesktopSessions).toHaveLength(1);
      const session = state.remoteDesktopSessions[0];
      expect(session.id).toBe('rd-1');
      expect(session.hostId).toBe('host-1');
      expect(session.protocol).toBe('rdp');
      expect(session.title).toBe('My RDP');
      expect(session.status).toBe('connecting');
      expect(session.inputMode).toBe('trackpad');
      expect(session.scaleMode).toBe('fit');
      expect(session.openedAt).toBeDefined();
    });

    it('adds a new VNC session', () => {
      slice.createRemoteDesktopSession({
        id: 'rd-2',
        hostId: 'host-2',
        protocol: 'vnc',
        title: 'My VNC',
      });

      expect(state.remoteDesktopSessions).toHaveLength(1);
      expect(state.remoteDesktopSessions[0].protocol).toBe('vnc');
    });
  });

  describe('updateRemoteDesktopSession', () => {
    beforeEach(() => {
      slice.createRemoteDesktopSession({
        id: 'rd-1',
        hostId: 'host-1',
        protocol: 'rdp',
        title: 'Test',
      });
    });

    it('updates status and error message', () => {
      slice.updateRemoteDesktopSession('rd-1', {
        status: 'error',
        errorMessage: 'Connection refused',
      });

      const session = state.remoteDesktopSessions[0];
      expect(session.status).toBe('error');
      expect(session.errorMessage).toBe('Connection refused');
    });

    it('updates lastEventAt on each update', () => {
      const before = state.remoteDesktopSessions[0].lastEventAt;
      slice.updateRemoteDesktopSession('rd-1', { status: 'connected' });
      const after = state.remoteDesktopSessions[0].lastEventAt;
      expect(after >= before).toBe(true);
    });

    it('does not modify other sessions', () => {
      slice.createRemoteDesktopSession({
        id: 'rd-2',
        hostId: 'host-2',
        protocol: 'vnc',
        title: 'Other',
      });

      slice.updateRemoteDesktopSession('rd-1', { status: 'connected' });

      expect(state.remoteDesktopSessions[1].status).toBe('connecting');
    });
  });

  describe('removeRemoteDesktopSession', () => {
    it('removes the session by id', () => {
      slice.createRemoteDesktopSession({
        id: 'rd-1',
        hostId: 'host-1',
        protocol: 'rdp',
        title: 'Remove me',
      });
      slice.createRemoteDesktopSession({
        id: 'rd-2',
        hostId: 'host-2',
        protocol: 'vnc',
        title: 'Keep me',
      });

      slice.removeRemoteDesktopSession('rd-1');

      expect(state.remoteDesktopSessions).toHaveLength(1);
      expect(state.remoteDesktopSessions[0].id).toBe('rd-2');
    });
  });
});

describe('getLiveRemoteDesktopSessions', () => {
  it('filters out closed sessions', () => {
    const sessions: MobileRemoteDesktopSessionRecord[] = [
      {
        id: '1',
        hostId: 'h1',
        protocol: 'rdp',
        title: 'Active',
        status: 'connected',
        inputMode: 'touch',
        scaleMode: 'fit',
        lastEventAt: new Date().toISOString(),
      },
      {
        id: '2',
        hostId: 'h2',
        protocol: 'vnc',
        title: 'Closed',
        status: 'closed',
        inputMode: 'touch',
        scaleMode: 'fit',
        lastEventAt: new Date().toISOString(),
      },
      {
        id: '3',
        hostId: 'h3',
        protocol: 'rdp',
        title: 'Error',
        status: 'error',
        inputMode: 'touch',
        scaleMode: 'fit',
        lastEventAt: new Date().toISOString(),
      },
    ];

    const live = getLiveRemoteDesktopSessions(sessions);
    expect(live).toHaveLength(2);
    expect(live.map(s => s.id)).toEqual(['1', '3']);
  });
});

describe('guardRemoteDesktopEngine', () => {
  it.each(['rdp', 'vnc'] as const)(
    'allows %s to proceed to the async native availability check',
    protocol => {
      expect(guardRemoteDesktopEngine(protocol)).toBeNull();
    },
  );
});

describe('remoteDesktopHandles (module-level map)', () => {
  beforeEach(() => {
    _resetHandlesForTests();
  });

  it('stores and retrieves a handle', () => {
    setRemoteDesktopHandle('s1', {
      sessionId: 's1',
      tunnelId: 'conn-1',
    });
    const handle = getRemoteDesktopHandle('s1');
    expect(handle).toBeDefined();
    expect(handle!.sessionId).toBe('s1');
    expect(handle!.tunnelId).toBe('conn-1');
  });

  it('removes a handle', () => {
    setRemoteDesktopHandle('s1', { sessionId: 's1' });
    removeRemoteDesktopHandle('s1');
    expect(getRemoteDesktopHandle('s1')).toBeUndefined();
  });

  it('getAllRemoteDesktopHandles returns all', () => {
    setRemoteDesktopHandle('s1', { sessionId: 's1' });
    setRemoteDesktopHandle('s2', { sessionId: 's2' });
    const all = getAllRemoteDesktopHandles();
    expect(all.size).toBe(2);
  });

  it('_resetHandlesForTests clears all', () => {
    setRemoteDesktopHandle('s1', { sessionId: 's1' });
    _resetHandlesForTests();
    expect(getAllRemoteDesktopHandles().size).toBe(0);
  });
});

describe('remoteDesktopImmersive', () => {
  it('starts off and toggles', () => {
    expect(state.remoteDesktopImmersive).toBe(false);
    slice.setRemoteDesktopImmersive(true);
    expect(state.remoteDesktopImmersive).toBe(true);
    slice.setRemoteDesktopImmersive(false);
    expect(state.remoteDesktopImmersive).toBe(false);
  });

  // 전체화면은 상·하단 크롬을 숨긴다. 마지막 세션이 사라졌는데 그 값이 남으면 탭 바 없는
  // 화면에 갇힌다 — 나가는 버튼도 RD 툴바에만 있으니 그 툴바째 사라진다.
  it('turns off when the last session is removed', () => {
    slice.createRemoteDesktopSession({
      id: 'rd-1',
      hostId: 'host-1',
      protocol: 'vnc',
      title: 'lab',
    });
    slice.setRemoteDesktopImmersive(true);

    slice.removeRemoteDesktopSession('rd-1');

    expect(state.remoteDesktopSessions).toHaveLength(0);
    expect(state.remoteDesktopImmersive).toBe(false);
  });

  it('stays on while another session remains', () => {
    for (const id of ['rd-1', 'rd-2']) {
      slice.createRemoteDesktopSession({
        id,
        hostId: 'host-1',
        protocol: 'rdp',
        title: id,
      });
    }
    slice.setRemoteDesktopImmersive(true);

    slice.removeRemoteDesktopSession('rd-1');

    expect(state.remoteDesktopImmersive).toBe(true);
  });
});

/**
 * 최근 세션 목록의 근거.
 *
 * RD 세션을 끊을 때 기록을 지우면 "최근 세션" 에 RDP/VNC 가 영원히 나타나지 않는다. 탭은
 * live 만 보므로 closed 기록이 남아도 탭이 늘지 않는다.
 */
describe('닫힌 RD 기록', () => {
  it('닫혀도 목록에 남고 탭에서는 빠진다', () => {
    slice.createRemoteDesktopSession({
      id: 'rd-1',
      hostId: 'host-1',
      protocol: 'rdp',
      title: 'win-box',
    });

    slice.updateRemoteDesktopSession('rd-1', { status: 'closed' });

    expect(state.remoteDesktopSessions).toHaveLength(1);
    expect(getLiveRemoteDesktopSessions(state.remoteDesktopSessions)).toHaveLength(
      0,
    );
  });

  // 살아 있는 세션이 없으면 전체화면도 끝나야 한다. 기록을 남기게 됐으니 개수로 셀 수 없다.
  it('마지막 세션이 닫히면 전체화면이 끝난다', () => {
    slice.createRemoteDesktopSession({
      id: 'rd-1',
      hostId: 'host-1',
      protocol: 'vnc',
      title: 'lab',
    });
    slice.setRemoteDesktopImmersive(true);

    slice.updateRemoteDesktopSession('rd-1', { status: 'closed' });

    expect(state.remoteDesktopImmersive).toBe(false);
  });

  it('다른 세션이 살아 있으면 전체화면을 유지한다', () => {
    for (const id of ['rd-1', 'rd-2']) {
      slice.createRemoteDesktopSession({
        id,
        hostId: `host-${id}`,
        protocol: 'rdp',
        title: id,
      });
    }
    slice.setRemoteDesktopImmersive(true);

    slice.updateRemoteDesktopSession('rd-1', { status: 'closed' });

    expect(state.remoteDesktopImmersive).toBe(true);
  });

  // 같은 호스트에 붙었다 끊기를 반복하면 닫힌 기록이 그만큼 쌓인다 — 목록이 같은 이름으로
  // 가득 차지 않게 새로 붙을 때 걷어낸다.
  it('같은 호스트에 다시 붙으면 옛 기록을 걷어낸다', () => {
    slice.createRemoteDesktopSession({
      id: 'rd-1',
      hostId: 'host-1',
      protocol: 'rdp',
      title: 'win-box',
    });
    slice.updateRemoteDesktopSession('rd-1', { status: 'closed' });

    slice.createRemoteDesktopSession({
      id: 'rd-2',
      hostId: 'host-1',
      protocol: 'rdp',
      title: 'win-box',
    });

    expect(state.remoteDesktopSessions.map(session => session.id)).toEqual([
      'rd-2',
    ]);
  });

  it('다른 호스트의 기록은 남긴다', () => {
    slice.createRemoteDesktopSession({
      id: 'rd-1',
      hostId: 'host-1',
      protocol: 'rdp',
      title: 'win-box',
    });
    slice.updateRemoteDesktopSession('rd-1', { status: 'closed' });

    slice.createRemoteDesktopSession({
      id: 'rd-2',
      hostId: 'host-2',
      protocol: 'rdp',
      title: 'other-box',
    });

    expect(state.remoteDesktopSessions).toHaveLength(2);
  });
});
