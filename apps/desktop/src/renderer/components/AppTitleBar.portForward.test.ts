// 탭 hover 의 포워딩 행. 실행 중 포워딩이 포트 화면에만 보여서, 탭을 닫은 뒤에도 켜져 있는 것을
// 모르고 지나갔다 — 닫기 전에 보이게 하는 것이 이 행의 목적이다.

import { describe, expect, it } from 'vitest';
import type { HostRecord, PortForwardRuntimeRecord, TerminalTab } from '@shared';
import { buildTabHoverInfo } from './AppTitleBar';

const host = () =>
  ({
    id: 'host-1',
    kind: 'ssh',
    label: 'Prod',
    hostname: 'prod.example.com',
    port: 22,
    username: 'deploy',
    authType: 'password',
  }) as unknown as HostRecord;

const tab = () =>
  ({ sessionId: 'session-1', hostId: 'host-1', title: 'Prod' }) as unknown as TerminalTab;

const runtime = (
  overrides: Partial<PortForwardRuntimeRecord> = {},
): PortForwardRuntimeRecord => ({
  ruleId: 'rule-1',
  hostId: 'host-1',
  transport: 'ssh',
  bindAddress: '127.0.0.1',
  bindPort: 15432,
  status: 'running',
  updatedAt: '',
  ...overrides,
});

const rowsOf = (
  runtimes: PortForwardRuntimeRecord[],
  item: unknown = { kind: 'session', sessionId: 'session-1', active: true },
  tmuxGroups: unknown[] = [],
) =>
  Object.fromEntries(
    buildTabHoverInfo(
      item as never,
      [tab()],
      [host()],
      tmuxGroups as never,
      [],
      () => null,
      runtimes,
    ).rows.map((row) => [row.label, row.value]),
  );

describe('탭 hover 의 포워딩 행', () => {
  it('켜진 것이 없으면 행을 만들지 않는다', () => {
    expect(rowsOf([runtime({ status: 'stopped' })])['포워딩']).toBeUndefined();
  });

  it('개수와 포트를 보여준다', () => {
    expect(
      rowsOf([runtime(), runtime({ ruleId: 'rule-2', bindPort: 8080 })])['포워딩'],
    ).toBe('2 · 15432, 8080');
  });

  it('다른 호스트의 포워딩은 섞지 않는다', () => {
    // 규칙은 호스트 소유라, 걸러내지 않으면 남의 포트가 이 탭의 것으로 보인다.
    expect(
      rowsOf([runtime(), runtime({ ruleId: 'rule-2', hostId: 'host-2', bindPort: 9999 })])[
        '포워딩'
      ],
    ).toBe('1 · 15432');
  });

  it('아직 열리지 않은 것은 그 사실을 말한다', () => {
    // "2개" 로 뭉치면 포트가 왜 안 되는지 찾을 때 이 줄이 거짓 단서가 된다.
    expect(rowsOf([runtime({ status: 'starting' })])['포워딩']).toBe('1 · 1개 시작 중');
  });

  it('포트가 많으면 앞의 셋만 적고 나머지는 수로 남긴다', () => {
    expect(
      rowsOf([
        runtime({ ruleId: 'r1', bindPort: 1 }),
        runtime({ ruleId: 'r2', bindPort: 2 }),
        runtime({ ruleId: 'r3', bindPort: 3 }),
        runtime({ ruleId: 'r4', bindPort: 4 }),
      ])['포워딩'],
    ).toBe('4 · 1, 2, 3 +1');
  });

  it('전송 방식 네 가지를 모두 센다', () => {
    expect(
      rowsOf([
        runtime({ ruleId: 'r1', transport: 'ssh', bindPort: 1 }),
        runtime({ ruleId: 'r2', transport: 'aws-ssm', bindPort: 2 }),
        runtime({ ruleId: 'r3', transport: 'ecs-task', bindPort: 3 }),
        runtime({ ruleId: 'r4', transport: 'container', bindPort: 4 }),
      ])['포워딩'],
    ).toBe('4 · 1, 2, 3 +1');
  });

  it('tmux 그룹 탭에서도 나온다', () => {
    // control mode 로 붙으면 원래 탭이 그룹으로 바뀌어 tabs 에서 사라진다. 세션 분기에만
    // 넣으면 그 순간 행이 없어진다.
    expect(
      rowsOf(
        [runtime()],
        { kind: 'tmux', tmuxGroupId: 'group-1', active: true },
        [{ id: 'group-1', hostId: 'host-1' }],
      )['포워딩'],
    ).toBe('1 · 15432');
  });
});
