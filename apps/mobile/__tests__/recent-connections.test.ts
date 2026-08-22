import { buildRecentConnections } from '../src/lib/recent-connections';
import type {
  MobileRemoteDesktopSessionRecord,
  MobileSessionRecord,
} from '@dolssh/shared-core';

function terminal(
  overrides: Partial<MobileSessionRecord> & { id: string; hostId: string },
): MobileSessionRecord {
  return {
    status: 'closed',
    isRestorable: true,
    title: overrides.id,
    lastEventAt: '2026-08-22T00:00:00.000Z',
    ...overrides,
  } as MobileSessionRecord;
}

function remoteDesktop(
  overrides: Partial<MobileRemoteDesktopSessionRecord> & {
    id: string;
    hostId: string;
  },
): MobileRemoteDesktopSessionRecord {
  return {
    protocol: 'rdp',
    status: 'closed',
    title: overrides.id,
    inputMode: 'trackpad',
    scaleMode: 'fit',
    lastEventAt: '2026-08-22T00:00:00.000Z',
    ...overrides,
  } as MobileRemoteDesktopSessionRecord;
}

/**
 * "최근 세션" 은 두 종류의 기록을 합친다.
 *
 * RDP/VNC 가 빠져 있던 것이 실제 증상이었다 — RD 세션은 별도 목록에 살고, 예전에는 끊을 때
 * 기록째 지워졌다.
 */
describe('buildRecentConnections', () => {
  it('터미널과 원격 데스크톱을 최근순으로 합친다', () => {
    const result = buildRecentConnections({
      sessions: [
        terminal({
          id: 'ssh-1',
          hostId: 'host-ssh',
          lastEventAt: '2026-08-22T01:00:00.000Z',
        }),
      ],
      remoteDesktopSessions: [
        remoteDesktop({
          id: 'rd-1',
          hostId: 'host-rdp',
          lastEventAt: '2026-08-22T02:00:00.000Z',
        }),
        remoteDesktop({
          id: 'rd-2',
          hostId: 'host-vnc',
          protocol: 'vnc',
          lastEventAt: '2026-08-22T00:30:00.000Z',
        }),
      ],
    });

    expect(result.map(entry => `${entry.kind}:${entry.id}`)).toEqual([
      'rdp:rd-1',
      'terminal:ssh-1',
      'vnc:rd-2',
    ]);
  });

  // 살아 있는 세션은 탭에 있다. 여기 또 넣으면 같은 세션이 두 곳에 보인다.
  it('살아 있는 RD 세션은 넣지 않는다', () => {
    const result = buildRecentConnections({
      sessions: [],
      remoteDesktopSessions: [
        remoteDesktop({ id: 'rd-1', hostId: 'host-1', status: 'connected' }),
        remoteDesktop({ id: 'rd-2', hostId: 'host-2', status: 'connecting' }),
      ],
    });

    expect(result).toEqual([]);
  });

  // 되살릴 수 없다고 표시된 터미널 세션은 예전 규칙대로 제외한다.
  it('되살릴 수 없는 터미널 세션은 넣지 않는다', () => {
    const result = buildRecentConnections({
      sessions: [
        terminal({ id: 'ssh-1', hostId: 'host-1', isRestorable: false }),
      ],
      remoteDesktopSessions: [],
    });

    expect(result).toEqual([]);
  });

  it('호스트마다 가장 최근 하나만 남긴다', () => {
    const result = buildRecentConnections({
      sessions: [],
      remoteDesktopSessions: [
        remoteDesktop({
          id: 'rd-old',
          hostId: 'host-1',
          lastEventAt: '2026-08-20T00:00:00.000Z',
        }),
        remoteDesktop({
          id: 'rd-new',
          hostId: 'host-1',
          lastEventAt: '2026-08-22T00:00:00.000Z',
        }),
      ],
    });

    expect(result.map(entry => entry.id)).toEqual(['rd-new']);
  });

  it('개수를 제한한다', () => {
    const result = buildRecentConnections({
      sessions: [],
      remoteDesktopSessions: Array.from({ length: 8 }, (_, index) =>
        remoteDesktop({
          id: `rd-${index}`,
          hostId: `host-${index}`,
          lastEventAt: `2026-08-2${index}T00:00:00.000Z`,
        }),
      ),
      limit: 3,
    });

    expect(result).toHaveLength(3);
  });
});
