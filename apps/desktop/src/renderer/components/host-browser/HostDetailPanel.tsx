import { useEffect, useMemo, useState } from 'react';
import {
  getHostBadgeLabel,
  isAwsEc2HostRecord,
  isAwsEcsHostRecord,
  isSshHostRecord,
  normalizeGroupPath,
} from '@shared';
import type {
  ActivityLogRecord,
  HostEnvVar,
  HostRecord,
  HostStartupCommand,
  SecretMetadataRecord,
  SnippetRecord,
  SshHostRecord,
} from '@shared';
import { cn } from '../../lib/cn';
import { Button } from '../../ui';
import {
  Columns2,
  Container,
  Download,
  Eye,
  EyeOff,
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
import { terminalThemePresets } from '../../lib/terminal-presets';
import { getHostAddress, getHostRegion, getHostTypeLabel } from './hostDisplay';
import type { HostBrowserModel } from './useHostBrowser';
import { useTranslation } from 'react-i18next';
import { getFormatLocale, t } from '../../i18n';
import { resolveLogMessage } from '../../lib/activity-log-message';

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
  // 7일 넘은 과거는 절대 일시로 표시한다(날짜만이 아니라 시각까지 포함).
  return new Date(timestamp).toLocaleString(getFormatLocale(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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
function getConnectionKindLabel(kind?: string): string {
  switch (kind) {
    case 'local':
      return 'Local';
    case 'ssh':
      return 'SSH';
    case 'mosh':
      return 'Mosh';
    case 'aws-ssm':
      return 'AWS SSM';
    case 'aws-ecs-exec':
      return 'AWS ECS Exec';
    case 'warpgate':
      return 'Warpgate';
    case 'serial':
      return 'Serial';
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
  onClick,
  replayRecordingId,
  onOpenReplay,
}: {
  primary: string;
  secondary?: string | null;
  level?: string;
  when: string;
  onClick?: () => void;
  replayRecordingId?: string | null;
  onOpenReplay?: (recordingId: string) => void;
}) {
  const textContent = (
    <span className="flex min-w-0 items-center gap-[0.55rem]">
      <StatusDot level={level} />
      <span className="flex min-w-0 flex-col">
        <span className="min-w-0 truncate text-[0.82rem] font-medium text-[var(--text)]">
          {primary}
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
      <span className="shrink-0 text-[0.76rem] text-[var(--text-soft)]">
        {formatRelativeTime(when)}
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
 * Connection 탭 행 구성: 공통(Type/Address) + kind별 상세 + 시작 명령/터미널 테마를 한 배열로.
 * Address(host:port·IP 등)·Region과 중복되는 필드는 생략한다.
 */
// 호스트가 어떤 자격증명(저장된 시크릿)을 쓰는지 표시. 공유 중이면 호스트 수도 함께 알린다.
function buildCredentialValue(
  host: SshHostRecord,
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

function buildConnectionRows(
  host: HostRecord,
  hosts: HostRecord[],
  snippets: SnippetRecord[] | undefined,
  keychainEntries: SecretMetadataRecord[],
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
    const jumpHostIds = deriveJumpHostIds(host);
    if (jumpHostIds.length > 0) {
      rows.push({
        label: jumpHostIds.length > 1 ? 'Jump Hosts' : 'Jump Host',
        value: (
          <span className="inline-flex flex-wrap items-center justify-end gap-x-1 gap-y-1">
            {jumpHostIds.map((jumpId, index) => {
              const jumpLabel =
                hosts.find((entry) => entry.id === jumpId)?.label ?? jumpId;
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
    if (host.useMosh) {
      rows.push({ label: 'Mosh', value: t('hostDetail.row.enabled') });
    }
    if (host.agentForwarding) {
      rows.push({ label: 'Agent Forwarding', value: t('hostDetail.row.enabled') });
    }
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
 * 환경 변수는 호스트 레코드(host.env)에 저장된다(자격증명과 분리 — 시크릿 공유로 번지지 않음).
 * 구버전 호스트는 env가 시크릿에만 있을 수 있어, host.env가 비면 secretRef로 복호화해 폴백 표시한다.
 * 값에는 토큰/비밀번호가 들어갈 수 있어 기본 마스킹하고, 눈 아이콘으로 펼친다.
 */
function EnvVarsSection({ host }: { host: SshHostRecord }) {
  const { t: translate } = useTranslation();
  const directEnv = host.env ?? [];
  const secretRef = host.secretRef ?? null;
  const [fallbackEnv, setFallbackEnv] = useState<HostEnvVar[]>([]);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (directEnv.length > 0 || !secretRef) {
      setFallbackEnv([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await loadSavedCredential(secretRef);
        if (!cancelled) {
          setFallbackEnv(loaded?.env ?? []);
        }
      } catch {
        if (!cancelled) {
          setFallbackEnv([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [secretRef, directEnv.length]);

  const envVars = directEnv.length > 0 ? directEnv : fallbackEnv;

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
  title: string;
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
  const recentLogs = useMemo(() => {
    const items: Array<{
      id: string;
      hostId: string;
      name: string;
      detail: string;
      when: string;
      level?: string;
      replayRecordingId?: string | null;
    }> = [];
    for (const log of hb.activityLogs ?? []) {
      const hostId = getLogHostId(log);
      if (!hostId) {
        continue;
      }
      const metadata = log.metadata as {
        hostLabel?: string;
        label?: string;
        title?: string;
        connectionKind?: string;
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
        ? getConnectionKindLabel(metadata.connectionKind)
        : resolveLogMessage(log, translate);
      items.push({
        id: log.id,
        hostId,
        name,
        detail,
        when: log.createdAt,
        level: log.level,
        replayRecordingId: getReplayRecordingId(log),
      });
      if (items.length >= 6) {
        break;
      }
    }
    return items;
  }, [hb.activityLogs, hb.hosts]);

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
        <div className="grid grid-cols-3 gap-[0.55rem]">
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

      {recentLogs.length > 0 ? (
        <div className="flex flex-col gap-[0.55rem] pt-[1.3rem]">
          <div className="flex items-center justify-between">
            <span className="text-[0.76rem] font-bold uppercase tracking-[0.1em] text-[var(--text-soft)]">
              {translate('hostDetail.empty.recentLogs')}
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
            {recentLogs.map((item) => (
              <ActivityRow
                key={item.id}
                primary={item.name}
                secondary={item.detail}
                level={item.level}
                when={item.when}
                onClick={() => hb.selectSingleHost(item.hostId)}
                replayRecordingId={item.replayRecordingId}
                onOpenReplay={hb.onOpenReplay}
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

  const hostActivity = useMemo(() => {
    if (!host) {
      return [] as ActivityLogRecord[];
    }
    return (hb.activityLogs ?? [])
      .filter((log) => getLogHostId(log) === host.id)
      .slice(0, 40);
  }, [hb.activityLogs, host]);

  if (!host) {
    return <EmptyDetail hb={hb} tmuxPrefixKey={tmuxPrefixKey} />;
  }

  const isFavorite = favoriteHostIdSet.has(host.id);
  const region = getHostRegion(host);
  const address = getHostAddress(host);
  const group = normalizeGroupPath(host.groupName);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 px-[0.9rem] pb-[0.55rem] pt-[0.9rem]">
        <div className="flex min-w-0 items-center gap-[0.55rem]">
          <span
            className="inline-grid h-[2rem] min-w-[2rem] place-items-center rounded-[10px] bg-[color-mix(in_srgb,var(--accent-strong)_68%,var(--chrome-bg)_32%)] px-[0.4rem] text-[0.7rem] font-bold text-white"
            aria-hidden="true"
          >
            {getHostBadgeLabel(host)}
          </span>
          <h2 className="min-w-0 truncate text-[1rem] font-bold text-[var(--text)]">
            {host.label}
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-[0.25rem]">
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
                {!isAwsEcsHostRecord(host) && hb.onOpenSftp ? (
                  <Button variant="secondary" size="sm" onClick={() => hb.onOpenSftp?.(host.id)}>
                    <Folder className="h-4 w-4" aria-hidden />
                    Open SFTP
                  </Button>
                ) : null}
                {!isAwsEcsHostRecord(host) && hb.onConnectHostTmux ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => hb.onConnectHostTmux?.(host.id)}
                  >
                    <Columns2 className="h-4 w-4" aria-hidden />
                    TMUX Connect
                  </Button>
                ) : null}
                {!isAwsEcsHostRecord(host) ? (
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
                <ActivityList logs={hostActivity.slice(0, 6)} onOpenReplay={hb.onOpenReplay} />
              </SectionCard>
            ) : null}
          </>
        ) : null}

        {activeTab === 'connection' ? (
          <SectionCard title="Connection">
            <div className="divide-y divide-[var(--border)]">
              {buildConnectionRows(host, hosts, hb.snippets, hb.keychainEntries).map((row) => (
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
  logs,
  onOpenReplay,
}: {
  logs: ActivityLogRecord[];
  onOpenReplay?: (recordingId: string) => void;
}) {
  const { t: translate } = useTranslation();
  return (
    <div className="flex flex-col">
      {logs.map((log) => {
        const metadata = log.metadata as {
          connectionKind?: string;
          status?: string;
          disconnectReason?: string;
        } | null;
        const isSession =
          log.kind === 'session-lifecycle' && Boolean(metadata?.connectionKind);
        const isError = isSession && metadata?.status === 'error';
        // 세션 로그: 정상 연결은 타입만(예: SSH), 실패만 "SSH · 연결 실패"로 구분.
        // (정상적으로 닫힌 세션을 "종료"로 표기하면 모든 기록이 종료로 보여 혼란스러움.)
        const primary = isSession
          ? isError
            ? translate('hostDetail.activity.connectFailed', {
                kind: getConnectionKindLabel(metadata?.connectionKind),
              })
            : getConnectionKindLabel(metadata?.connectionKind)
          : resolveLogMessage(log, translate);
        // 실패 사유만 부제로 노출(정상 종료의 기술적 사유는 노이즈라 숨김).
        const secondary = isError ? metadata?.disconnectReason ?? null : null;
        return (
          <ActivityRow
            key={log.id}
            primary={primary}
            secondary={secondary}
            level={log.level}
            when={log.createdAt}
            replayRecordingId={getReplayRecordingId(log)}
            onOpenReplay={onOpenReplay}
          />
        );
      })}
    </div>
  );
}
