import { useMemo, useState } from 'react';
import type {
  ActivityLogCategory,
  ActivityLogLevel,
  ActivityLogRecord,
  ContainerActionLogMetadata,
  ContainerLifecycleLogMetadata,
  PortForwardLifecycleLogMetadata,
  SessionConnectionKind,
  SessionLifecycleLogMetadata,
  SftpLifecycleLogMetadata,
  PortForwardTransport,
} from '@shared';
import {
  Badge,
  Button,
  Card,
  CardMain,
  EmptyState,
  PanelSection,
  SelectField,
  Toolbar,
} from '../ui';
import { Play } from '../ui/icons';
import { useTranslation } from 'react-i18next';
import { getFormatLocale, t } from '../i18n';
import { resolveLogMessage } from '../lib/activity-log-message';

interface LogsPanelProps {
  logs: ActivityLogRecord[];
  onClear: () => Promise<void>;
  onOpenReplay: (recordingId: string) => Promise<void>;
}

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

function getConnectionKindLabel(kind: SessionConnectionKind): string {
  if (kind === 'local') {
    return 'Local';
  }
  if (kind === 'aws-ssm') {
    return 'AWS SSM';
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
  return 'SSH';
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

export function LogsPanel({ logs, onClear, onOpenReplay }: LogsPanelProps) {
  const { t: translate } = useTranslation();
  const [category, setCategory] = useState<'all' | ActivityLogCategory>('all');
  const [level, setLevel] = useState<'all' | ActivityLogLevel>('all');

  const visibleLogs = useMemo(
    () =>
      logs.filter((log) => {
        if (category !== 'all' && log.category !== category) {
          return false;
        }
        if (level !== 'all' && log.level !== level) {
          return false;
        }
        return true;
      }),
    [category, level, logs]
  );

  return (
    <div className="flex flex-col gap-[1.1rem]">
      {/* 상단 브레드크럼(← Hosts · Logs)에 이미 제목이 있어 Diagnostics/Logs 헤더는 생략.
          Clear logs 버튼은 아래 필터 행 오른쪽으로 옮긴다. */}
      <Toolbar>
        <label className="flex w-full max-w-[220px] flex-col gap-[0.4rem]">
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

        <label className="flex w-full max-w-[220px] flex-col gap-[0.4rem]">
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

        <Button variant="secondary" className="ml-auto" onClick={() => void onClear()}>
          Clear logs
        </Button>
      </Toolbar>

      <PanelSection>
        {visibleLogs.length === 0 ? (
          <EmptyState
            title={translate('logs.empty.title')}
            description={translate('logs.empty.description')}
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
            // 진행 중(connected) 세션은 녹화가 아직 finalize되지 않아 재생 불가 →
            // 종료된 세션(closed/error)만 Replay 버튼을 노출한다.
            const replayRecordingId =
              sessionLifecycleMetadata != null &&
              (sessionLifecycleMetadata.status === 'closed' ||
                sessionLifecycleMetadata.status === 'error') &&
              sessionLifecycleMetadata.hasReplay === true &&
              typeof sessionLifecycleMetadata.recordingId === 'string'
                ? sessionLifecycleMetadata.recordingId
                : null;

            return containerLifecycleMetadata ? (
              <Card key={log.id} data-testid="logs-container-lifecycle-card">
                <CardMain>
                  <div className="flex flex-wrap items-center gap-[0.7rem]">
                    <div>
                      <strong>{containerLifecycleMetadata.hostLabel}</strong>
                      <div className="text-[0.9rem] text-[var(--text-soft)]">
                        {containerLifecycleMetadata.workspaceKind === 'ecs-cluster' ? 'ECS cluster' : 'Host containers'}
                      </div>
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
                      <strong>{containerLifecycleMetadata.endedAt ? formatLogTimestamp(containerLifecycleMetadata.endedAt) : translate('logs.field.connecting')}</strong>
                    </div>
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.heldFor')}</span>
                      <strong>{formatSessionLifecycleDuration(containerLifecycleMetadata.durationMs)}</strong>
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
                    </div>
                    <div className="flex flex-wrap items-center gap-[0.55rem]">
                      <Badge tone={getConnectionKindTone(sessionLifecycleMetadata.connectionKind)}>
                        {getConnectionKindLabel(sessionLifecycleMetadata.connectionKind)}
                      </Badge>
                      <Badge tone={getLifecycleStatusTone(sessionLifecycleMetadata.status)}>
                        {getLifecycleStatusLabel(sessionLifecycleMetadata.status)}
                      </Badge>
                    </div>
                    {/* 유일하게 누를 수 있는 요소라 배지 사이에 끼워 두지 않는다 — 오른쪽 끝
                        액션 자리로 빼고 아이콘을 붙여야 배지와 구분된다(다크 테마에서 특히). */}
                    {sessionLifecycleMetadata.status !== 'connected' && replayRecordingId ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="ml-auto"
                        onClick={() => void onOpenReplay(replayRecordingId)}
                      >
                        <Play className="h-[0.8rem] w-[0.8rem]" aria-hidden />
                        Replay
                      </Button>
                    ) : null}
                  </div>
                  <div className="mt-[0.9rem] grid gap-[0.7rem] md:grid-cols-3">
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.connectStarted')}</span>
                      <strong>{formatLogTimestamp(sessionLifecycleMetadata.connectedAt)}</strong>
                    </div>
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.connectEnded')}</span>
                      <strong>{sessionLifecycleMetadata.disconnectedAt ? formatLogTimestamp(sessionLifecycleMetadata.disconnectedAt) : translate('logs.field.connecting')}</strong>
                    </div>
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.connectDuration')}</span>
                      <strong>{formatSessionLifecycleDuration(sessionLifecycleMetadata.durationMs)}</strong>
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
                      <strong>{sftpLifecycleMetadata.endedAt ? formatLogTimestamp(sftpLifecycleMetadata.endedAt) : translate('logs.field.connecting')}</strong>
                    </div>
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.connectDuration')}</span>
                      <strong>{formatSessionLifecycleDuration(sftpLifecycleMetadata.durationMs)}</strong>
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
                      <strong>{portForwardLifecycleMetadata.stoppedAt ? formatLogTimestamp(portForwardLifecycleMetadata.stoppedAt) : translate('logs.field.forwarding')}</strong>
                    </div>
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.heldFor')}</span>
                      <strong>{formatSessionLifecycleDuration(portForwardLifecycleMetadata.durationMs)}</strong>
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
      </PanelSection>
    </div>
  );
}
