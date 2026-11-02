import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ActivityLogCategory,
  ActivityLogLevel,
  ActivityLogRecord,
  TeamActivityItem,
  TeamMemberChange,
  TeamReplayStatus,
  TeamRole,
  ContainerActionLogMetadata,
  ContainerLifecycleLogMetadata,
  PortForwardLifecycleLogMetadata,
  SessionConnectionKind,
  SessionLifecycleLogMetadata,
  SftpLifecycleLogMetadata,
  PortForwardTransport,
  TeamMember,
} from '@shared';
import { canManageTeam } from '@shared';
import {
  Badge,
  Button,
  Card,
  CardMain,
  EmptyState,
  InfoHint,
  InfoHintPoints,
  Input,
  PanelSection,
  SelectField,
  TabButton,
  Tabs,
  Toolbar,
  Tooltip,
} from '../ui';
import { Calendar, Download, Play } from '../ui/icons';
import { useTranslation } from 'react-i18next';
import { getFormatLocale, t } from '../i18n';
import { resolveLogMessage } from '../lib/activity-log-message';
import { getKeyboardLayoutSearchQueries } from '../lib/keyboard-layout-search';
import { buildCsv, formatCsvTime, type CsvValue } from '../lib/csv';
import { formatLogsRangeLabel, normalizeLogsAbsoluteRange, normalizeLogsRelativeRange } from '../lib/log-range';
import { exportLogsCsv } from '../services/desktop/logs';
import type { LogsAbsoluteRangeValue, LogsRelativeRangeValue } from '../store/types';
import { LogsRangePickerDialog } from './LogsRangePickerDialog';
import { reachedSince, useTeamActivity } from '../controllers/useTeamActivity';
import { memberLeavesOf, withMemberLeftEnd } from './teams/team-member-left';
import { AuthorLine } from './teams/AuthorLine';
import { TeamChangesList } from './teams/TeamChangesList';
import { TEAM_ROLE_LABELS } from './teams/team-format';

type Translate = (key: string, params?: Record<string, unknown>) => string;

interface LogsPanelProps {
  logs: ActivityLogRecord[];
  onClear: () => Promise<void>;
  /** teamId 를 주면 그 팀의 녹화(서버)를 연다. */
  onOpenReplay: (recordingId: string, teamId?: string | null) => Promise<void>;
  /** 이 기기의 팀. 있으면 Vault 를 골라 팀 기록(서버)을 본다. 관리자 이상이면 바뀐 것(Changes)도 본다. */
  teams?: ReadonlyArray<{ id: string; name: string; role?: TeamRole }>;
  /** 팀 멤버 — Person 에 기록을 아직 안 남긴 멤버도 보이게. 없으면 받은 기록의 사람만. */
  onListMembers?: (teamId: string) => Promise<TeamMember[]>;
}

const PERSONAL_VAULT = 'personal';
/** Person 의 '모두'. */
const ALL = 'all';

/** 기간 — 전체(기본), 최근 얼마, 날짜로 고른 범위. 컨테이너 로그의 기간 고르기를 그대로 쓴다. */
type LogsPeriod =
  | { mode: 'all' }
  | { mode: 'recent'; relative: LogsRelativeRangeValue }
  | { mode: 'absolute'; absolute: LogsAbsoluteRangeValue };

/** 처음 기간을 고를 때 — 기록은 최근 1주부터 본다. */
const DEFAULT_RECENT_PERIOD: LogsRelativeRangeValue = { presetKey: '1w', amount: '1', unit: 'week' };

interface PeriodRange {
  start: number;
  /** 최근 얼마는 끝이 열려 있다 — 새로 받는 줄도 그 안이다. */
  end: number | null;
}

/** 고른 기간의 시작·끝(밀리초). 전체면 null. */
export function resolveLogsPeriod(period: LogsPeriod, now: Date): PeriodRange | null {
  if (period.mode === 'recent') {
    const range = normalizeLogsRelativeRange(period.relative, now);
    return range ? { start: Date.parse(range.startTime), end: null } : null;
  }
  if (period.mode === 'absolute') {
    const range = normalizeLogsAbsoluteRange(period.absolute);
    return range ? { start: Date.parse(range.startTime), end: Date.parse(range.endTime) } : null;
  }
  return null;
}

/** 거르기 전의 줄. 팀 기록은 남긴 사람·폰에서 남겼는지가 붙는다. */
export interface LogRow {
  log: ActivityLogRecord;
  author: string | null;
  mobile: boolean;
}

interface LogFilter {
  category: 'all' | ActivityLogCategory;
  level: 'all' | ActivityLogLevel;
  person: string;
  range: PeriodRange | null;
  queries: readonly string[];
}

/** 거르기 — 화면 목록과 내보내기가 같은 것을 쓴다. 찾기 글은 필요할 때만 만든다(searchText). */
export function matchesLogFilter(row: LogRow, filter: LogFilter, searchText: () => string): boolean {
  if (filter.category !== 'all' && row.log.category !== filter.category) {
    return false;
  }
  if (filter.level !== 'all' && row.log.level !== filter.level) {
    return false;
  }
  if (filter.person !== ALL && row.author !== filter.person) {
    return false;
  }
  if (filter.range) {
    const time = Date.parse(row.log.createdAt);
    if (!(time >= filter.range.start) || (filter.range.end !== null && time > filter.range.end)) {
      return false;
    }
  }
  if (filter.queries.length > 0) {
    const haystack = searchText();
    if (!filter.queries.some((query) => haystack.includes(query))) {
      return false;
    }
  }
  return true;
}

/** 저장 창에 넣을 이름 — dolgate-logs-<볼트>-<날짜>.csv. 파일 이름에 못 쓰는 글자는 뺀다. */
export function logsCsvFileName(vaultName: string, now: Date): string {
  const slug =
    vaultName
      .trim()
      .toLocaleLowerCase()
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'logs';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `dolgate-logs-${slug}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.csv`;
}

/** 팀 기록 한 줄을 화면의 기록 카드로 — 앱 활동은 로컬 기록과 같은 모양이고, 그 밖의 것은 문구 카드다. */
interface TeamLogRow {
  log: ActivityLogRecord;
  /** 그 줄을 남긴 멤버. 멤버 변화(서버가 남김)는 없다. */
  author: string | null;
  /** 폰이 남긴 줄(녹화 없음) — 작성자 뒤에 'Mobile'. */
  mobile: boolean;
  seq: number;
}

function describeMemberChange(change: TeamMemberChange, translate: Translate): string {
  const email = change.email ?? change.userId;
  const by = change.byEmail ?? change.byUserId ?? '';
  // 역할 이름은 칩과 같은 영어 라벨. 모르는 값은 그대로 보인다.
  const role = change.role ? (TEAM_ROLE_LABELS[change.role as TeamRole] ?? change.role) : null;
  if (change.type === 'member_joined') {
    // Member 로 들어온 것은 지금처럼 — 다른 역할(읽기 전용 링크)만 역할을 붙인다.
    return role && change.role !== 'member'
      ? translate('teamLogs.memberJoinedAs', { email, role })
      : translate('teamLogs.memberJoined', { email });
  }
  if (change.type === 'role_changed' && role) {
    return translate('teamLogs.roleChanged', { email, by, role });
  }
  if (change.type === 'member_left') {
    if (change.reason === 'vault_reset') {
      return translate('teamLogs.memberLeftVaultReset', { email });
    }
    if (change.reason === 'account_deleted') {
      return translate('teamLogs.memberLeftAccountDeleted', { email });
    }
    return translate('teamLogs.memberLeft', { email });
  }
  if (change.type === 'member_removed') {
    return translate('teamLogs.memberRemoved', { email, by });
  }
  if (change.type === 'owner_changed') {
    return change.reason === 'successor'
      ? translate('teamLogs.ownerSucceeded', { email })
      : translate('teamLogs.ownerChanged', { email, by });
  }
  return translate('teamLogs.membersChanged');
}

/**
 * 서버의 팀 기록(최신부터)을 화면 줄로 만든다. 수명 줄(접속·SFTP 등)의 시작과 끝은 같은 기록이라 한 줄로
 * 합친다 — 나중 것이 앞의 것을 대신한다. 줄은 그 기록의 시각(수명 줄은 시작 시각)으로 최신부터 놓는다. 시작만 있는
 * 줄은 남긴 사람이 그 뒤에 팀에서 빠졌으면 그때 끝난 것으로 보인다(withMemberLeftEnd).
 */
function buildTeamRows(items: readonly TeamActivityItem[], translate: Translate): TeamLogRow[] {
  const rows: TeamLogRow[] = [];
  const seen = new Set<string>();
  const leaves = memberLeavesOf(items);
  const leftReason = translate('teamLogs.memberLeftEnd');
  for (const item of items) {
    if (item.activity) {
      const record = item.activity.record;
      const id = `${item.authorUserId}:${record.id}`;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      rows.push({
        log: { ...withMemberLeftEnd(record, item, leaves, leftReason), id },
        author: item.authorEmail,
        mobile: item.activity.client === 'mobile',
        seq: item.seq,
      });
      continue;
    }
    const message = item.memberChange
      ? describeMemberChange(item.memberChange, translate)
      : item.unreadable === 'unsupported-version'
        ? translate('teamReplay.unsupported')
        : translate('teamLogs.unreadable');
    rows.push({
      log: {
        id: `team-event:${item.seq}`,
        level: 'info',
        category: 'audit',
        message,
        metadata: null,
        createdAt: item.createdAt,
      } as ActivityLogRecord,
      author: item.memberChange ? null : item.authorEmail,
      mobile: false,
      seq: item.seq,
    });
  }
  return rows.sort((left, right) => right.log.createdAt.localeCompare(left.log.createdAt) || right.seq - left.seq);
}

type ReplayAction =
  | { kind: 'open'; recordingId: string; teamId: string | null }
  | { kind: 'unavailable'; reason: string };

/** 팀 기록 접속 줄의 Replay — 서버에 그 녹화의 구간이 있으면 연다. 진행 중인 접속도 연다. */
function teamReplayAction(
  metadata: SessionLifecycleLogMetadata,
  teamId: string,
  statuses: ReadonlyMap<string, TeamReplayStatus>,
  checked: ReadonlySet<string>,
  translate: Translate,
): ReplayAction | null {
  const recordingId = typeof metadata.recordingId === 'string' ? metadata.recordingId : null;
  if (!recordingId || metadata.hasReplay === false) {
    return null;
  }
  const status = statuses.get(recordingId);
  if (status?.state === 'deleted') {
    return { kind: 'unavailable', reason: translate('teamLogs.replayDeleted') };
  }
  // 녹화는 관리자 이상과 녹화한 사람만 받는다 — 서버가 내주지 않으니 열지 말고 까닭을 말한다.
  if (status && !status.viewable) {
    return { kind: 'unavailable', reason: translate('teamLogs.replayForbidden') };
  }
  if (status && status.segmentCount > 0) {
    return { kind: 'open', recordingId, teamId };
  }
  return checked.has(recordingId) ? { kind: 'unavailable', reason: translate('teamLogs.replayPending') } : null;
}

/** 팀 기록 줄을 남긴 멤버. */
function isSessionLifecycleMetadata(value: Record<string, unknown> | null): value is SessionLifecycleLogMetadata & Record<string, unknown> {
  return Boolean(
    value &&
      typeof value.sessionId === 'string' &&
      typeof value.hostId === 'string' &&
      typeof value.hostLabel === 'string' &&
      typeof value.title === 'string' &&
      typeof value.connectionKind === 'string' &&
      typeof value.connectedAt === 'string' &&
      typeof value.status === 'string'
  );
}

function isPortForwardLifecycleMetadata(value: Record<string, unknown> | null): value is PortForwardLifecycleLogMetadata & Record<string, unknown> {
  return Boolean(
    value &&
      typeof value.ruleId === 'string' &&
      typeof value.ruleLabel === 'string' &&
      typeof value.hostId === 'string' &&
      typeof value.hostLabel === 'string' &&
      typeof value.transport === 'string' &&
      typeof value.mode === 'string' &&
      typeof value.bindAddress === 'string' &&
      typeof value.bindPort === 'number' &&
      typeof value.targetSummary === 'string' &&
      typeof value.startedAt === 'string' &&
      typeof value.status === 'string'
  );
}

function isSftpLifecycleMetadata(value: Record<string, unknown> | null): value is SftpLifecycleLogMetadata & Record<string, unknown> {
  return Boolean(
    value &&
      typeof value.endpointId === 'string' &&
      typeof value.hostId === 'string' &&
      typeof value.hostLabel === 'string' &&
      typeof value.title === 'string' &&
      typeof value.startedAt === 'string' &&
      typeof value.status === 'string' &&
      typeof value.uploadedCount === 'number' &&
      typeof value.downloadedCount === 'number' &&
      typeof value.mkdirCount === 'number' &&
      typeof value.renameCount === 'number' &&
      typeof value.chmodCount === 'number' &&
      typeof value.chownCount === 'number' &&
      typeof value.deleteCount === 'number' &&
      typeof value.errorCount === 'number'
  );
}

function isContainerLifecycleMetadata(value: Record<string, unknown> | null): value is ContainerLifecycleLogMetadata & Record<string, unknown> {
  return Boolean(
    value &&
      typeof value.lifecycleId === 'string' &&
      typeof value.hostId === 'string' &&
      typeof value.hostLabel === 'string' &&
      typeof value.workspaceKind === 'string' &&
      typeof value.transport === 'string' &&
      typeof value.startedAt === 'string' &&
      typeof value.status === 'string' &&
      typeof value.refreshCount === 'number' &&
      typeof value.errorCount === 'number'
  );
}

function isContainerActionMetadata(value: Record<string, unknown> | null): value is ContainerActionLogMetadata & Record<string, unknown> {
  return Boolean(
    value &&
      typeof value.actionId === 'string' &&
      typeof value.hostId === 'string' &&
      typeof value.hostLabel === 'string' &&
      typeof value.containerId === 'string' &&
      typeof value.action === 'string' &&
      typeof value.status === 'string' &&
      typeof value.startedAt === 'string' &&
      typeof value.completedAt === 'string' &&
      typeof value.durationMs === 'number'
  );
}

function getConnectionKindLabel(kind: SessionConnectionKind, tmux = false, awsTransport?: string): string {
  const suffix = tmux ? ' (tmux)' : '';
  if (kind === 'local') {
    return 'Local';
  }
  if (kind === 'aws-ssm') {
    return `${awsTransport === 'ssh-over-ssm' ? 'SSH over SSM' : awsTransport === 'ssm-shell' ? 'SSM Shell' : 'AWS SSM'}${suffix}`;
  }
  if (kind === 'aws-ecs-exec') {
    return 'AWS ECS Exec';
  }
  if (kind === 'serial') {
    return 'Serial';
  }
  if (kind === 'warpgate') {
    return 'Warpgate';
  }
  if (kind === 'rdp') {
    return 'RDP';
  }
  // VNC 를 빼면 폴백에 걸려 **원격 화면 세션이 SSH 로 표기된다** — 실제로 그랬다. SSH 터널을
  // 경유하는 VNC 는 그 줄만 보고는 구분할 방법이 없어 더 헷갈린다.
  if (kind === 'vnc') {
    return 'VNC';
  }
  return `SSH${suffix}`;
}

function getConnectionKindTone(kind: SessionConnectionKind): 'running' | 'starting' | 'paused' {
  if (kind === 'local') {
    return 'running';
  }
  if (kind === 'aws-ssm') {
    return 'starting';
  }
  if (kind === 'aws-ecs-exec') {
    return 'starting';
  }
  if (kind === 'serial') {
    return 'running';
  }
  if (kind === 'warpgate') {
    return 'paused';
  }
  return 'running';
}

function getPortForwardTransportLabel(transport: PortForwardTransport): string {
  if (transport === 'aws-ssm') {
    return 'AWS SSM';
  }
  if (transport === 'ecs-task') {
    return 'ECS Task';
  }
  if (transport === 'container') {
    return 'Container';
  }
  return 'SSH';
}

function getPortForwardTransportTone(transport: PortForwardTransport): 'running' | 'starting' | 'paused' {
  if (transport === 'aws-ssm' || transport === 'ecs-task') {
    return 'starting';
  }
  return 'running';
}

function getLifecycleStatusLabel(status: SessionLifecycleLogMetadata['status']): string {
  if (status === 'connected') {
    return 'Connected';
  }
  if (status === 'error') {
    return 'Error';
  }
  return 'Closed';
}

function getLifecycleStatusTone(status: SessionLifecycleLogMetadata['status']): 'running' | 'error' | 'stopped' {
  if (status === 'connected') {
    return 'running';
  }
  if (status === 'error') {
    return 'error';
  }
  return 'stopped';
}

function getPortForwardStatusLabel(status: PortForwardLifecycleLogMetadata['status']): string {
  if (status === 'running') {
    return 'Running';
  }
  if (status === 'error') {
    return 'Error';
  }
  return 'Closed';
}

function getPortForwardStatusTone(status: PortForwardLifecycleLogMetadata['status']): 'running' | 'error' | 'stopped' {
  if (status === 'running') {
    return 'running';
  }
  if (status === 'error') {
    return 'error';
  }
  return 'stopped';
}

function isOpenSftpStatus(status: SftpLifecycleLogMetadata['status']): boolean {
  return status === 'connecting' || status === 'connected';
}

function isOpenContainerStatus(status: ContainerLifecycleLogMetadata['status']): boolean {
  return status === 'connecting' || status === 'connected';
}

function getSftpStatusLabel(status: SftpLifecycleLogMetadata['status']): string {
  if (status === 'connecting') {
    return 'Connecting';
  }
  if (status === 'connected') {
    return 'Connected';
  }
  if (status === 'error') {
    return 'Error';
  }
  return 'Closed';
}

function getSftpStatusTone(status: SftpLifecycleLogMetadata['status']): 'running' | 'starting' | 'error' | 'stopped' {
  if (status === 'connecting') {
    return 'starting';
  }
  if (status === 'connected') {
    return 'running';
  }
  if (status === 'error') {
    return 'error';
  }
  return 'stopped';
}

function getContainerStatusLabel(status: ContainerLifecycleLogMetadata['status']): string {
  if (status === 'connecting') return 'Connecting';
  if (status === 'connected') return 'Connected';
  if (status === 'unsupported') return 'Unsupported';
  if (status === 'error') return 'Error';
  return 'Closed';
}

function getContainerStatusTone(status: ContainerLifecycleLogMetadata['status']): 'running' | 'starting' | 'paused' | 'error' | 'stopped' {
  if (status === 'connecting') return 'starting';
  if (status === 'connected') return 'running';
  if (status === 'unsupported') return 'paused';
  if (status === 'error') return 'error';
  return 'stopped';
}

function getContainerTransportLabel(transport: ContainerLifecycleLogMetadata['transport']): string {
  if (transport === 'aws-ssm') return 'AWS SSM';
  if (transport === 'aws-ecs') return 'AWS ECS';
  if (transport === 'warpgate') return 'Warpgate';
  return 'SSH';
}

function getContainerActionLabel(action: ContainerActionLogMetadata['action']): string {
  if (action === 'start') return 'Start';
  if (action === 'stop') return 'Stop';
  if (action === 'restart') return 'Restart';
  return 'Remove';
}

function formatLogTimestamp(value: string): string {
  return new Date(value).toLocaleString(getFormatLocale());
}

function formatBytes(value?: number | null): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let nextValue = value;
  let unitIndex = 0;
  while (nextValue >= 1024 && unitIndex < units.length - 1) {
    nextValue /= 1024;
    unitIndex += 1;
  }
  const formatted = Number.isInteger(nextValue) || nextValue >= 10 || unitIndex === 0
    ? Math.round(nextValue).toString()
    : nextValue.toFixed(1);
  return `${formatted}${units[unitIndex]}`;
}

/**
 * 수명 줄의 끝 시각 칸. 끝났는데 시각을 모르면(앱이 꺼져 끊긴 줄) 비워 둔다 — 모르는 시각을 지어내지 않는다.
 * 아직 이어지는 줄이면 ongoingLabel 이다.
 */
function formatLifecycleEnd(endedAt: string | null | undefined, ongoing: boolean, ongoingLabel: string): string {
  if (endedAt) {
    return formatLogTimestamp(endedAt);
  }
  return ongoing ? ongoingLabel : '—';
}

/** 수명 줄의 길이 칸. 끝 시각을 모르는 끝난 줄은 길이도 모른다. */
function formatLifecycleDuration(durationMs: number | null | undefined, endedAt: string | null | undefined, ongoing: boolean): string {
  return !ongoing && !endedAt ? '—' : formatSessionLifecycleDuration(durationMs);
}

export function formatSessionLifecycleDuration(durationMs?: number | null): string {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) {
    return t('logs.duration.zero');
  }

  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return t('logs.duration.hoursMinutes', { hours, minutes });
  }
  if (minutes > 0) {
    return t('logs.duration.minutesSeconds', { minutes, seconds });
  }
  return t('logs.duration.seconds', { seconds });
}

function getSessionLifecycleSubtitle(metadata: SessionLifecycleLogMetadata): string | null {
  const connectionDetails = metadata.connectionDetails?.trim();
  if (connectionDetails) {
    return connectionDetails;
  }
  const title = metadata.title.trim();
  const hostLabel = metadata.hostLabel.trim();
  if (!title || title === hostLabel) {
    return null;
  }
  return title;
}

function formatSftpCountWithBytes(label: string, count: number, bytes: number): string | null {
  if (count <= 0) {
    return null;
  }
  const formattedBytes = formatBytes(bytes);
  return formattedBytes
    ? t('logs.sftp.countWithBytes', { label, count, bytes: formattedBytes })
    : t('logs.sftp.count', { label, count });
}

function getSftpSummaryItems(metadata: SftpLifecycleLogMetadata): string[] {
  return [
    formatSftpCountWithBytes(t('logs.sftp.download'), metadata.downloadedCount, metadata.downloadedBytes),
    formatSftpCountWithBytes(t('logs.sftp.upload'), metadata.uploadedCount, metadata.uploadedBytes),
    formatSftpCountWithBytes(t('logs.sftp.remoteCopy'), metadata.remoteCopyCount ?? 0, metadata.remoteCopyBytes ?? 0),
    metadata.deleteCount > 0 ? t('logs.sftp.delete', { count: metadata.deleteCount }) : null,
    metadata.mkdirCount > 0 ? t('logs.sftp.mkdir', { count: metadata.mkdirCount }) : null,
    metadata.renameCount > 0 ? t('logs.sftp.rename', { count: metadata.renameCount }) : null,
    metadata.chmodCount > 0 ? t('logs.sftp.chmod', { count: metadata.chmodCount }) : null,
    metadata.chownCount > 0 ? t('logs.sftp.chown', { count: metadata.chownCount }) : null,
    metadata.visitedPathCount > 1 ? t('logs.sftp.visitedPaths', { count: metadata.visitedPathCount }) : null,
    metadata.errorCount > 0 ? t('logs.sftp.errors', { count: metadata.errorCount }) : null,
  ].filter((item): item is string => Boolean(item));
}

/**
 * 검색이 훑을 글자. **화면에 실제로 그려지는 것만** 모은다.
 *
 * 카드 여섯 종류 중 다섯은 번역된 메시지를 쓰지 않고 메타데이터에서 직접 그린다 — 호스트
 * 이름도 컨테이너 이름도 포트도 전부 거기 있다. `log.message` 만 훑으면 화면에 보이는
 * 글자의 대부분을 못 찾는다.
 *
 * 일부러 뺀 것 두 가지:
 * - **시각과 소요 시간.** "2026" 이 거의 모든 줄에 걸려 거르는 데 도움이 안 된다.
 * - **접혀 있는 Metadata JSON.** 맞았는데 왜 맞았는지 화면에 안 보이면 더 헷갈린다.
 */
function getLogSearchText(log: ActivityLogRecord, translate: Translate): string {
  const parts: Array<string | null | undefined> = [];
  const metadata = log.metadata;

  if (log.kind === 'container-lifecycle' && isContainerLifecycleMetadata(metadata)) {
    parts.push(
      metadata.hostLabel,
      metadata.workspaceKind === 'ecs-cluster' ? 'ECS cluster' : 'Host containers',
      getContainerTransportLabel(metadata.transport),
      metadata.runtime,
      getContainerStatusLabel(metadata.status),
      metadata.lastError,
      metadata.endReason,
    );
  } else if (log.kind === 'container-action' && isContainerActionMetadata(metadata)) {
    parts.push(
      metadata.containerName,
      metadata.containerId,
      metadata.hostLabel,
      metadata.runtime,
      getContainerActionLabel(metadata.action),
      metadata.status === 'success' ? 'Success' : 'Error',
      metadata.errorMessage,
    );
  } else if (log.kind === 'session-lifecycle' && isSessionLifecycleMetadata(metadata)) {
    parts.push(
      metadata.hostLabel,
      getSessionLifecycleSubtitle(metadata),
      getConnectionKindLabel(metadata.connectionKind, metadata.tmux, metadata.awsTransport),
      getLifecycleStatusLabel(metadata.status),
      metadata.disconnectReason,
    );
  } else if (log.kind === 'sftp-lifecycle' && isSftpLifecycleMetadata(metadata)) {
    parts.push(
      metadata.hostLabel,
      metadata.title,
      'SFTP',
      getSftpStatusLabel(metadata.status),
      metadata.lastPath,
      metadata.endReason,
    );
  } else if (log.kind === 'port-forward-lifecycle' && isPortForwardLifecycleMetadata(metadata)) {
    parts.push(
      metadata.ruleLabel,
      metadata.hostLabel,
      `${metadata.bindAddress}:${metadata.bindPort} -> ${metadata.targetSummary}`,
      getPortForwardTransportLabel(metadata.transport),
      getPortForwardStatusLabel(metadata.status),
      metadata.endReason,
    );
  } else {
    // 그 밖의 기록은 일반 카드로 그려진다 — 거기 보이는 것은 문구·레벨·카테고리뿐이다.
    parts.push(resolveLogMessage(log, translate), log.level, log.category);
  }

  return parts
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ')
    .toLocaleLowerCase();
}

/** 줄의 찾기 글 — 카드에 보이는 것, 팀 기록이면 남긴 사람과(폰이면) 'mobile'. */
function getRowSearchText(row: LogRow, translate: Translate): string {
  const text = getLogSearchText(row.log, translate);
  // 폰이 남긴 줄은 'mobile' 로도 찾는다 — 작성자 뒤에 보이는 그 글자다.
  const mobile = row.mobile ? ' mobile' : '';
  return row.author ? `${text} ${row.author.toLocaleLowerCase()}${mobile}` : text;
}

const TEAM_CSV_HEADER = ['Time', 'Person', 'Device', 'Kind', 'Host', 'Status', 'Message', 'Started', 'Ended', 'Duration (s)'];
const PERSONAL_CSV_HEADER = ['Time', 'Kind', 'Host', 'Status', 'Message', 'Started', 'Ended', 'Duration (s)'];

interface CsvFields {
  kind: string;
  host: string;
  status: string;
  message: string;
  started: string | null | undefined;
  ended: string | null | undefined;
  durationMs: number | null | undefined;
}

/** 줄 하나의 표 칸 — 카드의 뱃지와 같은 이름을 쓴다. */
function csvFieldsOf(log: ActivityLogRecord, translate: Translate): CsvFields {
  const metadata = log.metadata;
  const joined = (...parts: Array<string | null | undefined>) => parts.filter(Boolean).join(' · ');
  if (log.kind === 'session-lifecycle' && isSessionLifecycleMetadata(metadata)) {
    return {
      kind: getConnectionKindLabel(metadata.connectionKind, metadata.tmux, metadata.awsTransport),
      host: metadata.hostLabel,
      status: getLifecycleStatusLabel(metadata.status),
      message: metadata.disconnectReason ?? '',
      started: metadata.connectedAt,
      ended: metadata.disconnectedAt,
      durationMs: metadata.durationMs,
    };
  }
  if (log.kind === 'sftp-lifecycle' && isSftpLifecycleMetadata(metadata)) {
    return {
      kind: 'SFTP',
      host: metadata.hostLabel,
      status: getSftpStatusLabel(metadata.status),
      message: metadata.endReason ?? '',
      started: metadata.startedAt,
      ended: metadata.endedAt,
      durationMs: metadata.durationMs,
    };
  }
  if (log.kind === 'port-forward-lifecycle' && isPortForwardLifecycleMetadata(metadata)) {
    return {
      kind: `Port forward · ${getPortForwardTransportLabel(metadata.transport)}`,
      host: metadata.hostLabel,
      status: getPortForwardStatusLabel(metadata.status),
      message: joined(metadata.ruleLabel, `${metadata.bindAddress}:${metadata.bindPort} -> ${metadata.targetSummary}`, metadata.endReason),
      started: metadata.startedAt,
      ended: metadata.stoppedAt,
      durationMs: metadata.durationMs,
    };
  }
  if (log.kind === 'container-lifecycle' && isContainerLifecycleMetadata(metadata)) {
    return {
      kind: `Containers · ${getContainerTransportLabel(metadata.transport)}`,
      host: metadata.hostLabel,
      status: getContainerStatusLabel(metadata.status),
      message: metadata.lastError ?? metadata.endReason ?? '',
      started: metadata.startedAt,
      ended: metadata.endedAt,
      durationMs: metadata.durationMs,
    };
  }
  if (log.kind === 'container-action' && isContainerActionMetadata(metadata)) {
    return {
      kind: 'Container action',
      host: metadata.hostLabel,
      status: metadata.status === 'success' ? 'Success' : 'Error',
      message: joined(getContainerActionLabel(metadata.action), metadata.containerName || metadata.containerId, metadata.errorMessage),
      started: metadata.startedAt,
      ended: metadata.completedAt,
      durationMs: metadata.durationMs,
    };
  }
  // 그 밖의 기록은 문구 카드 — 분류·수준·문구만 있다.
  return {
    kind: log.category,
    host: '',
    status: log.level.toUpperCase(),
    message: resolveLogMessage(log, translate),
    started: null,
    ended: null,
    durationMs: null,
  };
}

/**
 * 거른 줄을 CSV 로. 팀 기록은 사람·기기 칸이 더 있다(서버가 남긴 멤버 변화 줄은 둘 다 비어 있다). 명령 내용은 원래
 * 서버에 올리지 않으므로 없다.
 */
export function buildLogsCsv(rows: readonly LogRow[], team: boolean, translate: Translate): string {
  return buildCsv(
    team ? TEAM_CSV_HEADER : PERSONAL_CSV_HEADER,
    rows.map((row) => {
      const fields = csvFieldsOf(row.log, translate);
      const tail: CsvValue[] = [
        fields.kind,
        fields.host,
        fields.status,
        fields.message,
        formatCsvTime(fields.started),
        formatCsvTime(fields.ended),
        // 카드의 '연결 시간'과 같은 초 — 남는 것은 버린다.
        typeof fields.durationMs === 'number' ? Math.floor(fields.durationMs / 1000) : null,
      ];
      if (!team) {
        return [formatCsvTime(row.log.createdAt), ...tail];
      }
      const device = row.author ? (row.mobile ? 'Mobile' : 'Desktop') : '';
      return [formatCsvTime(row.log.createdAt), row.author ?? '', device, ...tail];
    }),
  );
}

export function LogsPanel({ logs, onClear, onOpenReplay, teams = [], onListMembers }: LogsPanelProps) {
  const { t: translate } = useTranslation();
  const [category, setCategory] = useState<'all' | ActivityLogCategory>('all');
  const [level, setLevel] = useState<'all' | ActivityLogLevel>('all');
  const [search, setSearch] = useState('');
  const [vault, setVault] = useState<string>(PERSONAL_VAULT);
  // 고른 팀이 이 기기에서 없어지면(나감·지움) 개인 기록으로 돌아간다.
  const teamId = vault !== PERSONAL_VAULT && teams.some((team) => team.id === vault) ? vault : null;
  // 바뀐 것과 복원은 관리자 이상만(서버도 막는다). 멤버·읽기 전용과 개인 볼트에는 탭 줄이 없다.
  const teamRole = teams.find((team) => team.id === teamId)?.role;
  const canRestore = Boolean(teamId && teamRole && canManageTeam(teamRole));
  const [view, setView] = useState<'activity' | 'changes'>('activity');
  // 고른 사람은 그 팀에서만 — 다른 볼트로 가면 '모두'다.
  const [person, setPerson] = useState<{ teamId: string; email: string } | null>(null);
  const personValue = teamId && person?.teamId === teamId ? person.email : ALL;
  const [period, setPeriod] = useState<LogsPeriod>({ mode: 'all' });
  const [periodPickerOpen, setPeriodPickerOpen] = useState(false);
  // 내보내는 중이면 지금까지 받은 줄 수. 멈춤은 signal 로 알린다.
  const [exporting, setExporting] = useState<number | null>(null);
  const exportSignalRef = useRef<{ stopped: boolean } | null>(null);
  // 내보내기 알림 — 내보낼 때 보던 것(view)과 지금 보는 것이 같을 때만 보인다. 다른 볼트·거르기로 가면 사라진다.
  const [exportNote, setExportNote] = useState<{ tone: 'saved' | 'failed'; text: string; view: string } | null>(null);
  const [members, setMembers] = useState<{ teamId: string; emails: string[] } | null>(null);
  const showChanges = canRestore && view === 'changes';
  const teamActivity = useTeamActivity(teamId);
  const teamRows = useMemo(
    () => (teamId ? buildTeamRows(teamActivity.items, translate) : null),
    [teamActivity.items, teamId, translate]
  );
  const shownLogs = useMemo(() => teamRows?.map((row) => row.log) ?? logs, [logs, teamRows]);
  const authorById = useMemo(
    () => new Map((teamRows ?? []).map((row) => [row.log.id, row.author])),
    [teamRows]
  );
  const mobileIds = useMemo(
    () => new Set((teamRows ?? []).filter((row) => row.mobile).map((row) => row.log.id)),
    [teamRows]
  );

  const rowOf = (log: ActivityLogRecord): LogRow => ({
    log,
    author: authorById.get(log.id) ?? null,
    mobile: mobileIds.has(log.id),
  });

  // 한 번만 뽑아 둔다. 최대 1만 건이라 글자마다 다시 만들면 입력이 끊긴다.
  // translate 가 바뀌는 때는 언어가 바뀌는 때이고, 그때는 다시 만드는 것이 맞다.
  const searchTextById = useMemo(
    () =>
      new Map(
        shownLogs.map((log) => [
          log.id,
          getRowSearchText({ log, author: authorById.get(log.id) ?? null, mobile: mobileIds.has(log.id) }, translate),
        ])
      ),
    [authorById, mobileIds, shownLogs, translate]
  );
  // 호스트 검색과 같은 규칙: `tjqj` 로도 `서버` 가 걸린다. 같은 앱에서 검색이 갈리면 안 된다.
  const searchQueries = useMemo(
    () => getKeyboardLayoutSearchQueries(search).map((query) => query.toLocaleLowerCase()),
    [search]
  );

  // 최근 얼마는 지금을 기준으로 — 새 줄을 받을 때마다 다시 잰다.
  const range = useMemo(() => resolveLogsPeriod(period, new Date()), [period, shownLogs]);
  const filter: LogFilter = { category, level, person: personValue, range, queries: searchQueries };

  const visibleLogs = useMemo(
    () =>
      shownLogs.filter((log) =>
        matchesLogFilter(
          { log, author: authorById.get(log.id) ?? null, mobile: mobileIds.has(log.id) },
          { category, level, person: personValue, range, queries: searchQueries },
          () => searchTextById.get(log.id) ?? ''
        )
      ),
    [authorById, category, level, mobileIds, personValue, range, searchQueries, searchTextById, shownLogs]
  );

  // Person 의 사람 — 지금 멤버와, 받은 기록에 남은 사람(빠진 멤버도).
  useEffect(() => {
    if (!teamId || !onListMembers) {
      return undefined;
    }
    let cancelled = false;
    void Promise.resolve()
      .then(() => onListMembers(teamId))
      .then((list) => {
        if (!cancelled) {
          setMembers({ teamId, emails: list.map((member) => member.email) });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [onListMembers, teamId]);
  const personOptions = useMemo(() => {
    if (!teamId) {
      return [];
    }
    const emails = new Set(members?.teamId === teamId ? members.emails : []);
    for (const row of teamRows ?? []) {
      if (row.author) {
        emails.add(row.author);
      }
    }
    if (personValue !== ALL) {
      emails.add(personValue);
    }
    return [...emails].sort((left, right) => left.localeCompare(right));
  }, [members, personValue, teamId, teamRows]);

  // 팀 기록에서 기간을 고르면 그 시작까지 지난 줄을 받는다 — 그래야 걸러진 목록이 그 기간에 대해 빠짐없다.
  const { hasMore, loadMore, loadOlder } = teamActivity;
  useEffect(() => {
    const start = teamId ? resolveLogsPeriod(period, new Date())?.start : undefined;
    if (!teamId || start === undefined) {
      return;
    }
    void loadOlder({ since: new Date(start).toISOString() }).catch(() => undefined);
  }, [loadOlder, period, teamId]);
  const oldestItem = teamActivity.items[teamActivity.items.length - 1];
  const periodLoaded = range !== null && reachedSince(oldestItem, new Date(range.start).toISOString());

  // 팀 기록은 목록 끝까지 내려오면 더 받는다(더 보기 단추는 두지 않는다). 거른 줄이 적어 끝 자리가 계속 보이면 쪽마다
  // 다시 지켜 이어 받는다. 기간을 골랐으면 그 시작까지만.
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const keepLoading = Boolean(teamId) && hasMore && !periodLoaded;
  useEffect(() => {
    const sentinel = loadMoreRef.current;
    if (!keepLoading || !sentinel || typeof IntersectionObserver === 'undefined') {
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadMore();
      }
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [keepLoading, loadMore, teamActivity.items.length, visibleLogs.length]);

  const periodLabel =
    period.mode === 'all'
      ? translate('logs.period.all')
      : period.mode === 'absolute'
        ? formatLogsRangeLabel('absolute', period.absolute, null)
        : formatLogsRangeLabel('recent', null, period.relative);
  const olderNote =
    teamId && teamActivity.loadingOlder && exporting === null && oldestItem
      ? translate('logs.loadingOlder', {
          date: new Date(oldestItem.createdAt).toLocaleDateString(getFormatLocale(), { month: 'long', day: 'numeric' }),
        })
      : null;

  const viewKey = JSON.stringify([teamId ?? PERSONAL_VAULT, personValue, period, category, level, search]);
  const shownNote = exportNote?.view === viewKey ? exportNote : null;

  /**
   * 지금 조건에 맞는 줄을 모두 CSV 로. 팀 기록은 아직 안 받은 줄을 먼저 받는다(기간이 있으면 그 시작까지, 없으면 끝까지).
   * 받는 줄 수를 단추에 보이고, 멈춤을 누르면 저장하지 않고 그만둔다.
   */
  const exportCsv = async () => {
    setExportNote(null);
    const view = viewKey;
    const signal = { stopped: false };
    exportSignalRef.current = signal;
    const exportFilter: LogFilter = { ...filter, range: resolveLogsPeriod(period, new Date()) };
    try {
      let rows: LogRow[];
      if (teamId) {
        setExporting(teamActivity.items.length);
        const items = await loadOlder({
          since: exportFilter.range ? new Date(exportFilter.range.start).toISOString() : null,
          onProgress: (count) => {
            if (!signal.stopped) {
              setExporting(count);
            }
          },
          signal,
        });
        if (!items || signal.stopped) {
          return;
        }
        rows = buildTeamRows(items, translate);
      } else {
        rows = logs.map(rowOf);
      }
      const matching = rows.filter((row) => matchesLogFilter(row, exportFilter, () => getRowSearchText(row, translate)));
      if (matching.length === 0) {
        setExportNote({ tone: 'failed', text: translate('logs.export.nothing'), view });
        return;
      }
      const vaultName = teamId ? (teams.find((team) => team.id === teamId)?.name ?? 'team') : 'personal';
      const result = await exportLogsCsv({
        content: buildLogsCsv(matching, Boolean(teamId), translate),
        fileName: logsCsvFileName(vaultName, new Date()),
        rowCount: matching.length,
        vaultId: teamId,
      });
      if (!result.canceled && result.savedPath) {
        setExportNote({
          tone: 'saved',
          text: translate('logs.export.saved', { file: result.savedPath.split(/[\\/]/).pop() }),
          view,
        });
      }
    } catch (reason: unknown) {
      setExportNote({
        tone: 'failed',
        text: translate('logs.export.failed', { message: reason instanceof Error ? reason.message : String(reason) }),
        view,
      });
    } finally {
      if (exportSignalRef.current === signal) {
        exportSignalRef.current = null;
        setExporting(null);
      }
    }
  };
  const stopExport = () => {
    if (exportSignalRef.current) {
      exportSignalRef.current.stopped = true;
      exportSignalRef.current = null;
    }
    setExporting(null);
  };

  return (
    <div className="flex flex-col gap-[1.1rem]">
      {/* 상단 브레드크럼(← Hosts · Logs)에 이미 제목이 있어 Diagnostics/Logs 헤더는 생략.
          Clear logs 버튼은 아래 필터 행 오른쪽으로 옮긴다. */}
      <Toolbar>
        {teams.length > 0 ? (
          <label className="flex w-full max-w-[220px] flex-col gap-[0.4rem]">
            <span className="text-[0.9rem] text-[var(--text-soft)]">Vault</span>
            <SelectField value={teamId ?? PERSONAL_VAULT} onChange={(event) => setVault(event.target.value)}>
              <option value={PERSONAL_VAULT}>Personal</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </SelectField>
          </label>
        ) : null}

        {canRestore ? (
          <div className="flex items-center gap-2">
            <Tabs role="tablist" aria-label={translate('teamChanges.tabsLabel')}>
              <TabButton role="tab" aria-selected={!showChanges} active={!showChanges} onClick={() => setView('activity')}>
                Activity
              </TabButton>
              <TabButton role="tab" aria-selected={showChanges} active={showChanges} onClick={() => setView('changes')}>
                Changes
              </TabButton>
            </Tabs>
            <InfoHint label={translate('teamChanges.about.label')}>
              <InfoHintPoints
                items={[
                  translate('teamChanges.about.body'),
                  translate('teamChanges.about.together'),
                  translate('teamChanges.about.admins'),
                ]}
              />
            </InfoHint>
          </div>
        ) : null}

        {/* 바뀐 것에는 사람·분류·수준이 없다 — 찾기만 남는다. */}
        {showChanges ? null : (
          <>
            {/* 개인 기록은 다 내 것이라 Person 이 없다. */}
            {teamId ? (
              <label className="flex w-full max-w-[240px] flex-col gap-[0.4rem]">
                <span className="text-[0.9rem] text-[var(--text-soft)]">Person</span>
                <SelectField
                  value={personValue}
                  onChange={(event) => setPerson({ teamId, email: event.target.value })}
                >
                  <option value={ALL}>All</option>
                  {personOptions.map((email) => (
                    <option key={email} value={email}>
                      {email}
                    </option>
                  ))}
                </SelectField>
              </label>
            ) : null}

            <label className="flex w-full max-w-[150px] flex-col gap-[0.4rem]">
              <span className="text-[0.9rem] text-[var(--text-soft)]">Category</span>
              <SelectField
                value={category}
                onChange={(event) =>
                  setCategory(event.target.value as 'all' | ActivityLogCategory)
                }
              >
                <option value="all">All</option>
                <option value="session">Session</option>
                <option value="audit">Audit</option>
              </SelectField>
            </label>

            <label className="flex w-full max-w-[150px] flex-col gap-[0.4rem]">
              <span className="text-[0.9rem] text-[var(--text-soft)]">Level</span>
              <SelectField
                value={level}
                onChange={(event) =>
                  setLevel(event.target.value as 'all' | ActivityLogLevel)
                }
              >
                <option value="all">All</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
              </SelectField>
            </label>
          </>
        )}

        <label className="flex w-full max-w-[320px] flex-col gap-[0.4rem]">
          <span className="text-[0.9rem] text-[var(--text-soft)]">Search</span>
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={showChanges ? translate('teamChanges.searchPlaceholder') : 'Host, container, port, error'}
          />
        </label>

        {/* 팀 기록은 서버의 것이라 이 기기에서 지우지 않는다. */}
        {teamId ? null : (
          <Button variant="secondary" className="ml-auto" onClick={() => void onClear()}>
            Clear logs
          </Button>
        )}
      </Toolbar>

      {/* 개수 줄(홈 호스트 목록의 '항목 N개' 줄과 같은 틀) — 오른쪽에 기간과 내보내기. 바뀐 것에는 없다. */}
      {showChanges ? null : (
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate text-[0.9rem] font-semibold text-[var(--text)]">
            {translate('logs.count', { count: visibleLogs.length.toLocaleString(getFormatLocale()) })}
            {olderNote ? <span className="font-medium text-[var(--text-soft)]">{olderNote}</span> : null}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            {shownNote ? (
              <span
                role={shownNote.tone === 'failed' ? 'alert' : 'status'}
                className={
                  shownNote.tone === 'failed'
                    ? 'text-[0.85rem] text-[var(--danger-text)]'
                    : 'text-[0.85rem] text-[var(--text-soft)]'
                }
              >
                {shownNote.text}
              </span>
            ) : null}
            <Button
              size="sm"
              aria-label={translate('logs.period.aria', { range: periodLabel })}
              disabled={exporting !== null}
              onClick={() => setPeriodPickerOpen(true)}
            >
              <Calendar className="h-4 w-4" aria-hidden />
              {periodLabel}
            </Button>
            {exporting !== null ? (
              <>
                <Button size="sm" disabled>
                  <Download className="h-4 w-4" aria-hidden />
                  {translate('logs.export.exporting', { count: exporting.toLocaleString(getFormatLocale()) })}
                </Button>
                <Button size="sm" variant="ghost" onClick={stopExport}>
                  {translate('logs.export.stop')}
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => void exportCsv()}>
                <Download className="h-4 w-4" aria-hidden />
                Export CSV
              </Button>
            )}
          </div>
        </div>
      )}

      <PanelSection>
        {showChanges && teamId ? (
          <TeamChangesList teamId={teamId} search={search} />
        ) : teamId && teamActivity.error && visibleLogs.length === 0 ? (
          <EmptyState title={translate('teamLogs.loadFailed')} description={teamActivity.error} />
        ) : teamId && (teamActivity.loading || keepLoading) && visibleLogs.length === 0 ? (
          // 거른 줄이 아직 없어도 지난 쪽이 남았으면 찾는 중이다 — '기록 없음'이 아니다.
          <EmptyState title={translate('teamLogs.loading')} />
        ) : visibleLogs.length === 0 ? (
          <EmptyState
            title={translate('logs.empty.title')}
            description={translate(teamId ? 'teamLogs.emptyDescription' : 'logs.empty.description')}
          />
        ) : (
          visibleLogs.map((log) => {
            const sessionLifecycleMetadata =
              log.kind === 'session-lifecycle' && isSessionLifecycleMetadata(log.metadata)
                ? log.metadata
                : null;
            const portForwardLifecycleMetadata =
              log.kind === 'port-forward-lifecycle' && isPortForwardLifecycleMetadata(log.metadata)
                ? log.metadata
                : null;
            const sftpLifecycleMetadata =
              log.kind === 'sftp-lifecycle' && isSftpLifecycleMetadata(log.metadata)
                ? log.metadata
                : null;
            const containerLifecycleMetadata =
              log.kind === 'container-lifecycle' && isContainerLifecycleMetadata(log.metadata)
                ? log.metadata
                : null;
            const containerActionMetadata =
              log.kind === 'container-action' && isContainerActionMetadata(log.metadata)
                ? log.metadata
                : null;
            // 이 기기의 녹화: 진행 중(connected) 세션은 녹화가 아직 finalize되지 않아 재생 불가 →
            // 종료된 세션(closed/error)만 Replay 버튼을 노출한다. 팀 녹화는 서버에 구간이 있으면 진행 중에도 연다.
            const replayAction: ReplayAction | null = !sessionLifecycleMetadata
              ? null
              : teamId
                ? teamReplayAction(
                    sessionLifecycleMetadata,
                    teamId,
                    teamActivity.replayStatuses,
                    teamActivity.checkedRecordingIds,
                    translate,
                  )
                : (sessionLifecycleMetadata.status === 'closed' ||
                      sessionLifecycleMetadata.status === 'error') &&
                    sessionLifecycleMetadata.hasReplay === true &&
                    typeof sessionLifecycleMetadata.recordingId === 'string'
                  ? { kind: 'open', recordingId: sessionLifecycleMetadata.recordingId, teamId: null }
                  : null;
            const author = authorById.get(log.id) ?? null;
            const mobile = mobileIds.has(log.id);

            return containerLifecycleMetadata ? (
              <Card key={log.id} data-testid="logs-container-lifecycle-card">
                <CardMain>
                  <div className="flex flex-wrap items-center gap-[0.7rem]">
                    <div>
                      <strong>{containerLifecycleMetadata.hostLabel}</strong>
                      <div className="text-[0.9rem] text-[var(--text-soft)]">
                        {containerLifecycleMetadata.workspaceKind === 'ecs-cluster' ? 'ECS cluster' : 'Host containers'}
                      </div>
                      {author ? <AuthorLine email={author} mobile={mobile} /> : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-[0.55rem]">
                      <Badge tone={containerLifecycleMetadata.transport === 'aws-ecs' ? 'starting' : 'running'}>
                        {getContainerTransportLabel(containerLifecycleMetadata.transport)}
                      </Badge>
                      {containerLifecycleMetadata.runtime ? (
                        <Badge tone="paused">{containerLifecycleMetadata.runtime.toUpperCase()}</Badge>
                      ) : null}
                      <Badge tone={getContainerStatusTone(containerLifecycleMetadata.status)}>
                        {getContainerStatusLabel(containerLifecycleMetadata.status)}
                      </Badge>
                    </div>
                  </div>
                  <div className="mt-[0.9rem] grid gap-[0.7rem] md:grid-cols-3">
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.browseStarted')}</span>
                      <strong>{formatLogTimestamp(containerLifecycleMetadata.startedAt)}</strong>
                    </div>
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.browseEnded')}</span>
                      <strong>{formatLifecycleEnd(containerLifecycleMetadata.endedAt, isOpenContainerStatus(containerLifecycleMetadata.status), translate('logs.field.connecting'))}</strong>
                    </div>
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.heldFor')}</span>
                      <strong>{formatLifecycleDuration(containerLifecycleMetadata.durationMs, containerLifecycleMetadata.endedAt, isOpenContainerStatus(containerLifecycleMetadata.status))}</strong>
                    </div>
                  </div>
                  <div className="mt-[0.7rem] flex flex-wrap gap-[0.4rem]">
                    {typeof containerLifecycleMetadata.resourceCount === 'number' ? (
                      <span className="rounded-full bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] px-[0.7rem] py-[0.4rem] text-[0.9rem] text-[var(--text-soft)]">
                        {translate('logs.field.resourceCount', {
                          kind: translate(
                            containerLifecycleMetadata.workspaceKind === 'ecs-cluster'
                              ? 'logs.field.service'
                              : 'logs.field.container',
                          ),
                          count: containerLifecycleMetadata.resourceCount,
                        })}
                      </span>
                    ) : null}
                    {containerLifecycleMetadata.refreshCount > 0 ? (
                      <span className="rounded-full bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] px-[0.7rem] py-[0.4rem] text-[0.9rem] text-[var(--text-soft)]">
                        {translate('logs.field.refreshCount', { count: containerLifecycleMetadata.refreshCount })}
                      </span>
                    ) : null}
                    {containerLifecycleMetadata.errorCount > 0 ? (
                      <span className="rounded-full bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] px-[0.7rem] py-[0.4rem] text-[0.9rem] text-[var(--text-soft)]">
                        {translate('logs.field.errorCount', { count: containerLifecycleMetadata.errorCount })}
                      </span>
                    ) : null}
                  </div>
                  {containerLifecycleMetadata.lastError || containerLifecycleMetadata.endReason ? (
                    <div className="mt-[0.7rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] px-[0.9rem] py-[0.7rem] text-[0.9rem] text-[var(--text-soft)]">
                      {containerLifecycleMetadata.lastError ?? containerLifecycleMetadata.endReason}
                    </div>
                  ) : null}
                </CardMain>
              </Card>
            ) : containerActionMetadata ? (
              <Card key={log.id} data-testid="logs-container-action-card">
                <CardMain>
                  <div className="flex flex-wrap items-center gap-[0.7rem]">
                    <div>
                      <strong>{containerActionMetadata.containerName || containerActionMetadata.containerId}</strong>
                      <div className="text-[0.9rem] text-[var(--text-soft)]">{containerActionMetadata.hostLabel}</div>
                      {containerActionMetadata.containerName ? (
                        <div className="text-[0.82rem] text-[var(--text-soft)]">{containerActionMetadata.containerId}</div>
                      ) : null}
                      {author ? <AuthorLine email={author} mobile={mobile} /> : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-[0.55rem]">
                      {containerActionMetadata.runtime ? (
                        <Badge tone="paused">{containerActionMetadata.runtime.toUpperCase()}</Badge>
                      ) : null}
                      <Badge tone="starting">{getContainerActionLabel(containerActionMetadata.action)}</Badge>
                      <Badge tone={containerActionMetadata.status === 'success' ? 'running' : 'error'}>
                        {containerActionMetadata.status === 'success' ? 'Success' : 'Error'}
                      </Badge>
                    </div>
                  </div>
                  <div className="mt-[0.9rem] grid gap-[0.7rem] md:grid-cols-2">
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.ranAt')}</span>
                      <strong>{formatLogTimestamp(containerActionMetadata.startedAt)}</strong>
                    </div>
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.runDuration')}</span>
                      <strong>{formatSessionLifecycleDuration(containerActionMetadata.durationMs)}</strong>
                    </div>
                  </div>
                  {containerActionMetadata.errorMessage ? (
                    <div className="mt-[0.7rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] px-[0.9rem] py-[0.7rem] text-[0.9rem] text-[var(--text-soft)]">
                      {containerActionMetadata.errorMessage}
                    </div>
                  ) : null}
                </CardMain>
              </Card>
            ) : sessionLifecycleMetadata ? (
              <Card key={log.id} data-testid="logs-lifecycle-card">
                <CardMain>
                  <div className="flex flex-wrap items-center gap-[0.7rem]">
                    <div>
                      <strong>{sessionLifecycleMetadata.hostLabel}</strong>
                      {getSessionLifecycleSubtitle(sessionLifecycleMetadata) ? (
                        <div className="text-[0.9rem] text-[var(--text-soft)]">{getSessionLifecycleSubtitle(sessionLifecycleMetadata)}</div>
                      ) : null}
                      {author ? <AuthorLine email={author} mobile={mobile} /> : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-[0.55rem]">
                      <Badge tone={getConnectionKindTone(sessionLifecycleMetadata.connectionKind)}>
                        {getConnectionKindLabel(
                          sessionLifecycleMetadata.connectionKind,
                          sessionLifecycleMetadata.tmux,
                          sessionLifecycleMetadata.awsTransport,
                        )}
                      </Badge>
                      <Badge tone={getLifecycleStatusTone(sessionLifecycleMetadata.status)}>
                        {getLifecycleStatusLabel(sessionLifecycleMetadata.status)}
                      </Badge>
                    </div>
                    {/* 유일하게 누를 수 있는 요소라 배지 사이에 끼워 두지 않는다 — 오른쪽 끝
                        액션 자리로 빼고 아이콘을 붙여야 배지와 구분된다(다크 테마에서 특히). */}
                    {replayAction?.kind === 'open' ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="ml-auto"
                        onClick={() => void onOpenReplay(replayAction.recordingId, replayAction.teamId)}
                      >
                        <Play className="h-[0.8rem] w-[0.8rem]" aria-hidden />
                        Replay
                      </Button>
                    ) : replayAction?.kind === 'unavailable' ? (
                      // 왜 못 여는지 말해 준다. 비활성 버튼만 두면 고장으로 읽는다. 하우스 단추의 꺼짐(0.7)은 켜진
                      // Replay 와 거의 같아 보여서, 호스트 상세의 꺼진 Replay 와 같은 0.5 로 흐린다.
                      <Tooltip className="ml-auto cursor-not-allowed" label={replayAction.reason}>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled
                          className="disabled:opacity-50"
                          aria-label={`Replay — ${replayAction.reason}`}
                        >
                          <Play className="h-[0.8rem] w-[0.8rem]" aria-hidden />
                          Replay
                        </Button>
                      </Tooltip>
                    ) : null}
                  </div>
                  <div className="mt-[0.9rem] grid gap-[0.7rem] md:grid-cols-3">
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.connectStarted')}</span>
                      <strong>{formatLogTimestamp(sessionLifecycleMetadata.connectedAt)}</strong>
                    </div>
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.connectEnded')}</span>
                      <strong>{formatLifecycleEnd(sessionLifecycleMetadata.disconnectedAt, sessionLifecycleMetadata.status === 'connected', translate('logs.field.connecting'))}</strong>
                    </div>
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.connectDuration')}</span>
                      <strong>{formatLifecycleDuration(sessionLifecycleMetadata.durationMs, sessionLifecycleMetadata.disconnectedAt, sessionLifecycleMetadata.status === 'connected')}</strong>
                    </div>
                  </div>
                  {sessionLifecycleMetadata.disconnectReason ? (
                    <div className="mt-[0.7rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] px-[0.9rem] py-[0.7rem] text-[0.9rem] text-[var(--text-soft)]">{sessionLifecycleMetadata.disconnectReason}</div>
                  ) : null}
                </CardMain>
              </Card>
            ) : sftpLifecycleMetadata ? (
              <Card key={log.id} data-testid="logs-sftp-lifecycle-card">
                <CardMain>
                  <div className="flex flex-wrap items-center gap-[0.7rem]">
                    <div>
                      <strong>{sftpLifecycleMetadata.hostLabel}</strong>
                      {sftpLifecycleMetadata.title.trim() && sftpLifecycleMetadata.title.trim() !== sftpLifecycleMetadata.hostLabel.trim() ? (
                        <div className="text-[0.9rem] text-[var(--text-soft)]">{sftpLifecycleMetadata.title}</div>
                      ) : null}
                      {author ? <AuthorLine email={author} mobile={mobile} /> : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-[0.55rem]">
                      <Badge tone="running">SFTP</Badge>
                      <Badge tone={getSftpStatusTone(sftpLifecycleMetadata.status)}>
                        {getSftpStatusLabel(sftpLifecycleMetadata.status)}
                      </Badge>
                    </div>
                  </div>
                  <div className="mt-[0.9rem] grid gap-[0.7rem] md:grid-cols-3">
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.connectStarted')}</span>
                      <strong>{formatLogTimestamp(sftpLifecycleMetadata.connectedAt ?? sftpLifecycleMetadata.startedAt)}</strong>
                    </div>
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.connectEnded')}</span>
                      <strong>{formatLifecycleEnd(sftpLifecycleMetadata.endedAt, isOpenSftpStatus(sftpLifecycleMetadata.status), translate('logs.field.connecting'))}</strong>
                    </div>
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.connectDuration')}</span>
                      <strong>{formatLifecycleDuration(sftpLifecycleMetadata.durationMs, sftpLifecycleMetadata.endedAt, isOpenSftpStatus(sftpLifecycleMetadata.status))}</strong>
                    </div>
                  </div>
                  {getSftpSummaryItems(sftpLifecycleMetadata).length > 0 ? (
                    <div className="mt-[0.7rem] flex flex-wrap gap-[0.4rem]">
                      {getSftpSummaryItems(sftpLifecycleMetadata).map((item) => (
                        <span key={item} className="rounded-full bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] px-[0.7rem] py-[0.4rem] text-[0.9rem] text-[var(--text-soft)]">
                          {item}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {sftpLifecycleMetadata.lastPath ? (
                    <div className="mt-[0.7rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] px-[0.9rem] py-[0.7rem] text-[0.9rem] text-[var(--text-soft)]">
                      {translate('logs.sftp.lastPath', { path: sftpLifecycleMetadata.lastPath })}
                    </div>
                  ) : null}
                  {sftpLifecycleMetadata.endReason ? (
                    <div className="mt-[0.7rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] px-[0.9rem] py-[0.7rem] text-[0.9rem] text-[var(--text-soft)]">{sftpLifecycleMetadata.endReason}</div>
                  ) : null}
                  <details className="mt-[0.7rem] rounded-[10px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                    <summary>Metadata</summary>
                    <pre className="mt-[0.55rem] overflow-x-auto whitespace-pre-wrap break-words rounded-[10px] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] px-3 py-3 text-[0.82rem] leading-[1.55]">{JSON.stringify(log.metadata, null, 2)}</pre>
                  </details>
                </CardMain>
              </Card>
            ) : portForwardLifecycleMetadata ? (
              <Card key={log.id} data-testid="logs-lifecycle-card">
                <CardMain>
                  <div className="flex flex-wrap items-center gap-[0.7rem]">
                    <div>
                      <strong>{portForwardLifecycleMetadata.ruleLabel}</strong>
                      <div className="text-[0.9rem] text-[var(--text-soft)]">{portForwardLifecycleMetadata.hostLabel}</div>
                      <div className="text-[0.9rem] text-[var(--text-soft)]">
                        {`${portForwardLifecycleMetadata.bindAddress}:${portForwardLifecycleMetadata.bindPort} -> ${portForwardLifecycleMetadata.targetSummary}`}
                      </div>
                      {author ? <AuthorLine email={author} mobile={mobile} /> : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-[0.55rem]">
                      <Badge tone={getPortForwardTransportTone(portForwardLifecycleMetadata.transport)}>
                        {getPortForwardTransportLabel(portForwardLifecycleMetadata.transport)}
                      </Badge>
                      <Badge tone={getPortForwardStatusTone(portForwardLifecycleMetadata.status)}>
                        {getPortForwardStatusLabel(portForwardLifecycleMetadata.status)}
                      </Badge>
                    </div>
                  </div>
                  <div className="mt-[0.9rem] grid gap-[0.7rem] md:grid-cols-3">
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.forwardStarted')}</span>
                      <strong>{formatLogTimestamp(portForwardLifecycleMetadata.startedAt)}</strong>
                    </div>
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.forwardEnded')}</span>
                      <strong>{formatLifecycleEnd(portForwardLifecycleMetadata.stoppedAt, portForwardLifecycleMetadata.status === 'running', translate('logs.field.forwarding'))}</strong>
                    </div>
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.heldFor')}</span>
                      <strong>{formatLifecycleDuration(portForwardLifecycleMetadata.durationMs, portForwardLifecycleMetadata.stoppedAt, portForwardLifecycleMetadata.status === 'running')}</strong>
                    </div>
                  </div>
                  {portForwardLifecycleMetadata.endReason ? (
                    <div className="mt-[0.7rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] px-[0.9rem] py-[0.7rem] text-[0.9rem] text-[var(--text-soft)]">{portForwardLifecycleMetadata.endReason}</div>
                  ) : null}
                </CardMain>
              </Card>
            ) : (
              <Card key={log.id}>
                <CardMain>
                  <div className="flex flex-wrap items-center gap-[0.7rem]">
                    <strong>{resolveLogMessage(log, translate)}</strong>
                    <Badge tone={log.level === 'error' ? 'error' : log.level === 'warn' ? 'starting' : 'running'}>
                      {log.level.toUpperCase()}
                    </Badge>
                  </div>
                  <div className="mt-[0.4rem] flex flex-wrap gap-[0.9rem] text-[0.9rem] text-[var(--text-soft)]">
                    <span>{log.category}</span>
                    <span>{formatLogTimestamp(log.createdAt)}</span>
                  </div>
                  {author ? <AuthorLine email={author} mobile={mobile} /> : null}
                  {log.metadata ? (
                    <details className="mt-[0.7rem] rounded-[10px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <summary>Metadata</summary>
                      <pre className="mt-[0.55rem] overflow-x-auto whitespace-pre-wrap break-words rounded-[10px] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] px-3 py-3 text-[0.82rem] leading-[1.55]">{JSON.stringify(log.metadata, null, 2)}</pre>
                    </details>
                  ) : null}
                </CardMain>
              </Card>
            );
          })
        )}
        {!showChanges && keepLoading ? (
          <div ref={loadMoreRef} data-logs-load-more className="py-3 text-center text-[0.85rem] text-[var(--text-soft)]">
            {teamActivity.loading && visibleLogs.length > 0 ? translate('teamLogs.loading') : null}
          </div>
        ) : null}
      </PanelSection>

      <LogsRangePickerDialog
        open={periodPickerOpen}
        mode={period.mode === 'absolute' ? 'absolute' : 'recent'}
        absoluteValue={period.mode === 'absolute' ? period.absolute : null}
        relativeValue={period.mode === 'recent' ? period.relative : DEFAULT_RECENT_PERIOD}
        onClose={() => setPeriodPickerOpen(false)}
        onApply={(mode, absolute, relative) => {
          setPeriod(
            mode === 'absolute' && absolute
              ? { mode: 'absolute', absolute }
              : relative
                ? { mode: 'recent', relative }
                : { mode: 'all' }
          );
          setPeriodPickerOpen(false);
        }}
        resetLabel={translate('logs.period.all')}
        hints={{ relative: translate('logs.period.relativeHint'), absolute: translate('logs.period.absoluteHint') }}
        onReset={() => {
          setPeriod({ mode: 'all' });
          setPeriodPickerOpen(false);
        }}
      />
    </div>
  );
}
