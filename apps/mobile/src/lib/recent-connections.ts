// "최근 세션" 목록을 만드는 규칙.
//
// 스토어·화면에서 떼어 둔 이유는 검증이다 — 목록은 두 종류의 세션 기록(터미널, 원격
// 데스크톱)을 합쳐야 하고, 합치는 규칙이 틀리면 화면에는 "아무것도 없음" 으로만 보인다.

import type {
  MobileRemoteDesktopSessionRecord,
  MobileSessionRecord,
} from '@dolssh/shared-core';

export interface RecentConnection {
  /** 재연결 방법이 종류마다 다르다 — 터미널은 세션을 되살리고, RD 는 호스트에 새로 붙는다. */
  kind: 'terminal' | 'rdp' | 'vnc';
  id: string;
  hostId: string;
  title: string;
  lastEventAt: string;
}

/** 화면에 보여줄 개수. 그 이상은 최근이라고 부르기 어렵다. */
const DEFAULT_LIMIT = 5;

/**
 * 다시 붙을 수 있는 세션들을 최근순으로 합친다.
 *
 * **호스트마다 하나만 남긴다.** 같은 호스트에 하루에도 여러 번 붙으면 닫힌 기록이 그만큼
 * 쌓이고, 목록은 같은 이름으로 가득 찬다.
 *
 * 원격 데스크톱은 `isRestorable` 같은 개념이 없다 — 끊긴 기록은 전부 다시 붙을 수 있다(비밀은
 * 볼트에, 호스트는 목록에 그대로 있다). 터미널만 그 표시를 본다.
 */
export function buildRecentConnections(input: {
  sessions: MobileSessionRecord[];
  remoteDesktopSessions: MobileRemoteDesktopSessionRecord[];
  limit?: number;
}): RecentConnection[] {
  const { sessions, remoteDesktopSessions, limit = DEFAULT_LIMIT } = input;

  const candidates: RecentConnection[] = [
    // 터미널은 기존 규칙 그대로다 — 닫혔고 되살릴 수 있는 것만. 끊긴(error/dropped) 세션은
    // 탭에 그대로 남아 있으므로 여기 넣으면 같은 세션이 두 곳에 보인다.
    ...sessions
      .filter(session => session.status === 'closed' && session.isRestorable)
      .map(session => ({
        kind: 'terminal' as const,
        id: session.id,
        hostId: session.hostId,
        title: session.title,
        lastEventAt: session.lastEventAt,
      })),
    ...remoteDesktopSessions
      .filter(session => session.status === 'closed')
      .map(session => ({
        kind: session.protocol,
        id: session.id,
        hostId: session.hostId,
        title: session.title,
        lastEventAt: session.lastEventAt,
      })),
  ];

  const seenHosts = new Set<string>();
  const newestPerHost: RecentConnection[] = [];
  for (const candidate of [...candidates].sort((left, right) =>
    right.lastEventAt.localeCompare(left.lastEventAt),
  )) {
    if (seenHosts.has(candidate.hostId)) continue;
    seenHosts.add(candidate.hostId);
    newestPerHost.push(candidate);
  }
  return newestPerHost.slice(0, limit);
}
