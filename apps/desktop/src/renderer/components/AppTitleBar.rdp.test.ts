import { describe, expect, it } from 'vitest';
import type { HostRecord, TerminalTab } from '@shared';

import { buildTabHoverInfo } from './AppTitleBar';

// 마이크가 안 되는 이유는 **어딘가에는 반드시 보여야 한다** — 조용히 실패하면 사용자는 마이크가
// 켜진 줄 알고 원격에서 말한다. 예전에는 원격 화면 위에 배너로 겹쳐 두었는데 원격의 작업 표시줄과
// 섞여 읽히지 않았고 붙어 있는 내내 떠 있었다. 그래서 탭 hover 로 옮겼고, 이 테스트가 그 자리를
// 지킨다.

const rdpHost = (): HostRecord =>
  ({
    id: 'h-rdp',
    kind: 'rdp',
    label: 'win-box',
    hostname: '10.211.55.3',
    port: 3389,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }) as HostRecord;

const rdpTab = (overrides: Record<string, unknown> = {}): TerminalTab =>
  ({
    sessionId: 'rdp-1',
    stableId: 's-rdp-1',
    title: 'win-box',
    status: 'connected',
    source: 'host',
    hostId: 'h-rdp',
    paneKind: 'rdp',
    lastEventAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }) as unknown as TerminalTab;

const build = (tab: TerminalTab) =>
  Object.fromEntries(
    buildTabHoverInfo(
      { kind: 'session', sessionId: 'rdp-1', active: true } as never,
      [tab],
      [rdpHost()],
      [],
      [],
      () => null,
    ).rows.map((row) => [row.label, row.value]),
  );

describe('탭 hover 의 카메라 행', () => {
  it('보낼 수 있으면 행이 없다', () => {
    expect(build(rdpTab())['카메라']).toBeUndefined();
  });

  it('이유마다 짧은 상태 말을 보여준다', () => {
    expect(build(rdpTab({ rdpCameraProblem: 'denied' }))['카메라']).toBe('권한 거부됨');
    expect(build(rdpTab({ rdpCameraProblem: 'serverRefused' }))['카메라']).toBe(
      '원격이 열지 않음',
    );
  });

  // 마이크와 카메라가 동시에 실패할 수 있다. 한 행이 다른 행을 덮으면 원인 하나를 놓친다.
  it('마이크와 카메라가 같이 실패하면 두 행이 다 보인다', () => {
    const rows = build(
      rdpTab({ rdpMicrophoneProblem: 'denied', rdpCameraProblem: 'noDevice' }),
    );
    expect(rows['마이크']).toBe('권한 거부됨');
    expect(rows['카메라']).toBe('장치 없음');
  });
});

describe('탭 hover 의 마이크 행', () => {
  it('보낼 수 있으면 행이 없다', () => {
    // 정상인 세션에서 행이 늘면 정작 문제가 있는 값이 묻힌다.
    expect(build(rdpTab())['마이크']).toBeUndefined();
    expect(build(rdpTab({ rdpMicrophoneProblem: null }))['마이크']).toBeUndefined();
  });

  it('이유마다 짧은 상태 말을 보여준다', () => {
    // hover 행은 좁고 잘린다(truncate) — 긴 안내 문장을 넣으면 읽히지 않는다.
    expect(build(rdpTab({ rdpMicrophoneProblem: 'denied' }))['마이크']).toBe('권한 거부됨');
    expect(build(rdpTab({ rdpMicrophoneProblem: 'noDevice' }))['마이크']).toBe('장치 없음');
    expect(build(rdpTab({ rdpMicrophoneProblem: 'failed' }))['마이크']).toBe('열 수 없음');
    expect(build(rdpTab({ rdpMicrophoneProblem: 'serverRefused' }))['마이크']).toBe(
      '원격이 열지 않음',
    );
  });
});
