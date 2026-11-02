import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ActivityLogRecord,
  ContainerActionLogMetadata,
  ContainerLifecycleLogMetadata,
  PortForwardLifecycleLogMetadata,
  SessionLifecycleLogMetadata,
  SftpLifecycleLogMetadata,
  TeamActivityItem,
  TeamActivityQuery,
} from '@shared';

const mocks = vi.hoisted(() => ({
  listTeamActivity: vi.fn(),
  getTeamReplayStatuses: vi.fn(),
  listTeamChanges: vi.fn(),
  restoreTeamChange: vi.fn(),
}));
vi.mock('../services/desktop/team-history', () => mocks);
const exportMocks = vi.hoisted(() => ({ exportLogsCsv: vi.fn() }));
vi.mock('../services/desktop/logs', () => exportMocks);

import { t } from '../i18n';
import { buildLogsCsv, LogsPanel, logsCsvFileName, matchesLogFilter, resolveLogsPeriod } from './LogsPanel';
import { LogsRangePickerDialog } from './LogsRangePickerDialog';

const HOUR = 3_600_000;
const ORIGIN = Date.UTC(2026, 9, 20);
/** 순번 seq 의 접속 줄 시각 — 순번 하나에 한 시간씩 뒤다. */
const timeOf = (seq: number) => new Date(ORIGIN + seq * HOUR).toISOString();
/** 지금 — 마지막 줄(300) 30분 뒤. */
const NOW = new Date(ORIGIN + 300 * HOUR + 30 * 60_000);

function sessionLog(id: string, overrides: Partial<SessionLifecycleLogMetadata> = {}): ActivityLogRecord {
  const metadata: SessionLifecycleLogMetadata = {
    sessionId: id,
    hostId: `host-${id}`,
    hostLabel: `web-${id}`,
    title: 'Web',
    connectionKind: 'ssh',
    connectedAt: timeOf(1),
    disconnectedAt: null,
    durationMs: null,
    status: 'closed',
    ...overrides,
  };
  return {
    id: `session:${id}`,
    level: 'info',
    category: 'session',
    kind: 'session-lifecycle',
    message: '세션',
    metadata: metadata as unknown as Record<string, unknown>,
    createdAt: metadata.connectedAt,
  };
}

/** 순번 1..50 은 b(폰), 그 뒤는 a(데스크톱) — b 의 줄은 첫 쪽(300..201)에 없다. */
function teamItem(seq: number): TeamActivityItem {
  const mobile = seq <= 50;
  const record = sessionLog(String(seq), {
    connectedAt: timeOf(seq),
    disconnectedAt: new Date(Date.parse(timeOf(seq)) + 90_000).toISOString(),
    durationMs: 90_000,
  });
  return {
    seq,
    id: `event-${seq}`,
    source: 'app',
    authorUserId: mobile ? 'user-b' : 'user-a',
    authorEmail: mobile ? 'b@example.com' : 'a@example.com',
    createdAt: timeOf(seq),
    receivedAt: timeOf(seq),
    activity: { v: 1, phase: 'end', record, ...(mobile ? { client: 'mobile' as const } : {}) },
    memberChange: null,
    unreadable: null,
  };
}

/** 순번 1..300 을 가진 서버 — 최신부터, before·after·limit 을 서버처럼. */
function fakeServer(count = 300) {
  const all = Array.from({ length: count }, (_value, index) => teamItem(count - index));
  mocks.listTeamActivity.mockImplementation(async (_teamId: string, query: TeamActivityQuery = {}) => {
    if (query.after) {
      return [];
    }
    const from = query.before ? all.findIndex((entry) => entry.seq < query.before!) : 0;
    return from < 0 ? [] : all.slice(from, from + (query.limit ?? 100));
  });
}

const TEAMS = [{ id: 'team-1', name: 'Platform', role: 'owner' as const }];

function renderPanel(props: Partial<Parameters<typeof LogsPanel>[0]> = {}) {
  const onListMembers = vi.fn().mockResolvedValue([
    { userId: 'user-a', email: 'a@example.com', role: 'owner', hasKey: true, addedBy: '', addedByEmail: '', addedAt: '' },
    { userId: 'user-b', email: 'b@example.com', role: 'member', hasKey: true, addedBy: '', addedByEmail: '', addedAt: '' },
    { userId: 'user-c', email: 'c@example.com', role: 'member', hasKey: true, addedBy: '', addedByEmail: '', addedAt: '' },
  ]);
  render(
    <LogsPanel
      logs={[]}
      onClear={vi.fn().mockResolvedValue(undefined)}
      onOpenReplay={vi.fn().mockResolvedValue(undefined)}
      teams={TEAMS}
      onListMembers={onListMembers}
      {...props}
    />,
  );
  return { onListMembers };
}

async function chooseTeam() {
  fireEvent.change(screen.getByRole('combobox', { name: 'Vault' }), { target: { value: 'team-1' } });
  await screen.findByText('web-300');
}

const countLine = () => screen.getByText(/^\d[\d,]*줄/);
const lifecycleCards = () => screen.queryAllByTestId('logs-lifecycle-card');
const bulkCalls = () =>
  mocks.listTeamActivity.mock.calls
    .map(([, query]) => query as TeamActivityQuery | undefined)
    .filter((query) => query?.limit === 200);

/** 내보낸 CSV 글을 줄로(BOM·끝의 빈 줄 빼고). */
function exportedLines(): string[] {
  const content = exportMocks.exportLogsCsv.mock.lastCall?.[0]?.content as string;
  expect(content.startsWith('﻿')).toBe(true);
  return content.slice(1).split('\r\n').filter(Boolean);
}

describe('LogsPanel — 사람·기간·CSV', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    fakeServer();
    mocks.getTeamReplayStatuses.mockReset().mockResolvedValue([]);
    mocks.listTeamChanges.mockReset().mockResolvedValue([]);
    exportMocks.exportLogsCsv.mockReset().mockResolvedValue({ canceled: false, savedPath: '/Users/me/Documents/x.csv' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('filters the team history by person, listing members who left nothing yet and people seen in the history', async () => {
    // a 는 멤버 목록에 없다(빠진 사람) — 기록에 남은 이름으로 고른다.
    const onListMembers = vi.fn().mockResolvedValue([
      { userId: 'user-b', email: 'b@example.com', role: 'member', hasKey: true, addedBy: '', addedByEmail: '', addedAt: '' },
      { userId: 'user-c', email: 'c@example.com', role: 'member', hasKey: true, addedBy: '', addedByEmail: '', addedAt: '' },
    ]);
    renderPanel({ onListMembers });
    expect(screen.queryByRole('combobox', { name: 'Person' })).toBeNull();
    await chooseTeam();

    const person = screen.getByRole('combobox', { name: 'Person' });
    await waitFor(() => expect(onListMembers).toHaveBeenCalledWith('team-1'));
    await waitFor(() =>
      expect(within(person).getAllByRole('option').map((option) => option.textContent)).toEqual([
        'All',
        'a@example.com',
        'b@example.com',
        'c@example.com',
      ]),
    );
    expect(countLine()).toHaveTextContent('100줄');

    fireEvent.change(person, { target: { value: 'c@example.com' } });
    expect(lifecycleCards()).toHaveLength(0);
    fireEvent.change(person, { target: { value: 'a@example.com' } });
    expect(lifecycleCards()).toHaveLength(100);
    expect(countLine()).toHaveTextContent('100줄');
  });

  it('picks a period in the container logs window, loads older rows up to its start, and goes back to all time', async () => {
    renderPanel();
    await chooseTeam();

    fireEvent.click(screen.getByRole('button', { name: '기간: 전체 기간' }));
    const dialog = screen.getByRole('dialog', { name: '로그 범위 선택' });
    // 컨테이너 로그의 'Follow' 설명이 아니라 기록의 설명이다.
    expect(dialog).toHaveTextContent('지금을 기준으로 거릅니다');
    expect(dialog).not.toHaveTextContent('Follow');
    // 처음 열면 최근 1주가 골라져 있다.
    expect(within(dialog).getByRole('radio', { name: '1주 전부터' })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('button', { name: '적용' }));

    // 1주(168시간) 안은 133..300 — 첫 쪽(300..201) 뒤 한 쪽을 더 받고 멈춘다.
    await waitFor(() => expect(countLine()).toHaveTextContent('168줄'));
    expect(bulkCalls()).toEqual([{ before: 201, limit: 200 }]);
    // 그 기간을 다 받았으니 목록 끝에서 더 받지 않는다.
    expect(document.querySelector('[data-logs-load-more]')).toBeNull();
    expect(screen.getByRole('button', { name: '기간: 최근 1주' })).toBeInTheDocument();
    expect(screen.queryByText('web-132')).toBeNull();
    expect(screen.getByText('web-133')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '기간: 최근 1주' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '로그 범위 선택' })).getByRole('button', { name: '전체 기간' }));
    expect(screen.getByRole('button', { name: '기간: 전체 기간' })).toBeInTheDocument();
    await waitFor(() => expect(countLine()).toHaveTextContent('300줄'));
  });

  it('exports every row matching the filters, loading the rest first, with the team for the record', async () => {
    const { onListMembers } = renderPanel();
    await chooseTeam();
    await waitFor(() => expect(onListMembers).toHaveBeenCalled());
    await screen.findByRole('option', { name: 'b@example.com' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Person' }), { target: { value: 'b@example.com' } });

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(exportMocks.exportLogsCsv).toHaveBeenCalledTimes(1));

    // b 의 줄(1..50)은 아직 안 받은 쪽에 있었다 — 끝까지 받고 내보낸다.
    expect(bulkCalls()).toEqual([
      { before: 201, limit: 200 },
      { before: 1, limit: 200 },
    ]);
    const request = exportMocks.exportLogsCsv.mock.lastCall![0];
    expect(request).toMatchObject({ rowCount: 50, vaultId: 'team-1', fileName: logsCsvFileName('Platform', NOW) });
    const lines = exportedLines();
    expect(lines[0]).toBe('Time,Person,Device,Kind,Host,Status,Message,Started,Ended,Duration (s)');
    expect(lines).toHaveLength(51);
    expect(lines[1]!.split(',').slice(1, 6)).toEqual(['b@example.com', 'Mobile', 'SSH', 'web-50', 'Closed']);
    expect(lines[1]!.split(',').at(-1)).toBe('90');
    expect(await screen.findByRole('status')).toHaveTextContent('x.csv 로 저장했습니다');
  });

  it('exports this device’s logs without person columns, as filtered', async () => {
    const audit: ActivityLogRecord = {
      id: 'audit-1',
      level: 'info',
      category: 'audit',
      message: '호스트를 지웠습니다.',
      metadata: null,
      createdAt: timeOf(299),
    };
    renderPanel({ logs: [sessionLog('mine', { connectedAt: timeOf(299) }), audit], teams: [] });
    fireEvent.change(screen.getByRole('combobox', { name: 'Category' }), { target: { value: 'session' } });

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(exportMocks.exportLogsCsv).toHaveBeenCalledTimes(1));

    expect(exportMocks.exportLogsCsv.mock.lastCall![0]).toMatchObject({
      rowCount: 1,
      vaultId: null,
      fileName: logsCsvFileName('personal', NOW),
    });
    const lines = exportedLines();
    expect(lines[0]).toBe('Time,Kind,Host,Status,Message,Started,Ended,Duration (s)');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('web-mine');
    expect(mocks.listTeamActivity).not.toHaveBeenCalled();
  });

  it('stops exporting without saving', async () => {
    renderPanel();
    await chooseTeam();
    let release: () => void = () => undefined;
    const original = mocks.listTeamActivity.getMockImplementation()!;
    mocks.listTeamActivity.mockImplementationOnce(
      (teamId: string, query?: TeamActivityQuery) =>
        new Promise((resolve) => {
          release = () => resolve(original(teamId, query));
        }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByRole('button', { name: /내보내는 중… 100줄/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '멈춤' }));
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeInTheDocument();
    await act(async () => {
      release();
    });

    expect(exportMocks.exportLogsCsv).not.toHaveBeenCalled();
    expect(bulkCalls()).toHaveLength(1);
  });

  it('says when nothing matches, and when saving fails', async () => {
    renderPanel({ logs: [sessionLog('mine', { connectedAt: timeOf(299) })], teams: [] });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nowhere' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('내보낼 기록이 없습니다');
    expect(exportMocks.exportLogsCsv).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    exportMocks.exportLogsCsv.mockRejectedValueOnce(new Error('disk full'));
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('내보내지 못했습니다 — disk full');

    // 저장 창을 닫으면 아무 말도 하지 않는다.
    exportMocks.exportLogsCsv.mockResolvedValueOnce({ canceled: true, savedPath: null });
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(exportMocks.exportLogsCsv).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.queryByRole('status')).toBeNull();
  });

  // 결함 ② — 다른 볼트로 가도 '저장했습니다'가 남아 그 볼트를 저장한 것처럼 읽혔다.
  it('shows the export note only while you look at what was exported', async () => {
    renderPanel({ logs: [sessionLog('mine', { connectedAt: timeOf(299) })] });
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByRole('status')).toHaveTextContent('x.csv 로 저장했습니다');

    fireEvent.change(screen.getByRole('combobox', { name: 'Category' }), { target: { value: 'audit' } });
    expect(screen.queryByRole('status')).toBeNull();
    // 같은 것을 다시 보면 그 알림이다.
    fireEvent.change(screen.getByRole('combobox', { name: 'Category' }), { target: { value: 'all' } });
    expect(screen.getByRole('status')).toHaveTextContent('x.csv 로 저장했습니다');

    fireEvent.change(screen.getByRole('combobox', { name: 'Vault' }), { target: { value: 'team-1' } });
    await screen.findByText('web-300');
    expect(screen.queryByText('x.csv 로 저장했습니다')).toBeNull();
  });

  it('keeps loading older pages while the filters hide everything that came so far', async () => {
    const observers: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          observers.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    renderPanel();
    await chooseTeam();
    await screen.findByRole('option', { name: 'b@example.com' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Person' }), { target: { value: 'b@example.com' } });

    // 받은 쪽에 b 의 줄이 없어도 '기록 없음'이 아니라 찾는 중이다.
    expect(screen.getByText('팀 기록을 불러오는 중입니다')).toBeInTheDocument();
    for (let page = 0; page < 2; page += 1) {
      const seen = observers.length;
      await act(async () => {
        observers.at(-1)?.([{ isIntersecting: true }]);
      });
      // 쪽을 받을 때마다 끝 자리를 다시 지킨다.
      await waitFor(() => expect(observers.length).toBeGreaterThan(seen));
    }
    expect(await screen.findByText('web-50')).toBeInTheDocument();
    expect(mocks.listTeamActivity).toHaveBeenCalledWith('team-1', { before: 101, limit: 100 });
  });

  it('has no Person or count line on the Changes tab', async () => {
    renderPanel();
    await chooseTeam();
    fireEvent.click(screen.getByRole('tab', { name: 'Changes' }));

    expect(screen.queryByRole('combobox', { name: 'Person' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull();
    expect(screen.queryByText(/^\d[\d,]*줄/)).toBeNull();
  });
});

describe('period and filter', () => {
  const row = (createdAt: string): Parameters<typeof matchesLogFilter>[0] => ({
    log: { ...sessionLog('p'), createdAt },
    author: null,
    mobile: false,
  });
  const base = { category: 'all' as const, level: 'all' as const, person: 'all', queries: [] };

  it('keeps rows inside a picked date range, both ends included', () => {
    const range = resolveLogsPeriod(
      { mode: 'absolute', absolute: { startDate: '2026-11-01', startTime: '09:00:00', endDate: '2026-11-01', endTime: '18:00:00' } },
      NOW,
    )!;
    const local = (hour: number, minute = 0) => new Date(2026, 10, 1, hour, minute).toISOString();
    expect(matchesLogFilter(row(local(9)), { ...base, range }, () => '')).toBe(true);
    expect(matchesLogFilter(row(local(18)), { ...base, range }, () => '')).toBe(true);
    expect(matchesLogFilter(row(local(8, 59)), { ...base, range }, () => '')).toBe(false);
    expect(matchesLogFilter(row(local(18, 1)), { ...base, range }, () => '')).toBe(false);
  });

  it('leaves a recent range open at the end, and has no range for all time', () => {
    const range = resolveLogsPeriod({ mode: 'recent', relative: { presetKey: '1d', amount: '1', unit: 'day' } }, NOW)!;
    expect(range).toEqual({ start: NOW.getTime() - 24 * HOUR, end: null });
    expect(matchesLogFilter(row(new Date(NOW.getTime() + HOUR).toISOString()), { ...base, range }, () => '')).toBe(true);
    expect(resolveLogsPeriod({ mode: 'all' }, NOW)).toBeNull();
  });
});

describe('buildLogsCsv', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 2, 1, minute)).toISOString();
  const record = (kind: ActivityLogRecord['kind'], metadata: object, extra: Partial<ActivityLogRecord> = {}) =>
    ({
      id: `${kind}-1`,
      level: 'info',
      category: 'session',
      kind,
      message: 'x',
      metadata: metadata as Record<string, unknown>,
      createdAt: at(0),
      ...extra,
    }) as ActivityLogRecord;
  const cells = (csv: string) => csv.slice(1).split('\r\n').filter(Boolean).slice(1).map((line) => line.split(','));

  it('puts each kind of row in the same columns as its card', () => {
    const sftp: SftpLifecycleLogMetadata = {
      endpointId: 'e', hostId: 'h', hostLabel: 'files', title: 'f', startedAt: at(1), endedAt: at(3), durationMs: 120_000,
      status: 'closed', endReason: null, uploadedCount: 0, downloadedCount: 0, remoteCopyCount: 0, uploadedBytes: 0,
      downloadedBytes: 0, remoteCopyBytes: 0, mkdirCount: 0, renameCount: 0, chmodCount: 0, chownCount: 0, deleteCount: 0,
      errorCount: 0, visitedPathCount: 0,
    };
    const forward: PortForwardLifecycleLogMetadata = {
      ruleId: 'r', ruleLabel: 'db tunnel', hostId: 'h', hostLabel: 'bastion', transport: 'ssh', mode: 'local',
      bindAddress: '127.0.0.1', bindPort: 15432, targetSummary: 'db:5432', startedAt: at(2), stoppedAt: null,
      durationMs: null, status: 'running',
    };
    const containers: ContainerLifecycleLogMetadata = {
      lifecycleId: 'l', hostId: 'h', hostLabel: 'docker-1', workspaceKind: 'host-runtime', transport: 'ssh',
      startedAt: at(3), endedAt: at(4), durationMs: 60_000, status: 'error', refreshCount: 1, errorCount: 1, lastError: 'daemon down',
    } as ContainerLifecycleLogMetadata;
    const action: ContainerActionLogMetadata = {
      actionId: 'a', hostId: 'h', hostLabel: 'docker-1', containerId: 'c1', containerName: 'api', action: 'restart',
      status: 'error', startedAt: at(4), completedAt: at(5), durationMs: 1_000, errorMessage: 'no such container',
    } as ContainerActionLogMetadata;
    const rows = [
      // 딱 떨어지지 않는 시간 — 카드처럼 남는 초는 버린다(35,845ms → 35초).
      record('session-lifecycle', { ...sessionLog('s').metadata, connectedAt: at(0), disconnectedAt: at(10), durationMs: 35_845 }),
      record('sftp-lifecycle', sftp),
      record('port-forward-lifecycle', forward),
      record('container-lifecycle', containers),
      record('container-action', action),
      { id: 'audit', level: 'warn', category: 'audit', message: '호스트 키가 바뀌었습니다.', metadata: null, createdAt: at(6) } as ActivityLogRecord,
    ].map((log) => ({ log, author: null, mobile: false }));

    const lines = cells(buildLogsCsv(rows, false, t));
    // Kind · Host · Status
    expect(lines.map((line) => line.slice(1, 4))).toEqual([
      ['SSH', 'web-s', 'Closed'],
      ['SFTP', 'files', expect.any(String)],
      [expect.stringContaining('Port forward'), 'bastion', expect.any(String)],
      [expect.stringContaining('Containers'), 'docker-1', expect.any(String)],
      ['Container action', 'docker-1', 'Error'],
      ['audit', '', 'WARN'],
    ]);
    // 기간(초): 접속 35(카드의 '35초'와 같다), SFTP 120, 아직 열린 포워딩은 비어 있다.
    expect(lines.map((line) => line.at(-1))).toEqual(['35', '120', '', '60', '1', '']);
    expect(lines[2]!.join(',')).toContain('127.0.0.1:15432 -> db:5432');
    expect(lines[3]!.join(',')).toContain('daemon down');
    expect(lines[4]!.join(',')).toContain('no such container');
    expect(lines[5]!.join(',')).toContain('호스트 키가 바뀌었습니다.');
  });

  it('leaves person and device empty on lines the server wrote', () => {
    const memberJoined = { id: 'team-event:1', level: 'info', category: 'audit', message: 'c 님이 팀에 들어왔습니다', metadata: null, createdAt: at(0) } as ActivityLogRecord;
    const lines = cells(
      buildLogsCsv(
        [
          { log: memberJoined, author: null, mobile: false },
          { log: sessionLog('m'), author: 'b@example.com', mobile: true },
          { log: sessionLog('d'), author: 'a@example.com', mobile: false },
        ],
        true,
        t,
      ),
    );
    expect(lines.map((line) => line.slice(1, 3))).toEqual([
      ['', ''],
      ['b@example.com', 'Mobile'],
      ['a@example.com', 'Desktop'],
    ]);
  });

  it('names the file after the vault and the day, without characters a file name cannot have', () => {
    expect(logsCsvFileName('Acme Infra', new Date(2026, 10, 2))).toBe('dolgate-logs-acme-infra-2026-11-02.csv');
    expect(logsCsvFileName('a/b:c*?', new Date(2026, 0, 9))).toBe('dolgate-logs-a-b-c-2026-01-09.csv');
    expect(logsCsvFileName('  ', new Date(2026, 0, 9))).toBe('dolgate-logs-logs-2026-01-09.csv');
  });
});

describe('LogsRangePickerDialog for container logs', () => {
  it('keeps its own hints and has no all-time button', () => {
    render(
      <LogsRangePickerDialog open mode="recent" absoluteValue={null} relativeValue={null} onClose={vi.fn()} onApply={vi.fn()} />,
    );
    const dialog = screen.getByRole('dialog', { name: '로그 범위 선택' });
    expect(dialog).toHaveTextContent(t('logRange.dialog.relativeHint'));
    // 발판에는 취소·적용만 — 기간을 거두는 단추가 없다.
    const footer = within(dialog).getByRole('button', { name: '취소' }).parentElement!;
    expect(within(footer).getAllByRole('button').map((button) => button.textContent)).toEqual(['취소', '적용']);
  });
});
