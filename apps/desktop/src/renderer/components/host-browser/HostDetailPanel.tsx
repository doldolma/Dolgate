import { useEffect, useMemo, useState } from 'react';
import {
  describeRdpDrives,
  resolveHostDrives,
  type RdpDriveShare,
  isAwsEc2HostRecord,
  isAwsEcsHostRecord,
  isRdpHostRecord,
  isVncHostRecord,
  isSshHostRecord,
  getGroupLabel,
  normalizeGroupPath,
} from '@shared';
import type {
  ActivityLogRecord,
  MyHostCredentialsSummary,
  HostEnvVar,
  HostRecord,
  HostStartupCommand,
  RdpHostRecord,
  SecretMetadataRecord,
  SnippetRecord,
  SshHostRecord,
  TeamActivityItem,
  TeamReplayStatus,
  VncHostRecord,
} from '@shared';
import { listTailnets, listTeamTailnets } from '../../services/desktop/tailnet';
import { useTeamsRecentActivity } from '../../controllers/useTeamsRecentActivity';
import { listAwsProfiles } from '../../services/desktop/imports';
import { cn } from '../../lib/cn';
import { collectRecentLogScopeHostIds, resolveRecentLogScope } from './recentLogScope';
import { Button, Tooltip } from '../../ui';
import {
  Columns2,
  Container,
  Download,
  Eye,
  EyeOff,
  Info,
  Folder,
  FolderPlus,
  Keyboard,
  KeyRound,
  List,
  Pencil,
  Play,
  Plus,
  SquareTerminal,
  Star,
  X,
} from '../../ui/icons';
import { ShortcutsDialog } from '../ShortcutsDialog';
import { SshKeyInstallDialog } from '../SshKeyInstallDialog';
import { loadSavedCredential } from '../../services/desktop/settings';
import { useAppStore } from '../../store/appStore';
import { terminalThemePresets } from '../../lib/terminal-presets';
import { getHostAddress, getHostRegion, getHostTypeLabel } from './hostDisplay';
import {
  hostSupportsContainers,
  hostSupportsSftp,
  hostSupportsTmux,
} from './hostCapabilities';
import type { HostBrowserModel, MyCredentialsApi } from './useHostBrowser';
import {
  MyCredentialsDialog,
  authTypeLabel,
  type MyCredentialsHost,
} from '../teams/MyCredentialsDialog';
import { useTranslation } from 'react-i18next';
import { getFormatLocale, t } from '../../i18n';
import { resolveLogMessage } from '../../lib/activity-log-message';
import { HostBadge } from './HostBadge';
import { VaultMark } from '../teams/VaultMark';
import type { AssetTeam } from './AssetLocation';
import { PerPersonHint } from '../teams/PerPersonHint';

interface HostDetailPanelProps {
  hb: HostBrowserModel;
  /** 단축키 안내에 실제 설정된 tmux 프리픽스를 보여주기 위해 전달받는다. */
  tmuxPrefixKey?: string;
}

type DetailTab = 'overview' | 'connection';

function formatRelativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }
  const diffMs = Date.now() - timestamp;
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) {
    return t('hostDetail.ago.justNow');
  }
  if (diffMin < 60) {
    return t('hostDetail.ago.minutes', { count: diffMin });
  }
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) {
    return t('hostDetail.ago.hours', { count: diffHour });
  }
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 7) {
    return t('hostDetail.ago.days', { count: diffDay });
  }
  /**
   * 7일이 넘어도 **상대 표기를 이어 간다.**
   *
   * 예전에는 여기서 절대 일시(`2026년 9월 7일 오후 05:17`)로 넘어갔는데, 그 한 줄이 오른쪽
   * 열을 150px 가까이 먹어 다른 것을 놓을 자리가 없었다. 이 카드가 답하는 질문은 "정확히
   * 언제"가 아니라 "얼마나 최근"이다 — 정확한 일시는 올리면 나오고(툴팁) 전체 로그에도 있다.
   */
  const diffWeek = Math.round(diffDay / 7);
  if (diffWeek < 5) {
    return t('hostDetail.ago.weeks', { count: diffWeek });
  }
  const diffMonth = Math.round(diffDay / 30);
  if (diffMonth < 12) {
    return t('hostDetail.ago.months', { count: diffMonth });
  }
  return t('hostDetail.ago.years', { count: Math.round(diffDay / 365) });
}

/** 툴팁에 넣을 정확한 일시. 목록이 상대 표기만 보여 주므로 이 값이 유일한 출처다. */
function formatExactTime(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }
  return new Date(timestamp).toLocaleString(getFormatLocale(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * 연결이 얼마나 이어졌는지. 분 아래는 초로, 한 시간이 넘으면 시간+분으로 적는다.
 *
 * 값이 없으면(아직 살아 있는 세션은 종료 때 계산된다) null 이라 화면이 그 줄을 그리지 않는다 —
 * 0 으로 적으면 "바로 끊겼다"는 거짓말이 된다.
 */
function formatSessionDuration(durationMs: number | null | undefined): string | null {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
    return null;
  }
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) {
    return t('hostDetail.duration.seconds', { count: totalSeconds });
  }
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) {
    return t('hostDetail.duration.minutes', { count: totalMinutes });
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0
    ? t('hostDetail.duration.hours', { count: hours })
    : t('hostDetail.duration.hoursMinutes', { hours, minutes });
}

function getLogHostId(log: ActivityLogRecord): string | null {
  const metadata = log.metadata as { hostId?: string } | null;
  return metadata?.hostId ?? null;
}

// 세션 lifecycle 로그에 리플레이 녹화가 있으면 recordingId를 돌려준다(없으면 null).
function getReplayRecordingId(log: ActivityLogRecord): string | null {
  if (log.kind !== 'session-lifecycle') {
    return null;
  }
  const metadata = log.metadata as {
    hasReplay?: boolean;
    recordingId?: string;
    status?: string;
  } | null;
  // 진행 중(connected) 세션은 녹화가 아직 finalize되지 않아(메타 파일 없음) 재생할 수 없다.
  // 종료된 세션(closed/error)만 Replay 버튼을 노출한다.
  const finished = metadata?.status === 'closed' || metadata?.status === 'error';
  return finished && metadata?.hasReplay === true && typeof metadata.recordingId === 'string'
    ? metadata.recordingId
    : null;
}

/** 상세의 활동 한 줄 — 이 기기의 기록이거나, 팀 호스트면 그 팀의 기록(서버)이다. */
interface HostActivityEntry {
  key: string;
  log: ActivityLogRecord;
  /** 팀 기록에서 온 줄을 남긴 멤버. 이 기기의 기록이면 null. */
  author: string | null;
  /** Replay 로 열 녹화. 팀 줄이면 teamId 가 있다(서버의 녹화). */
  replay: { recordingId: string; teamId: string | null } | null;
}

/** 팀 기록 줄의 Replay — 서버에 그 녹화의 구간이 있을 때만(기록 화면과 같은 규칙). 진행 중인 접속도 연다. */
function getTeamReplayRecordingId(
  log: ActivityLogRecord,
  statuses: ReadonlyMap<string, TeamReplayStatus>,
): string | null {
  if (log.kind !== 'session-lifecycle') {
    return null;
  }
  const metadata = log.metadata as { hasReplay?: boolean; recordingId?: string } | null;
  const recordingId = typeof metadata?.recordingId === 'string' ? metadata.recordingId : null;
  if (!recordingId || metadata?.hasReplay === false) {
    return null;
  }
  const status = statuses.get(recordingId);
  return status && status.state !== 'deleted' && status.segmentCount > 0 ? recordingId : null;
}

/**
 * 호스트 활동 목록(호스트 상세의 Recent Activity·홈의 최근 로그). 팀 기록(서버)도 넣는다 — 이 기기 기록만 보면 다른
 * 멤버가 붙은 것과 그 녹화가 보이지 않아, 다른 계정에서는 그 호스트에 아무 일도 없었던 것처럼 보였다. 내 접속은 이
 * 기기 기록과 같은 줄이라 이 기기 것만 남긴다(이 기기의 녹화를 연다). 같은 접속의 시작·끝은 가장 최근 것 하나다.
 */
export function buildActivityEntries(input: {
  localLogs: readonly ActivityLogRecord[];
  /** 넣을 호스트. 호스트를 가리키지 않는 기록은 넣지 않는다. */
  includeHost: (hostId: string) => boolean;
  teams: ReadonlyArray<{ teamId: string; items: readonly TeamActivityItem[] }>;
  replayStatuses: ReadonlyMap<string, TeamReplayStatus>;
}): HostActivityEntry[] {
  const includes = (log: ActivityLogRecord) => {
    const hostId = getLogHostId(log);
    return hostId !== null && input.includeHost(hostId);
  };
  const local = input.localLogs.filter(includes);
  const entries: HostActivityEntry[] = local.slice(0, 40).map((log) => {
    const recordingId = getReplayRecordingId(log);
    return { key: log.id, log, author: null, replay: recordingId ? { recordingId, teamId: null } : null };
  });
  if (input.teams.length === 0) {
    return entries;
  }
  const localIds = new Set(local.map((log) => log.id));
  const seen = new Set<string>();
  for (const { teamId, items } of input.teams) {
    for (const item of items) {
      const record = item.activity?.record;
      if (!record || !includes(record) || localIds.has(record.id)) {
        continue;
      }
      const key = `${item.authorUserId}:${record.id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const recordingId = getTeamReplayRecordingId(record, input.replayStatuses);
      entries.push({
        key,
        log: record,
        author: item.authorEmail,
        replay: recordingId ? { recordingId, teamId } : null,
      });
    }
  }
  return entries.sort((left, right) => right.log.createdAt.localeCompare(left.log.createdAt)).slice(0, 40);
}

/** 로그 레벨 → 상태 점 색(토큰). info/성공은 녹색, warn 앰버, error 적색. */
function getLogStatusColor(level?: string): string {
  if (level === 'error') {
    return 'var(--danger-text)';
  }
  if (level === 'warn') {
    return 'var(--warning-text)';
  }
  return 'var(--success-text)';
}

/** connectionKind(세션 연결 타입) → 표시 라벨. */
function getConnectionKindLabel(kind?: string, tmux = false, awsTransport?: string): string {
  const suffix = tmux ? ' (tmux)' : '';
  switch (kind) {
    case 'local':
      return 'Local';
    case 'ssh':
      return `SSH${suffix}`;
    case 'mosh':
      return 'Mosh';
    case 'aws-ssm':
      return `${awsTransport === 'ssh-over-ssm' ? 'SSH over SSM' : awsTransport === 'ssm-shell' ? 'SSM Shell' : 'AWS SSM'}${suffix}`;
    case 'aws-ecs-exec':
      return 'AWS ECS Exec';
    case 'warpgate':
      return 'Warpgate';
    case 'serial':
      return 'Serial';
    case 'rdp':
      return 'RDP';
    default:
      return kind ?? '';
  }
}

function StatusDot({ level }: { level?: string }) {
  return (
    <span
      aria-hidden="true"
      className="h-[0.5rem] w-[0.5rem] shrink-0 rounded-full"
      style={{ background: getLogStatusColor(level) }}
    />
  );
}

/** 홈 "최근 로그"와 호스트 상세 활동 로그가 공유하는 한 줄 행(상태점 + 제목/부제 + 상대시간). */
function ActivityRow({
  primary,
  secondary,
  level,
  when,
  duration,
  onClick,
  replayRecordingId,
  onOpenReplay,
  team = null,
}: {
  primary: string;
  /** 볼트가 섞인 목록에서 이 호스트가 든 팀 — 이름 뒤에 팀 표시(팀 이름은 툴팁). */
  team?: AssetTeam | null;
  secondary?: string | null;
  level?: string;
  when: string;
  /** 연결이 이어진 시간. 아직 살아 있거나 옛 기록이면 null 이라 그 줄을 그리지 않는다. */
  duration?: string | null;
  onClick?: () => void;
  replayRecordingId?: string | null;
  onOpenReplay?: (recordingId: string) => void;
}) {
  const textContent = (
    <span className="flex min-w-0 items-center gap-[0.55rem]">
      <StatusDot level={level} />
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-[0.35rem]">
          <span className="min-w-0 truncate text-[0.82rem] font-medium text-[var(--text)]">
            {primary}
          </span>
          {team ? (
            <>
              <Tooltip label={team.name} className="shrink-0">
                <VaultMark kind="team" size="xs" />
              </Tooltip>
              <span className="sr-only">{team.name}</span>
            </>
          ) : null}
        </span>
        {secondary ? (
          <span className="min-w-0 truncate text-[0.72rem] text-[var(--text-soft)]">
            {secondary}
          </span>
        ) : null}
      </span>
    </span>
  );
  // [텍스트(클릭) … Replay? … 시간] — 시간을 항상 맨 오른쪽에 둬 행마다 시간 열이 정렬되게 한다.
  return (
    <div className="flex items-center gap-[0.55rem] pr-[0.55rem]">
      {onClick ? (
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center rounded-[10px] px-[0.55rem] py-[0.55rem] text-left transition-colors duration-140 hover:bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)]"
          onClick={onClick}
        >
          {textContent}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center px-[0.55rem] py-[0.55rem]">
          {textContent}
        </div>
      )}
      {replayRecordingId && onOpenReplay ? (
        <button
          type="button"
          aria-label={t('hostDetail.replay')}
          className="inline-flex shrink-0 items-center gap-[0.3rem] rounded-[8px] border border-[var(--border)] px-[0.5rem] py-[0.3rem] text-[0.72rem] font-semibold text-[var(--text-soft)] transition-colors duration-140 hover:border-[color-mix(in_srgb,var(--accent-strong)_30%,var(--border)_70%)] hover:text-[var(--accent-strong)]"
          onClick={() => onOpenReplay(replayRecordingId)}
        >
          <Play className="h-[0.8rem] w-[0.8rem]" aria-hidden />
          Replay
        </button>
      ) : null}
      {/**
       * 오른쪽 열은 [얼마나 이어졌나 / 언제였나] 두 줄이다.
       *
       * 목록이 답하는 질문이 "얼마나 최근"이라 위쪽을 유지시간에 내준다. 정확한 일시는
       * 화면에 없으므로(상대 표기만 그린다) 아래 줄에 툴팁으로 단다 — 오래된 줄만이 아니라
       * **모든 줄**에 단다. 어떤 줄은 나오고 어떤 줄은 안 나오면 그게 더 헷갈린다.
       */}
      <span className="flex shrink-0 flex-col items-end leading-[1.35]">
        {duration ? (
          <span className="text-[0.76rem] tabular-nums text-[var(--text-soft)]">
            {duration}
          </span>
        ) : null}
        <Tooltip label={formatExactTime(when)}>
          <span
            className={
              duration
                ? 'text-[0.68rem] text-[var(--text-muted)]'
                : 'text-[0.76rem] text-[var(--text-soft)]'
            }
          >
            {formatRelativeTime(when)}
          </span>
        </Tooltip>
      </span>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-[0.55rem]">
      <span className="shrink-0 text-[0.82rem] text-[var(--text-soft)]">{label}</span>
      <span className="select-text min-w-0 break-words text-right text-[0.82rem] font-medium text-[var(--text)]">
        {value}
      </span>
    </div>
  );
}

/** 시작 명령 표시: 직접 명령은 그대로, 스니펫이면 스니펫 라벨로 해석한다. */
function describeStartupCommand(
  command: HostStartupCommand,
  snippets: SnippetRecord[] | undefined,
): React.ReactNode {
  if (command.type === 'command') {
    return (
      <code className="select-text font-mono text-[0.78rem] leading-relaxed text-[var(--text)]">
        {command.command}
      </code>
    );
  }
  const label = snippets?.find((snippet) => snippet.id === command.snippetId)?.label;
  return label ? t('hostDetail.startup.snippetWithLabel', { label }) : t('hostDetail.startup.snippet');
}

function describeSerialTransport(transport: string): string {
  if (transport === 'local') {
    return t('hostDetail.serial.local');
  }
  if (transport === 'raw-tcp') {
    return 'Raw TCP';
  }
  if (transport === 'rfc2217') {
    return 'RFC2217';
  }
  return transport;
}

/**
 * 호스트가 어떤 자격증명(저장된 시크릿)을 쓰는지 표시. 공유 중이면 호스트 수도 함께 알린다.
 *
 * SSH·RDP 가 같이 쓴다 — 둘 다 자격증명을 secretRef 로만 가리킨다.
 */
function buildCredentialValue(
  host: { secretRef?: string | null },
  keychainEntries: SecretMetadataRecord[],
): React.ReactNode {
  if (!host.secretRef) {
    return t('hostDetail.credential.none');
  }
  const entry = keychainEntries.find((item) => item.secretRef === host.secretRef);
  const label = entry?.label ?? t('hostDetail.credential.saved');
  const sharedCount = entry?.linkedHostCount ?? 0;
  if (sharedCount > 1) {
    return (
      <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
        <span>{label}</span>
        <span className="text-[0.78rem] text-[var(--text-muted)]">
          {t('hostDetail.credential.sharedCount', { count: sharedCount })}
        </span>
      </span>
    );
  }
  return label;
}

/**
 * 다단 ProxyJump 체인을 순서대로(첫 홉=클라이언트에서 직접 연결 … 마지막 홉=타깃 바로 앞) 반환.
 * footgun 회피: shared-core의 신규 value export(normalizeJumpHostIds)를 렌더러에서 직접 import하면
 * vite dev의 export* 처리로 심볼이 드롭돼 앱이 블랭크가 될 수 있어 동일 로직을 인라인한다.
 */
function deriveJumpHostIds(host: SshHostRecord): string[] {
  const source =
    Array.isArray(host.jumpHostIds) && host.jumpHostIds.length > 0
      ? host.jumpHostIds
      : host.jumpHostId
        ? [host.jumpHostId]
        : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of source) {
    if (typeof id === 'string' && id.length > 0 && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

/**
 * tailnet 을 경유하는 호스트라는 것은 주소만 봐서는 알 수 없다 — 같은 이름이 tailnet 안과 밖에서
 * 다른 기기일 수 있으므로 어디를 거치는지 보여 준다. 설정이 지워졌으면 라벨을 못 찾는데, 그때는
 * 경고를 보여 준다(연결도 그 상태에서는 거부된다).
 */
/**
 * 경유 계층(tailnet·점프 호스트·SSH 터널·SSM)의 행들.
 *
 * **새 라벨을 만들지 않는다** — 각 종류가 원래 쓰던 이름과 값을 그대로 모아 준다(Tailnet,
 * Jump Host, SSH 터널, SSM 경유). 이것들을 한 줄로 합치거나 다른 말로 부르면 두 탭이 같은 값을
 * 다르게 말하게 된다.
 *
 * Overview 와 Connection 이 같이 쓴다. 주소만 보면 직접 붙는 것처럼 보이는 종류가 많아서
 * (VNC 의 `127.0.0.1`, RDP-over-SSM 의 사설 IP) Overview 에도 있어야 하고, 그렇다고 문구가
 * 갈리면 안 되므로 자리는 하나다. 순서도 종류별로 원래 있던 그대로다.
 */
function buildTransportRows(
  host: HostRecord,
  hosts: HostRecord[],
  tailnets: Array<{ id: string; label: string }>,
  tailnetsLoaded: boolean,
  awsProfiles: Array<{ id: string | null; name: string }>,
): Array<{ label: string; value: React.ReactNode }> {
  const rows: Array<{ label: string; value: React.ReactNode }> = [];
  const pushTailnet = (tailnetId: string | null | undefined) => {
    const row = buildTailnetRow(tailnetId, tailnets, tailnetsLoaded);
    if (row) {
      rows.push(row);
    }
  };

  if (isSshHostRecord(host)) {
    const jumpHostIds = deriveJumpHostIds(host);
    if (jumpHostIds.length > 0) {
      rows.push({
        label: jumpHostIds.length > 1 ? 'Jump Hosts' : 'Jump Host',
        value: (
          <span className="inline-flex flex-wrap items-center justify-end gap-x-1 gap-y-1">
            {jumpHostIds.map((jumpId, index) => {
              // 지워진 홉은 id 를 노출하지 않는다 — 사용자에게 아무 뜻도 없는 문자열이고, 그
              // 상태로는 접속이 실패한다. VNC 터널 행과 같은 문구를 쓴다(같은 상황, 같은 말).
              const jumpLabel =
                hosts.find((entry) => entry.id === jumpId)?.label ??
                t('hostDetail.row.deletedSshHost');
              return (
                <span key={jumpId} className="inline-flex items-center gap-x-1">
                  {index > 0 ? (
                    <span aria-hidden="true" className="text-[var(--text-muted)]">
                      →
                    </span>
                  ) : null}
                  <span className="rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[0.78rem] font-medium text-[var(--text)]">
                    {jumpLabel}
                  </span>
                </span>
              );
            })}
          </span>
        ),
      });
    }
    pushTailnet(host.tailnetId);
    return rows;
  }

  if (isRdpHostRecord(host)) {
    pushTailnet(host.tailnetId);
    // SSM 을 거치는지는 주소만 봐서는 알 수 없다. 사설 IP 가 그대로 적혀 있어서 직접 붙는 것처럼
    // 보이는데, 실제로는 포트 포워딩을 거친다 — 안 보여주면 왜 사설 IP 로 붙는지 설명이 안 된다.
    if (host.awsSsm) {
      // id 로 현재 이름을 찾는다. 못 찾으면(관리하지 않는 프로파일이거나 id 가 없는 옛 레코드)
      // 저장된 이름을 쓴다 — 접속 경로도 같은 순서로 판단한다.
      const profileName =
        awsProfiles.find(
          (profile) => host.awsSsm?.profileId && profile.id === host.awsSsm.profileId,
        )?.name ?? host.awsSsm.profileName;
      rows.push({
        label: t('hostDetail.row.awsSsm'),
        value: `${host.awsSsm.instanceId} · ${host.awsSsm.region} · ${profileName}`,
      });
    }
    return rows;
  }

  if (isVncHostRecord(host)) {
    const tunnelHostId = host.sshTunnelHostId?.trim();
    if (tunnelHostId) {
      // 지워진 호스트를 가리킬 수 있다. 그때는 id 대신 그 사실을 말한다 — 접속도 실패하므로
      // 여기서 알아채는 것이 가장 이르다.
      const tunnelHost = hosts.find((entry) => entry.id === tunnelHostId);
      rows.push({
        label: t('hostDetail.row.sshTunnel'),
        value: tunnelHost ? tunnelHost.label : t('hostDetail.row.deletedSshHost'),
      });
    }
    pushTailnet(host.tailnetId);
    return rows;
  }

  return rows;
}

function buildTailnetRow(
  tailnetId: string | null | undefined,
  tailnets: Array<{ id: string; label: string }>,
  /**
   * 목록이 도착했는지. **비어 있는 것과 아직 안 온 것을 구분해야 한다.**
   *
   * 목록은 비동기로 온다. 오기 전에 "설정 없음 — 연결되지 않습니다" 를 붉게 적으면 화면을 열
   * 때마다 그 경고가 한 번 스친다 — 정상 상태를 이상 상태로 보여주는 셈이다.
   */
  tailnetsLoaded: boolean,
): { label: string; value: React.ReactNode } | null {
  const id = tailnetId?.trim();
  if (!id || !tailnetsLoaded) {
    return null;
  }
  const known = tailnets.find((entry) => entry.id === id);
  return {
    label: 'Tailnet',
    value: known ? (
      known.label
    ) : (
      <span className="text-[var(--danger)]">{t('hostDetail.row.tailnetMissing')}</span>
    ),
  };
}

/**
 * RDP 는 계정이 자격증명에 딸린다 — SSH 처럼 호스트 레코드에 username 이 없다. 어느 계정으로
 * 붙는지가 이 패널에서 가장 먼저 확인할 값이라 자격증명 라벨과 따로 한 줄을 준다.
 */
function buildRdpAccount(
  host: RdpHostRecord,
  keychainEntries: SecretMetadataRecord[],
): string | null {
  if (!host.secretRef) {
    return null;
  }
  const entry = keychainEntries.find((item) => item.secretRef === host.secretRef);
  const username = entry?.username?.trim();
  if (!username) {
    return null;
  }
  const domain = entry?.domain?.trim();
  return domain ? `${domain}\\${username}` : username;
}

/** 기본값이 "켬"인 토글(오디오·클립보드)은 껐을 때도 한 줄로 보여야 한다 — 안 보이면 켠 줄 안다. */
function describeToggle(enabled: boolean): string {
  return enabled ? t('hostDetail.row.enabled') : t('hostDetail.row.disabled');
}

/**
 * VNC 호스트의 상세 행.
 *
 * 경유 계층(SSH 터널·tailnet)은 `buildTransportRows` 가 만든다 — Overview 도 같은 행을 쓴다.
 *
 * 문구는 편집 화면(hostForm.vnc)의 것을 그대로 쓴다. 같은 값을 두 화면이 다르게 부르면 안 된다.
 */
function buildVncRows(
  host: VncHostRecord,
  hosts: HostRecord[],
  keychainEntries: SecretMetadataRecord[],
  tailnets: Array<{ id: string; label: string }>,
  tailnetsLoaded: boolean,
): Array<{ label: string; value: React.ReactNode }> {
  const rows: Array<{ label: string; value: React.ReactNode }> = [];

  rows.push({ label: 'Port', value: host.port });
  rows.push({ label: 'Credential', value: buildCredentialValue(host, keychainEntries) });
  rows.push(...buildTransportRows(host, hosts, tailnets, tailnetsLoaded, []));

  // 없거나 null 이면 무손실이다(레코드 기본값과 같은 규칙).
  const QUALITY_KEYS = {
    lossless: 'hostDetail.vncQuality.lossless',
    balanced: 'hostDetail.vncQuality.balanced',
    fast: 'hostDetail.vncQuality.fast',
  } as const;
  rows.push({
    label: t('hostDetail.row.imageQuality'),
    value: t(QUALITY_KEYS[host.imageQuality ?? 'lossless'] ?? QUALITY_KEYS.lossless),
  });
  // 기본이 켜짐인 것은 늘 적고(RDP 의 소리·클립보드와 같은 규칙), 기본이 꺼짐인 것은 켜졌을
  // 때만 적는다(관리 세션과 같은 규칙).
  rows.push({
    label: t('hostDetail.row.screenSharing'),
    value: describeToggle(host.shared !== false),
  });
  if (host.viewOnly === true) {
    rows.push({
      label: t('hostDetail.row.viewOnly'),
      value: t('hostDetail.row.enabled'),
    });
  }

  return rows;
}

function buildRdpRows(
  host: RdpHostRecord,
  keychainEntries: SecretMetadataRecord[],
  tailnets: Array<{ id: string; label: string }>,
  tailnetsLoaded: boolean,
  awsProfiles: Array<{ id: string | null; name: string }>,
  /** 이 기기에 저장된 공유 폴더. 드라이브는 기기 로컬이라 레코드에서 읽으면 안 된다. */
  localDrives: RdpDriveShare[],
): Array<{ label: string; value: React.ReactNode }> {
  const rows: Array<{ label: string; value: React.ReactNode }> = [];
  const account = buildRdpAccount(host, keychainEntries);

  rows.push({ label: 'Port', value: host.port });
  if (account) {
    rows.push({ label: 'Account', value: account });
  }
  rows.push({ label: 'Credential', value: buildCredentialValue(host, keychainEntries) });

  rows.push(...buildTransportRows(host, [], tailnets, tailnetsLoaded, awsProfiles));

  if (host.adminSession === true) {
    rows.push({
      label: t('hostDetail.row.adminSession'),
      value: t('hostDetail.row.enabled'),
    });
  }
  // 없거나 null 이면 32 비트다(레코드 기본값과 같은 규칙).
  rows.push({
    label: t('hostDetail.row.colorQuality'),
    value: host.colorDepth === 16 ? '16-bit' : '32-bit',
  });
  if (host.useAllMonitors === true) {
    rows.push({
      label: t('hostDetail.row.allMonitors'),
      value: t('hostDetail.row.enabled'),
    });
  }
  rows.push({
    label: t('hostDetail.row.remoteAudio'),
    value: describeToggle(host.audioEnabled !== false),
  });
  // 마이크는 기본이 꺼짐이라 켰을 때만 적는다(관리 세션과 같은 규칙). 원격에 소리가 넘어가는
  // 설정이라, 켜져 있다는 사실이 이 표에서 보여야 한다.
  if (host.microphoneEnabled === true) {
    rows.push({
      label: t('hostDetail.row.microphone'),
      value: t('hostDetail.row.enabled'),
    });
  }
  // 카메라도 같은 규칙이다 — 켜져 있으면 영상이 원격으로 넘어간다는 사실이 보여야 한다.
  if (host.cameraEnabled === true) {
    rows.push({
      label: t('hostDetail.row.camera'),
      value: t('hostDetail.row.enabled'),
    });
  }
  rows.push({
    label: t('hostDetail.row.clipboard'),
    value: describeToggle(host.clipboardEnabled !== false),
  });

  // 이름은 원격에 그대로 뜨는 값이다 — 편집 화면과 같은 규칙(describeRdpDrives)으로 만든다.
  // 공유한 폴더는 원격에 그 안의 파일이 다 노출되므로, 무엇을 열어 뒀는지 여기서 보여야 한다.
  const drives = describeRdpDrives(localDrives);
  if (drives.length > 0) {
    rows.push({
      label: t('hostDetail.row.redirectedFolders'),
      value: (
        <span className="inline-flex flex-col items-end gap-y-1">
          {drives.map((drive) => (
            <span key={drive.path} className="inline-flex items-baseline gap-x-1.5">
              <span className="truncate" title={drive.path}>
                {drive.name}
              </span>
              {drive.readOnly ? (
                <span className="text-[0.72rem] text-[var(--text-muted)]">
                  {t('hostDetail.row.driveReadOnly')}
                </span>
              ) : null}
            </span>
          ))}
        </span>
      ),
    });
  }

  // 신뢰한 인증서 지문(host.certificateFingerprint)은 일부러 넣지 않는다 — 설정한 값이 아니고,
  // 달라지면 접속할 때 인증서 확인 화면이 지문을 나란히 보여준다.

  return rows;
}

/**
 * Connection 탭 행 구성: 공통(Type/Address) + kind별 상세 + 시작 명령/터미널 테마를 한 배열로.
 * Address(host:port·IP 등)·Region과 중복되는 필드는 생략한다.
 */
function buildConnectionRows(
  host: HostRecord,
  hosts: HostRecord[],
  snippets: SnippetRecord[] | undefined,
  keychainEntries: SecretMetadataRecord[],
  tailnets: Array<{ id: string; label: string }>,
  tailnetsLoaded: boolean,
  awsProfiles: Array<{ id: string | null; name: string }>,
  /** 이 기기에 저장된 호스트별 공유 폴더. 드라이브는 동기화되지 않는다. */
  drivesByHostId: Readonly<Record<string, RdpDriveShare[]>> | undefined,
): Array<{ label: string; value: React.ReactNode }> {
  const rows: Array<{ label: string; value: React.ReactNode }> = [];
  const address = getHostAddress(host);
  const region = getHostRegion(host);

  rows.push({ label: 'Type', value: getHostTypeLabel(host) });
  if (address) {
    rows.push({ label: 'Address', value: address });
  }

  if (isSshHostRecord(host)) {
    rows.push({ label: 'Username', value: host.username || t('hostDetail.row.usernameUnset') });
    rows.push({ label: 'Port', value: host.port });
    rows.push({
      label: 'Auth',
      value: host.authType === 'agent' ? 'SSH Agent' : host.authType,
    });
    rows.push({ label: 'Credential', value: buildCredentialValue(host, keychainEntries) });
    rows.push(...buildTransportRows(host, hosts, tailnets, tailnetsLoaded, awsProfiles));
    if (host.useMosh) {
      rows.push({ label: 'Mosh', value: t('hostDetail.row.enabled') });
    }
    if (host.agentForwarding) {
      rows.push({ label: 'Agent Forwarding', value: t('hostDetail.row.enabled') });
    }
  } else if (isRdpHostRecord(host)) {
    rows.push(
      ...buildRdpRows(
        host,
        keychainEntries,
        tailnets,
        tailnetsLoaded,
        awsProfiles,
        resolveHostDrives(host.id, drivesByHostId, host.drives),
      ),
    );
  } else if (isVncHostRecord(host)) {
    rows.push(...buildVncRows(host, hosts, keychainEntries, tailnets, tailnetsLoaded));
  } else if (host.kind === 'aws-ec2') {
    rows.push({ label: 'Profile', value: host.awsProfileName || 'Not configured' });
    rows.push({ label: 'Instance', value: host.awsInstanceId });
    if (host.awsInstanceName) {
      rows.push({ label: 'Instance Name', value: host.awsInstanceName });
    }
    if (host.awsAvailabilityZone) {
      rows.push({ label: 'Availability Zone', value: host.awsAvailabilityZone });
    }
    if (host.awsState) {
      rows.push({ label: 'State', value: host.awsState });
    }
    if (host.awsSshUsername) {
      rows.push({ label: 'SSH User', value: host.awsSshUsername });
    }
    if (host.awsSshPort) {
      rows.push({ label: 'SSH Port', value: host.awsSshPort });
    }
    if (host.awsSsmServerProxyEnabled) {
      rows.push({ label: t('hostDetail.row.serverProxy'), value: t('hostDetail.row.enabled') });
    }
  } else if (host.kind === 'aws-ecs') {
    rows.push({ label: 'Profile', value: host.awsProfileName || 'Not configured' });
    rows.push({ label: 'Cluster', value: host.awsEcsClusterName });
  } else if (host.kind === 'warpgate-ssh') {
    rows.push({ label: 'Base URL', value: host.warpgateBaseUrl });
    rows.push({ label: 'Target', value: host.warpgateTargetName });
    rows.push({ label: 'Username', value: host.warpgateUsername });
  } else if (host.kind === 'serial') {
    rows.push({ label: 'Transport', value: describeSerialTransport(host.transport) });
    rows.push({ label: 'Baud Rate', value: host.baudRate });
    rows.push({ label: 'Data Bits', value: host.dataBits });
    rows.push({ label: 'Parity', value: host.parity });
    rows.push({ label: 'Stop Bits', value: host.stopBits });
    rows.push({ label: 'Flow Control', value: host.flowControl });
  }

  if (region) {
    rows.push({ label: 'Region', value: region });
  }

  if ('startupCommand' in host && host.startupCommand) {
    rows.push({
      label: t('hostDetail.row.startupCommand'),
      value: describeStartupCommand(host.startupCommand, snippets),
    });
  }

  const themeTitle = host.terminalThemeId
    ? terminalThemePresets.find((preset) => preset.id === host.terminalThemeId)?.title
    : undefined;
  if (themeTitle) {
    rows.push({ label: t('hostDetail.row.terminalTheme'), value: themeTitle });
  }

  return rows;
}

/**
 * 환경 변수는 호스트 레코드(host.env)에 저장된다. 자격증명은 여러 호스트가 공유하므로 거기에
 * 두면 한 호스트의 값이 다른 호스트로 번졌다 — 그래서 호스트로 옮겼고 자격증명 쪽 필드는 없앴다.
 * 값에는 토큰/비밀번호가 들어갈 수 있어 기본 마스킹하고, 눈 아이콘으로 펼친다.
 */
function EnvVarsSection({ host }: { host: SshHostRecord }) {
  const { t: translate } = useTranslation();
  const envVars = host.env ?? [];
  const [revealed, setRevealed] = useState(false);

  if (envVars.length === 0) {
    return null;
  }

  return (
    <div className="mt-[0.7rem] border-t border-[var(--border)] pt-[0.7rem]">
      <div className="mb-[0.4rem] flex items-center justify-between gap-3">
        <span className="text-[0.82rem] text-[var(--text-soft)]">
          {translate('hostDetail.env.heading', { count: envVars.length })}
        </span>
        <button
          type="button"
          aria-label={translate(revealed ? 'hostDetail.env.hide' : 'hostDetail.env.show')}
          aria-pressed={revealed}
          className="flex h-[1.5rem] w-[1.5rem] items-center justify-center rounded-[8px] text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--surface-muted)] hover:text-[var(--text)]"
          onClick={() => setRevealed((current) => !current)}
        >
          {revealed ? (
            <EyeOff className="h-[0.95rem] w-[0.95rem]" />
          ) : (
            <Eye className="h-[0.95rem] w-[0.95rem]" />
          )}
        </button>
      </div>
      <div className="grid gap-[0.4rem]">
        {envVars.map((entry) => (
          <div key={entry.key} className="flex items-start justify-between gap-3">
            <code className="select-text shrink-0 break-all font-mono text-[0.78rem] text-[var(--text)]">
              {entry.key}
            </code>
            <code className="select-text min-w-0 break-all text-right font-mono text-[0.78rem] text-[var(--text-soft)]">
              {revealed ? entry.value : '••••••••'}
            </code>
          </div>
        ))}
      </div>
    </div>
  );
}

function SectionCard({
  title,
  action,
  children,
}: {
  title: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-elevated)] px-[0.9rem] py-[0.7rem]">
      <div className="mb-[0.4rem] flex items-center justify-between gap-3">
        <h3 className="text-[0.9rem] font-bold text-[var(--text)]">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

/**
 * 팀 호스트의 내 자격 증명(후보 C1·C1e) — Host Information 과 같은 카드·줄. 값은 안 보이고 무엇이 들어 있는지만.
 * 비어 있으면 팀 것으로 접속한다는 한 줄과 Add.
 */
function MyCredentialsCard({ host, api }: { host: MyCredentialsHost; api: MyCredentialsApi }) {
  const { t: translate } = useTranslation();
  // undefined = 읽는 중. 못 읽으면 비어 있는 것으로 본다(편집으로 다시 둘 수 있다).
  const [summary, setSummary] = useState<MyHostCredentialsSummary | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setSummary(undefined);
    void Promise.resolve()
      .then(() => api.load(host.id))
      .then(
        (next) => {
          if (!cancelled) {
            setSummary(next);
          }
        },
        () => {
          if (!cancelled) {
            setSummary(null);
          }
        },
      );
    return () => {
      cancelled = true;
    };
  }, [api, host.id]);

  const stored = summary
    ? (
        [
          ['password', summary.hasPassword],
          ['privateKey', summary.hasPrivateKey],
          ['certificate', summary.hasCertificate],
          ['passphrase', summary.hasPassphrase],
        ] as const
      )
        .filter(([, has]) => has)
        .map(([key]) => translate(`teams.myCredentials.stored.${key}`))
    : [];

  return (
    <>
      <SectionCard
        title={
          <span className="inline-flex items-center gap-[0.3rem]">
            My credentials
            <Tooltip label={translate('teams.myCredentials.cardHint')} multiline>
              <Info className="h-4 w-4 text-[var(--text-soft)]" aria-hidden />
            </Tooltip>
          </span>
        }
        action={
          summary === undefined ? null : (
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              {summary ? (
                <Pencil className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <Plus className="h-3.5 w-3.5" aria-hidden />
              )}
              {summary ? 'Edit' : 'Add'}
            </Button>
          )
        }
      >
        {summary === undefined ? null : summary ? (
          <div data-my-credentials>
            {summary.username ? <InfoRow label="Username" value={summary.username} /> : null}
            {summary.authType ? (
              <InfoRow label="Auth" value={authTypeLabel(summary.authType, translate)} />
            ) : null}
            {summary.domain ? <InfoRow label="Domain" value={summary.domain} /> : null}
            {stored.length > 0 ? <InfoRow label="Stored" value={stored.join(' · ')} /> : null}
          </div>
        ) : (
          <p className="m-0 py-[0.35rem] text-[0.82rem] text-[var(--text-soft)]">
            {translate('teams.myCredentials.empty')}
          </p>
        )}
      </SectionCard>
      {editing ? (
        <MyCredentialsDialog
          host={host}
          summary={summary ?? null}
          onSave={async (input) => {
            setSummary(await api.save(host.id, input));
          }}
          onClear={async () => {
            await api.clear(host.id);
            setSummary(null);
          }}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </>
  );
}

/** 빈 상태(호스트 미선택) 히어로 일러스트 — 겹쳐 쌓인 호스트 카드. 테마 액센트 색을 따른다. */
function HostStackArt({ className }: { className?: string }) {
  const cardFill = 'color-mix(in srgb, var(--accent-strong) 7%, var(--surface-elevated))';
  const cardStroke = 'color-mix(in srgb, var(--accent-strong) 38%, transparent)';
  const line = (opacity: number) =>
    `color-mix(in srgb, var(--accent-strong) ${opacity}%, transparent)`;
  return (
    <svg
      viewBox="0 0 160 120"
      fill="none"
      aria-hidden="true"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* soft ground shadow */}
      <ellipse cx="80" cy="106" rx="44" ry="6.5" fill={line(12)} />
      {/* back-left card */}
      <g transform="rotate(-9 64 58)">
        <rect
          x="30"
          y="34"
          width="68"
          height="50"
          rx="9"
          fill={cardFill}
          stroke={cardStroke}
          strokeWidth="2"
        />
      </g>
      {/* back-right card */}
      <g transform="rotate(9 96 56)">
        <rect
          x="62"
          y="32"
          width="68"
          height="50"
          rx="9"
          fill={cardFill}
          stroke={cardStroke}
          strokeWidth="2"
        />
      </g>
      {/* front card */}
      <rect
        x="46"
        y="46"
        width="68"
        height="52"
        rx="10"
        fill="var(--surface-elevated)"
        stroke="color-mix(in srgb, var(--accent-strong) 62%, transparent)"
        strokeWidth="2"
      />
      {/* front card content */}
      <rect x="55" y="55" width="14" height="14" rx="4" fill={line(24)} />
      <rect x="74" y="57" width="31" height="4" rx="2" fill={line(32)} />
      <rect x="74" y="65" width="22" height="4" rx="2" fill={line(20)} />
      <rect x="55" y="79" width="50" height="4" rx="2" fill={line(15)} />
      <rect x="55" y="87" width="34" height="4" rx="2" fill={line(13)} />
    </svg>
  );
}

function EmptyDetail({
  hb,
  tmuxPrefixKey,
}: {
  hb: HostBrowserModel;
  tmuxPrefixKey?: string;
}) {
  const { t: translate } = useTranslation();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // 시간순 최근 로그. 예전에는 hostId 로 중복을 걸러 "호스트당 한 줄"만 보여 줬는데,
  // 그러면 같은 호스트의 리플레이가 있는 세션 로그가 그보다 최근의 다른 로그(전송·감사)에
  // 가려 사라졌고, 활동이 있는 호스트가 6개를 넘으면 아예 목록에서 빠졌다. 섹션 이름과
  // "View all"(로그 화면)이 가리키는 대로 로그 목록으로 맞춘다.
  // 즐겨찾기나 그룹 맥락이 있으면 최근 로그도 그 범위로 좁힌다(규칙은 recentLogScope 주석 참고).
  const scope = useMemo(
    () =>
      resolveRecentLogScope({
        favoritesFilterActive: hb.favoritesFilterActive,
        selectedGroupPaths: hb.selectedGroupPaths,
        currentGroupPath: hb.currentGroupPath,
      }),
    [hb.currentGroupPath, hb.favoritesFilterActive, hb.selectedGroupPaths],
  );

  // 볼트 안이면 그 볼트의 호스트로만 좁힌다 — 같은 경로가 다른 볼트에 있어도 섞이지 않고, 볼트 맨 위면 그 볼트 전부다.
  const scopedHostIdSet = useMemo(() => {
    const scopeHosts = hb.locationHosts ?? hb.hosts;
    const ids = collectRecentLogScopeHostIds(scopeHosts, scope);
    if (ids || !hb.currentVault) {
      return ids;
    }
    return new Set(scopeHosts.map((host) => host.id));
  }, [hb.currentVault, hb.hosts, hb.locationHosts, scope]);

  // 범위 안 팀 호스트의 팀 기록(서버) — 다른 멤버의 접속과 녹화. 볼트 안이면 그 볼트가 팀일 때만, 전체·즐겨찾기면 내 팀
  // 전부. 다시 들어와야 하는 팀은 열 수 없어 묻지 않는다.
  const scopeTeamIds = useMemo(() => {
    const vaults = hb.currentVault ? [hb.currentVault] : (hb.vaultTrees ?? []).map((tree) => tree.vault);
    return vaults.flatMap((vault) =>
      vault?.kind === 'team' && vault.blocked !== 'needs-rejoin' ? [vault.id] : [],
    );
  }, [hb.currentVault, hb.vaultTrees]);
  const teamActivity = useTeamsRecentActivity(scopeTeamIds);

  const recentLogs = useMemo(
    () =>
      buildActivityEntries({
        localLogs: hb.activityLogs ?? [],
        includeHost: (hostId) => !scopedHostIdSet || scopedHostIdSet.has(hostId),
        teams: teamActivity.teams,
        replayStatuses: teamActivity.replayStatuses,
      })
        .slice(0, 6)
        .map(({ key, log, author, replay }) => {
          const hostId = getLogHostId(log) ?? '';
          const metadata = log.metadata as {
            hostLabel?: string;
            label?: string;
            title?: string;
            connectionKind?: string;
            awsTransport?: string;
            tmux?: boolean;
            durationMs?: number | null;
            commandCount?: number | null;
          } | null;
          // 이름: 현재 호스트 목록 우선(최신 라벨), 없으면 로그 메타데이터(세션=hostLabel,
          // 감사 로그=label, 그 외=title) 순. UUID(hostId) 노출은 최후 수단.
          const name =
            hb.hosts.find((entry) => entry.id === hostId)?.label ??
            metadata?.hostLabel ??
            metadata?.label ??
            metadata?.title ??
            hostId;
          // 부제: 세션 로그는 연결 타입(SSH/AWS SSM 등), 그 외는 로그 메시지(무슨 일인지).
          const detail = metadata?.connectionKind
            ? getConnectionKindLabel(metadata.connectionKind, metadata.tmux, metadata.awsTransport)
            : resolveLogMessage(log, translate);
          /**
           * 명령 수는 **셸 통합이 붙은 세션에만** 있다. 없는 세션에 "명령 0개" 를 적으면 아무것도
           * 안 한 것처럼 보이는데, 사실은 세지 못한 것이다 — 값이 없으면 그 조각을 뺀다.
           */
          const commandCount = metadata?.commandCount;
          const detailWithCount =
            typeof commandCount === 'number' && Number.isFinite(commandCount)
              ? `${detail} · ${translate('hostDetail.commandCount', { count: commandCount })}`
              : detail;
          return {
            id: key,
            hostId,
            name,
            // 팀 기록 줄은 누가 남겼는지를 뒤에 붙인다.
            detail: author ? `${detailWithCount} · ${author}` : detailWithCount,
            when: log.createdAt,
            duration: formatSessionDuration(metadata?.durationMs),
            level: log.level,
            replay,
          };
        }),
    [hb.activityLogs, hb.hosts, scopedHostIdSet, teamActivity, translate],
  );

  // 섹션 제목에 범위를 적는다. 목록이 짧아진 이유를 화면에서 알 수 있어야 한다.
  const scopeLabel = useMemo(() => {
    if (scope.kind === 'favorites') {
      // 사이드바에서 누른 그 이름을 그대로 쓴다.
      return translate('sidebar.favorites');
    }
    if (scope.kind !== 'groups') {
      // 볼트 맨 위면 그 볼트로 좁혀져 있다(scopedHostIdSet) — 범위 이름도 그 볼트다.
      return hb.currentVault?.name ?? null;
    }
    if (scope.groupPaths.length === 1) {
      return getGroupLabel(scope.groupPaths[0]);
    }
    return translate('hostDetail.empty.recentLogsGroupCount', {
      count: scope.groupPaths.length,
    });
  }, [hb.currentVault, scope, translate]);

  return (
    <div className="flex h-full flex-col divide-y divide-[var(--border)] overflow-y-auto px-[0.9rem] pb-[1.3rem]">
      <div className="flex flex-col items-center gap-[0.7rem] pb-[2rem] pt-[3.2rem] text-center">
        <HostStackArt className="mb-[0.55rem] w-[8.5rem]" />
        <strong className="text-[1rem] text-[var(--text)]">{translate('hostDetail.empty.title')}</strong>
        <p className="max-w-[16rem] text-[0.82rem] leading-[1.5] text-[var(--text-soft)]">
          {translate('hostDetail.empty.description')}
        </p>
      </div>

      <div className="flex flex-col gap-[0.55rem] py-[1.3rem]">
        <span className="text-[0.76rem] font-bold uppercase tracking-[0.1em] text-[var(--text-soft)]">
          {translate('hostDetail.empty.quickStart')}
        </span>
        {/* 2열이다. 이 패널은 340~400px 고정폭이라(HostBrowser 의 grid 트랙) 3열이면
            버튼 하나에 글자 폭이 340px 기준 50px 밖에 안 남는다 — "Local terminal" 같은
            영문 라벨이 두 줄로 접히면서 그 행만 키가 커진다. 2열이면 가장 좁을 때도
            104px 라 한 줄로 들어간다(한국어보다 긴 언어가 와도 여유). */}
        <div className="grid grid-cols-2 gap-[0.55rem]">
          <Button variant="secondary" size="sm" onClick={hb.onCreateHost}>
            <Plus className="h-[0.95rem] w-[0.95rem]" />
            {translate('hostDetail.empty.newHost')}
          </Button>
          <Button variant="secondary" size="sm" onClick={hb.onOpenOpenSshImport}>
            <Download className="h-[0.95rem] w-[0.95rem]" />
            {translate('hostDetail.empty.import')}
          </Button>
          <Button variant="secondary" size="sm" onClick={hb.onOpenLocalTerminal}>
            <SquareTerminal className="h-[0.95rem] w-[0.95rem]" />
            {translate('hostDetail.empty.localTerminal')}
          </Button>
          <Button variant="secondary" size="sm" onClick={hb.openCreateGroupModal}>
            <FolderPlus className="h-[0.95rem] w-[0.95rem]" />
            {translate('hostDetail.empty.newGroup')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setShortcutsOpen(true)}>
            <Keyboard className="h-[0.95rem] w-[0.95rem]" />
            {translate('hostDetail.empty.shortcuts')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => hb.onSelectSection?.('logs')}>
            <List className="h-[0.95rem] w-[0.95rem]" />
            {translate('hostDetail.empty.logs')}
          </Button>
        </div>
      </div>

      {/* 그룹이 잡혀 있으면 비어 있어도 섹션을 남긴다 — 사라지면 "로그가 없다" 와 "여기엔 없다" 를
          구분할 수 없다. 범위가 없을 때(전체)는 예전처럼 로그가 없으면 섹션째 감춘다. */}
      {recentLogs.length > 0 || scopedHostIdSet ? (
        <div className="flex flex-col gap-[0.55rem] pt-[1.3rem]" data-testid="recent-logs">
          <div className="flex items-center justify-between">
            <span className="text-[0.76rem] font-bold uppercase tracking-[0.1em] text-[var(--text-soft)]">
              {scopeLabel
                ? `${translate('hostDetail.empty.recentLogs')} · ${scopeLabel}`
                : translate('hostDetail.empty.recentLogs')}
            </span>
            <button
              type="button"
              className="text-[0.76rem] font-semibold text-[var(--accent-strong)] transition-colors duration-140 hover:underline"
              onClick={() => hb.onSelectSection?.('logs')}
            >
              View all
            </button>
          </div>
          <div className="flex flex-col">
            {recentLogs.length === 0 ? (
              <p className="py-[0.4rem] text-[0.8rem] text-[var(--text-soft)]">
                {scope.kind === 'favorites'
                  ? translate('hostDetail.empty.recentLogsFavoritesEmpty')
                  : translate('hostDetail.empty.recentLogsGroupEmpty')}
              </p>
            ) : null}
            {recentLogs.map((item) => (
              <ActivityRow
                key={item.id}
                primary={item.name}
                team={
                  hb.showsTeamMarks ? hb.teamOfAsset(`host:${item.hostId}`) : null
                }
                secondary={item.detail}
                level={item.level}
                when={item.when}
                duration={item.duration}
                onClick={() => hb.selectSingleHost(item.hostId)}
                replayRecordingId={item.replay?.recordingId ?? null}
                onOpenReplay={
                  hb.onOpenReplay && item.replay
                    ? (recordingId) => {
                        const teamId = item.replay?.teamId;
                        void (teamId ? hb.onOpenReplay?.(recordingId, teamId) : hb.onOpenReplay?.(recordingId));
                      }
                    : undefined
                }
              />
            ))}
          </div>
        </div>
      ) : null}
      <ShortcutsDialog
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        tmuxPrefixKey={tmuxPrefixKey}
      />
    </div>
  );
}

export function HostDetailPanel({ hb, tmuxPrefixKey }: HostDetailPanelProps) {
  // 공유 폴더는 기기 로컬 설정이다 — 어느 폴더가 원격에 열려 있는지는 이 기기 기준으로 말해야
  // 한다. 레코드 값을 그대로 보여주면 연결이 실제로 붙이는 것과 갈린다.
  const localDrivesByHostId = useAppStore(
    (state) => state.settings?.rdpDrivesByHostId,
  );
  const { t: translate } = useTranslation();
  const { selectedHostId, hosts, favoriteHostIdSet } = hb;
  const host = useMemo(
    () => hosts.find((entry) => entry.id === selectedHostId) ?? null,
    [hosts, selectedHostId],
  );
  // 탭(Overview/Connection) 선택은 상위(HomeShell)에 보관해, 호스트를 바꾸거나 다른 섹션에
  // 갔다 돌아와도(HostBrowser 재마운트) 유지된다.
  const activeTab: DetailTab = hb.detailTab ?? 'overview';
  const [keyInstallOpen, setKeyInstallOpen] = useState(false);

  // tailnet 라벨을 보여주려면 등록 목록이 필요하다. 호스트가 바뀔 때 다시 읽는다 — 이 패널은
  // 섹션을 옮겨도 재마운트되지 않아서, 한 번만 읽으면 설정에서 방금 추가한 tailnet 이 계속
  // "설정 없음"으로 보인다.
  const [tailnets, setTailnets] = useState<Array<{ id: string; label: string }>>([]);
  /**
   * 목록이 도착했는지. **비어 있는 것과 아직 안 온 것을 구분해야 한다.**
   *
   * 목록은 비동기로 오는데, 오기 전에 "이 tailnet 을 모른다" 고 적으면 화면을 열 때마다 그 문구가
   * 한 번 스친다 — 정상 상태를 이상 상태로 보여주는 셈이다.
   */
  const [tailnetsLoaded, setTailnetsLoaded] = useState(false);
  // 팀 볼트로 공유한 호스트는 tailnet 도 그 팀 볼트에 있다(복사본). 개인 목록에서 찾으면 "설정 없음" 이 된다.
  const hostTeamId = useAppStore((state) =>
    selectedHostId ? (state.vaultIndex?.teamIdByHostId?.[selectedHostId] ?? null) : null,
  );
  useEffect(() => {
    let cancelled = false;
    // 브리지가 없으면 listTailnets 가 동기적으로 던진다 — Promise 로 감싸야 .catch 가 잡는다.
    void Promise.resolve()
      .then(() => (hostTeamId ? listTeamTailnets(hostTeamId) : listTailnets()))
      .then((records) => {
        if (!cancelled) {
          setTailnets(records.map((record) => ({ id: record.id, label: record.label })));
          setTailnetsLoaded(true);
        }
      })
      .catch(() => {
        // 목록을 못 읽어도 상세 화면은 그대로 보여야 한다.
        if (!cancelled) {
          setTailnetsLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedHostId, hostTeamId]);

  // AWS 프로파일 이름은 설정에서 바뀔 수 있다. 레코드에 적힌 이름을 그대로 보여주면 이름을 바꾼
  // 뒤에도 옛 이름이 남아, 실제 접속(id 로 현재 이름을 찾는다)과 화면이 서로 다른 말을 한다.
  const [awsProfiles, setAwsProfiles] = useState<Array<{ id: string | null; name: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve()
      .then(listAwsProfiles)
      .then((records) => {
        if (!cancelled) {
          setAwsProfiles(records.map((record) => ({ id: record.id, name: record.name })));
        }
      })
      .catch(() => {
        // 목록을 못 읽어도 상세 화면은 그대로 보여야 한다. 저장된 이름으로 떨어진다.
      });
    return () => {
      cancelled = true;
    };
  }, [selectedHostId]);

  // 팀 호스트면 그 팀의 기록(서버)도 받는다 — 다른 멤버의 접속과 녹화. 개인 호스트면 아무것도 하지 않는다.
  const hostTeamIds = useMemo(() => (hostTeamId ? [hostTeamId] : []), [hostTeamId]);
  const teamActivity = useTeamsRecentActivity(hostTeamIds);
  const hostActivity = useMemo(
    () =>
      host
        ? buildActivityEntries({
            localLogs: hb.activityLogs ?? [],
            includeHost: (hostId) => hostId === host.id,
            teams: teamActivity.teams,
            replayStatuses: teamActivity.replayStatuses,
          })
        : [],
    [hb.activityLogs, host, teamActivity],
  );

  if (!host) {
    return <EmptyDetail hb={hb} tmuxPrefixKey={tmuxPrefixKey} />;
  }

  const isFavorite = favoriteHostIdSet.has(host.id);
  const region = getHostRegion(host);
  const address = getHostAddress(host);
  // 경유 계층 행들. Overview·Connection 이 **같은 행**을 쓴다(라벨·값·순서가 갈리지 않게).
  const transportRows = buildTransportRows(host, hb.hosts, tailnets, tailnetsLoaded, awsProfiles);
  const group = normalizeGroupPath(host.groupName);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 px-[0.9rem] pb-[0.55rem] pt-[0.9rem]">
        <div className="flex min-w-0 items-center gap-[0.55rem]">
          {/* 상세는 조금 크게. 마크가 없으면 예전 액센트 뱃지로 돌아간다. */}
          <HostBadge
            host={host}
            className="h-[2rem] w-[2rem] rounded-[10px]"
          />
          <h2 className="min-w-0 truncate text-[1rem] font-bold text-[var(--text)]">
            {host.label}
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-[0.25rem]">
          <PerPersonHint
            hint={
              hb.hasVaults && hb.teamOfAsset(`host:${host.id}`)
                ? translate('teams.perPerson.favorite')
                : null
            }
          >
          <button
            type="button"
            aria-label={translate('hostDetail.favorite', { label: host.label })}
            aria-pressed={isFavorite}
            className={cn(
              'inline-grid h-[1.9rem] w-[1.9rem] place-items-center rounded-[10px] transition-colors duration-140 hover:bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)]',
              isFavorite ? 'text-[#e0a23a]' : 'text-[var(--text-muted)]',
            )}
            onClick={() => hb.toggleFavorite(host.id)}
          >
            <Star className="h-[1.05rem] w-[1.05rem]" fill={isFavorite ? 'currentColor' : 'none'} />
          </button>
          </PerPersonHint>
          <button
            type="button"
            aria-label={translate('hostDetail.close')}
            className="inline-grid h-[1.9rem] w-[1.9rem] place-items-center rounded-[10px] text-[var(--text-muted)] transition-colors duration-140 hover:bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] hover:text-[var(--text)]"
            onClick={() => hb.clearSelections()}
          >
            <X className="h-[1.05rem] w-[1.05rem]" />
          </button>
        </div>
      </div>

      {/* Tabs (underline style) */}
      <div className="flex items-center gap-[1.1rem] border-b border-[var(--border)] px-[0.9rem]">
        {(['overview', 'connection'] as const).map((tab) => {
          const label = tab === 'overview' ? 'Overview' : 'Connection';
          const active = activeTab === tab;
          return (
            <button
              key={tab}
              type="button"
              onClick={() => hb.onDetailTabChange?.(tab)}
              className={cn(
                '-mb-px border-b-2 px-[0.25rem] pb-[0.55rem] pt-[0.4rem] text-[0.82rem] font-semibold transition-colors duration-140',
                active
                  ? 'border-[var(--accent-strong)] text-[var(--accent-strong)]'
                  : 'border-transparent text-[var(--text-soft)] hover:text-[var(--text)]',
              )}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div className="flex min-h-0 flex-1 flex-col gap-[0.7rem] overflow-y-auto px-[0.9rem] py-[0.9rem]">
        {activeTab === 'overview' ? (
          <>
            <SectionCard
              title="Host Information"
              action={
                <Button size="sm" variant="secondary" onClick={() => hb.onEditHost(host.id)}>
                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                  Edit
                </Button>
              }
            >
              <div>
                <InfoRow label="Name" value={host.label} />
                <InfoRow label="Type" value={getHostTypeLabel(host)} />
                {isAwsEc2HostRecord(host) || isAwsEcsHostRecord(host) ? (
                  <InfoRow
                    label="Profile"
                    value={host.awsProfileName || 'Not configured'}
                  />
                ) : null}
                {address ? <InfoRow label="IP / Host" value={address} /> : null}
                {/* 주소 바로 아래에 둔다 — 이 줄들이 그 주소에 어떻게 닿는지 설명한다.
                    Connection 탭에 있는 것과 **같은 행**이다(같은 라벨·같은 값). */}
                {transportRows.map((row) => (
                  <InfoRow key={row.label} label={row.label} value={row.value} />
                ))}
                {region ? <InfoRow label="Region" value={region} /> : null}
                <InfoRow label="Group" value={group ?? 'Ungrouped'} />
                {host.tags && host.tags.length > 0 ? (
                  <InfoRow
                    label="Tags"
                    value={
                      <span className="flex flex-wrap justify-end gap-[0.25rem]">
                        {host.tags.map((tag) => (
                          <span
                            key={tag}
                            className="inline-flex items-center rounded-full border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] px-[0.4rem] py-[0.25rem] text-[0.7rem] text-[var(--text-soft)]"
                          >
                            {tag}
                          </span>
                        ))}
                      </span>
                    }
                  />
                ) : null}
              </div>
            </SectionCard>

            {/* 팀 호스트(비밀값으로 붙는 SSH·RDP·VNC)에만 — 나에게만 적용되는 자격 증명. */}
            {hb.myCredentials &&
            hb.hasVaults &&
            hb.teamOfAsset(`host:${host.id}`) &&
            (isSshHostRecord(host) || isRdpHostRecord(host) || isVncHostRecord(host)) ? (
              <MyCredentialsCard key={host.id} host={host} api={hb.myCredentials} />
            ) : null}

            <SectionCard title="Quick Actions">
              <div className="grid grid-cols-2 gap-[0.55rem]">
                <Button variant="primary" size="sm" onClick={() => hb.onConnectHost(host.id)}>
                  <SquareTerminal className="h-4 w-4" aria-hidden />
                  Connect
                </Button>
                <Button variant="secondary" size="sm" onClick={() => hb.onEditHost(host.id)}>
                  <Pencil className="h-4 w-4" aria-hidden />
                  Edit Host
                </Button>
                {hostSupportsSftp(host) && hb.onOpenSftp ? (
                  <Button variant="secondary" size="sm" onClick={() => hb.onOpenSftp?.(host.id)}>
                    <Folder className="h-4 w-4" aria-hidden />
                    Open SFTP
                  </Button>
                ) : null}
                {hostSupportsTmux(host) && hb.onConnectHostTmux ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => hb.onConnectHostTmux?.(host.id)}
                  >
                    <Columns2 className="h-4 w-4" aria-hidden />
                    TMUX Connect
                  </Button>
                ) : null}
                {hostSupportsContainers(host) ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => hb.onOpenHostContainers(host.id)}
                  >
                    <Container className="h-4 w-4" aria-hidden />
                    Containers
                  </Button>
                ) : null}
                {(isSshHostRecord(host) || isAwsEc2HostRecord(host)) &&
                hb.onGenerateAndInstallSshKey &&
                hb.onInstallSshPublicKey ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setKeyInstallOpen(true)}
                  >
                    <KeyRound className="h-4 w-4" aria-hidden />
                    Upload public key
                  </Button>
                ) : null}
              </div>
            </SectionCard>

            {hostActivity.length > 0 ? (
              <SectionCard title="Recent Activity">
                <ActivityList entries={hostActivity.slice(0, 6)} onOpenReplay={hb.onOpenReplay} />
              </SectionCard>
            ) : null}
          </>
        ) : null}

        {activeTab === 'connection' ? (
          <SectionCard title="Connection">
            <div className="divide-y divide-[var(--border)]">
              {buildConnectionRows(
                host,
                hosts,
                hb.snippets,
                hb.keychainEntries,
                tailnets,
                tailnetsLoaded,
                awsProfiles,
                localDrivesByHostId,
              ).map((row) => (
                <InfoRow key={row.label} label={row.label} value={row.value} />
              ))}
            </div>
            {isSshHostRecord(host) ? (
              <EnvVarsSection key={host.id} host={host} />
            ) : null}
          </SectionCard>
        ) : null}

      </div>
      {keyInstallOpen &&
      (isSshHostRecord(host) || isAwsEc2HostRecord(host)) &&
      hb.onGenerateAndInstallSshKey &&
      hb.onInstallSshPublicKey ? (
        <SshKeyInstallDialog
          host={host}
          keychainEntries={hb.keychainEntries}
          onGenerateAndInstallSshKey={hb.onGenerateAndInstallSshKey}
          onInstallSshPublicKey={hb.onInstallSshPublicKey}
          onClose={() => setKeyInstallOpen(false)}
        />
      ) : null}
    </div>
  );
}

function ActivityList({
  entries,
  onOpenReplay,
}: {
  entries: HostActivityEntry[];
  onOpenReplay?: (recordingId: string, teamId?: string | null) => void;
}) {
  const { t: translate } = useTranslation();
  return (
    <div className="flex flex-col">
      {entries.map(({ key, log, author, replay }) => {
        const metadata = log.metadata as {
          connectionKind?: string;
          awsTransport?: string;
          status?: string;
          disconnectReason?: string;
          tmux?: boolean;
          durationMs?: number | null;
          commandCount?: number | null;
        } | null;
        const isSession =
          log.kind === 'session-lifecycle' && Boolean(metadata?.connectionKind);
        const isError = isSession && metadata?.status === 'error';
        // 세션 로그: 정상 연결은 타입만(예: SSH), 실패만 "SSH · 연결 실패"로 구분.
        // (정상적으로 닫힌 세션을 "종료"로 표기하면 모든 기록이 종료로 보여 혼란스러움.)
        const primary = isSession
          ? isError
            ? translate('hostDetail.activity.connectFailed', {
                kind: getConnectionKindLabel(metadata?.connectionKind, metadata?.tmux, metadata?.awsTransport),
              })
            : getConnectionKindLabel(metadata?.connectionKind, metadata?.tmux, metadata?.awsTransport)
          : resolveLogMessage(log, translate);
        // 실패 사유만 부제로 노출(정상 종료의 기술적 사유는 노이즈라 숨김). 팀 기록 줄은 누가 남겼는지를 앞에 둔다.
        const reason = isError ? metadata?.disconnectReason ?? null : null;
        const secondary = [author, reason].filter(Boolean).join(' · ') || null;
        // 최근 로그 카드와 같은 규칙: 센 값이 있을 때만 붙인다(없음 ≠ 0회).
        const commandCount = metadata?.commandCount;
        const primaryWithCount =
          typeof commandCount === 'number' && Number.isFinite(commandCount)
            ? `${primary} · ${translate('hostDetail.commandCount', { count: commandCount })}`
            : primary;
        return (
          <ActivityRow
            key={key}
            primary={primaryWithCount}
            secondary={secondary}
            level={log.level}
            when={log.createdAt}
            duration={isSession ? formatSessionDuration(metadata?.durationMs) : null}
            replayRecordingId={replay?.recordingId ?? null}
            onOpenReplay={
              onOpenReplay && replay
                ? (recordingId) =>
                    replay.teamId ? onOpenReplay(recordingId, replay.teamId) : onOpenReplay(recordingId)
                : undefined
            }
          />
        );
      })}
    </div>
  );
}
