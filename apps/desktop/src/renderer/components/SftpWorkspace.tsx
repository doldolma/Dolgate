import { useMemo, useState } from 'react';
import {
  buildVisibleGroups,
  filterHostsInGroupTree,
  getHostBadgeLabel,
  getHostSearchText,
  getHostSubtitle,
  isSshHostRecord,
  normalizeGroupPath
} from '@shared';
import type { FileEntry, GroupRecord, HostRecord, SftpPaneId, SshHostRecord, TransferJob } from '@shared';
import type { PendingConflictDialog, SftpPaneState, SftpSourceKind, SftpState } from '../store/createAppStore';

interface SftpWorkspaceProps {
  hosts: HostRecord[];
  groups: GroupRecord[];
  sftp: SftpState;
  onActivatePaneSource: (paneId: SftpPaneId, sourceKind: SftpSourceKind) => Promise<void>;
  onPaneFilterChange: (paneId: SftpPaneId, query: string) => void;
  onHostSearchChange: (paneId: SftpPaneId, query: string) => void;
  onNavigateHostGroup: (paneId: SftpPaneId, path: string | null) => void;
  onSelectHost: (paneId: SftpPaneId, hostId: string) => void;
  onConnectHost: (paneId: SftpPaneId, hostId: string) => Promise<void>;
  onOpenEntry: (paneId: SftpPaneId, entryPath: string) => Promise<void>;
  onRefreshPane: (paneId: SftpPaneId) => Promise<void>;
  onNavigateBack: (paneId: SftpPaneId) => Promise<void>;
  onNavigateForward: (paneId: SftpPaneId) => Promise<void>;
  onNavigateParent: (paneId: SftpPaneId) => Promise<void>;
  onNavigateBreadcrumb: (paneId: SftpPaneId, nextPath: string) => Promise<void>;
  onSelectEntry: (paneId: SftpPaneId, entryPath: string) => void;
  onCreateDirectory: (paneId: SftpPaneId, name: string) => Promise<void>;
  onRenameSelection: (paneId: SftpPaneId, nextName: string) => Promise<void>;
  onDeleteSelection: (paneId: SftpPaneId) => Promise<void>;
  onPrepareTransfer: (sourcePaneId: SftpPaneId, targetPaneId: SftpPaneId, targetPath: string, draggedPath: string) => Promise<void>;
  onResolveConflict: (resolution: 'overwrite' | 'skip' | 'keepBoth') => Promise<void>;
  onDismissConflict: () => void;
  onCancelTransfer: (jobId: string) => Promise<void>;
  onRetryTransfer: (jobId: string) => Promise<void>;
}

type ActionDialogState =
  | {
      paneId: SftpPaneId;
      mode: 'mkdir';
      title: string;
      placeholder: string;
      submitLabel: string;
      value: string;
    }
  | {
      paneId: SftpPaneId;
      mode: 'rename';
      title: string;
      placeholder: string;
      submitLabel: string;
      value: string;
    };

export function groupHosts(hosts: SshHostRecord[]): Array<[string, SshHostRecord[]]> {
  const grouped = new Map<string, SshHostRecord[]>();
  for (const host of hosts) {
    const key = host.groupName || 'Ungrouped';
    const bucket = grouped.get(key) ?? [];
    bucket.push(host);
    grouped.set(key, bucket);
  }
  return Array.from(grouped.entries()).sort(([a], [b]) => a.localeCompare(b));
}

export function hostPickerBreadcrumbs(groupPath: string | null): Array<{ label: string; path: string | null }> {
  const normalizedPath = normalizeGroupPath(groupPath);
  if (!normalizedPath) {
    return [{ label: 'Hosts', path: null }];
  }
  const segments = normalizedPath.split('/');
  return [
    { label: 'Hosts', path: null },
    ...segments.map((segment, index) => ({
      label: segment,
      path: segments.slice(0, index + 1).join('/')
    }))
  ];
}

export function visibleHostPickerHosts(hosts: SshHostRecord[], groupPath: string | null, query: string): SshHostRecord[] {
  const scopedHosts = filterHostsInGroupTree(hosts, groupPath);
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery) {
    return scopedHosts.filter((host) => getHostSearchText(host).join(' ').toLowerCase().includes(normalizedQuery));
  }
  return scopedHosts;
}

export function getSftpPaneTitle(pane: Pick<SftpPaneState, 'sourceKind' | 'endpoint'>): string {
  return pane.sourceKind === 'local' ? 'Local' : pane.endpoint?.title ?? 'Host';
}

export function visibleEntries(pane: SftpPaneState): FileEntry[] {
  if (!pane.filterQuery.trim()) {
    return pane.entries;
  }
  const query = pane.filterQuery.trim().toLowerCase();
  return pane.entries.filter((entry) => entry.name.toLowerCase().includes(query));
}

export function breadcrumbParts(targetPath: string): Array<{ label: string; path: string }> {
  if (!targetPath || targetPath === '/') {
    return [{ label: '/', path: '/' }];
  }
  const parts = targetPath.split('/').filter(Boolean);
  const result: Array<{ label: string; path: string }> = [{ label: '/', path: '/' }];
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    result.push({
      label: part,
      path: current
    });
  }
  return result;
}

function formatSize(size: number): string {
  if (!size) {
    return '--';
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '--';
  }
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
}

function buildTransferDirection(job: TransferJob): string {
  return `${job.sourceLabel} -> ${job.targetLabel}`;
}

interface PaneBrowserProps {
  pane: SftpPaneState;
  onActivatePaneSource: (sourceKind: SftpSourceKind) => Promise<void>;
  onFilterChange: (query: string) => void;
  onNavigateBack: () => Promise<void>;
  onNavigateForward: () => Promise<void>;
  onNavigateParent: () => Promise<void>;
  onNavigateBreadcrumb: (nextPath: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onSelectEntry: (entryPath: string) => void;
  onOpenEntry: (entryPath: string) => Promise<void>;
  onOpenCreateDirectoryDialog: () => void;
  onOpenRenameDialog: () => void;
  onDeleteSelection: () => Promise<void>;
  onPrepareTransfer: (targetPath: string, draggedPath: string) => Promise<void>;
}

function PaneBrowser({
  pane,
  onActivatePaneSource,
  onFilterChange,
  onNavigateBack,
  onNavigateForward,
  onNavigateParent,
  onNavigateBreadcrumb,
  onRefresh,
  onSelectEntry,
  onOpenEntry,
  onOpenCreateDirectoryDialog,
  onOpenRenameDialog,
  onDeleteSelection,
  onPrepareTransfer
}: PaneBrowserProps) {
  const entries = useMemo(() => visibleEntries(pane), [pane]);

  return (
    <div className="sftp-pane__content">
      <div className="sftp-pane__toolbar">
        <div className="sftp-source-toggle">
          <button type="button" className={pane.sourceKind === 'local' ? 'active' : ''} onClick={() => void onActivatePaneSource('local')}>
            Local
          </button>
          <button type="button" className={pane.sourceKind === 'host' ? 'active' : ''} onClick={() => void onActivatePaneSource('host')}>
            Host
          </button>
        </div>
        <div className="sftp-pane__toolbar-actions">
          <button type="button" className="icon-button sftp-mini-button" onClick={() => void onNavigateBack()} disabled={pane.historyIndex <= 0}>
            ←
          </button>
          <button
            type="button"
            className="icon-button sftp-mini-button"
            onClick={() => void onNavigateForward()}
            disabled={pane.historyIndex >= pane.history.length - 1}
          >
            →
          </button>
          <button type="button" className="icon-button sftp-mini-button" onClick={() => void onNavigateParent()}>
            ↑
          </button>
          <button
            type="button"
            className="secondary-button sftp-action-button"
            onClick={onOpenCreateDirectoryDialog}
            disabled={pane.isLoading}
          >
            새 폴더
          </button>
          <button
            type="button"
            className="secondary-button sftp-action-button"
            onClick={onOpenRenameDialog}
            disabled={pane.selectedPaths.length !== 1 || pane.isLoading}
          >
            이름 변경
          </button>
          <button
            type="button"
            className="secondary-button sftp-action-button"
            onClick={() => void onDeleteSelection()}
            disabled={pane.selectedPaths.length === 0 || pane.isLoading}
          >
            삭제
          </button>
          <button type="button" className="secondary-button sftp-action-button" onClick={() => void onRefresh()} disabled={pane.isLoading}>
            {pane.isLoading ? '새로고침 중...' : '새로고침'}
          </button>
        </div>
      </div>

      <div className="sftp-breadcrumbs">
        {breadcrumbParts(pane.currentPath).map((part) => (
          <button key={part.path} type="button" className="sftp-breadcrumb" onClick={() => void onNavigateBreadcrumb(part.path)}>
            {part.label}
          </button>
        ))}
      </div>

      <div className="sftp-filter-row">
        <input value={pane.filterQuery} onChange={(event) => onFilterChange(event.target.value)} placeholder="Filter" aria-label="Filter files" />
      </div>

      {pane.warningMessages && pane.warningMessages.length > 0 ? (
        <div className="sftp-pane__warnings">
          {pane.warningMessages.map((warning) => (
            <div key={warning} className="terminal-warning-banner">
              {warning}
            </div>
          ))}
        </div>
      ) : null}

      {pane.errorMessage ? <div className="terminal-error-banner">{pane.errorMessage}</div> : null}

      <div
        className={`sftp-table-shell ${pane.isLoading ? 'loading' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          const payload = event.dataTransfer.getData('application/x-dolssh-transfer');
          if (!payload) {
            return;
          }
          const parsed = JSON.parse(payload) as { sourcePaneId: SftpPaneId; draggedPath: string };
          if (parsed.sourcePaneId === pane.id) {
            return;
          }
          void onPrepareTransfer(pane.currentPath, parsed.draggedPath);
        }}
      >
        <table className="sftp-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Date Modified</th>
              <th>Size</th>
              <th>Kind</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr
                key={entry.path}
                className={pane.selectedPaths.includes(entry.path) ? 'selected' : ''}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData(
                    'application/x-dolssh-transfer',
                    JSON.stringify({
                      sourcePaneId: pane.id,
                      draggedPath: entry.path
                    })
                  );
                }}
                onClick={() => onSelectEntry(entry.path)}
                onDoubleClick={() => void onOpenEntry(entry.path)}
                onDragOver={(event) => {
                  if (entry.isDirectory) {
                    event.preventDefault();
                  }
                }}
                onDrop={(event) => {
                  if (!entry.isDirectory) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  const payload = event.dataTransfer.getData('application/x-dolssh-transfer');
                  if (!payload) {
                    return;
                  }
                  const parsed = JSON.parse(payload) as { sourcePaneId: SftpPaneId; draggedPath: string };
                  if (parsed.sourcePaneId === pane.id) {
                    return;
                  }
                  void onPrepareTransfer(entry.path, parsed.draggedPath);
                }}
              >
                <td>
                  <div className="sftp-entry-name">
                    <span className={`sftp-entry-icon ${entry.isDirectory ? 'directory' : 'file'}`}>{entry.isDirectory ? 'D' : 'F'}</span>
                    <span>{entry.name}</span>
                  </div>
                </td>
                <td>{formatDate(entry.mtime)}</td>
                <td>{entry.isDirectory ? '--' : formatSize(entry.size)}</td>
                <td>{entry.kind}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {pane.isLoading ? <div className="sftp-loading-indicator">목록을 새로 읽는 중...</div> : null}
      </div>
    </div>
  );
}

interface HostPickerProps {
  pane: SftpPaneState;
  groups: GroupRecord[];
  hosts: SshHostRecord[];
  onActivatePaneSource: (sourceKind: SftpSourceKind) => Promise<void>;
  onHostSearchChange: (query: string) => void;
  onNavigateHostGroup: (path: string | null) => void;
  onSelectHost: (hostId: string) => void;
  onConnectHost: (hostId: string) => Promise<void>;
}

function HostPicker({
  pane,
  groups,
  hosts,
  onActivatePaneSource,
  onHostSearchChange,
  onNavigateHostGroup,
  onSelectHost,
  onConnectHost
}: HostPickerProps) {
  const scopedHosts = useMemo(() => filterHostsInGroupTree(hosts, pane.hostGroupPath), [hosts, pane.hostGroupPath]);
  const visibleGroups = useMemo(() => buildVisibleGroups(groups, scopedHosts, pane.hostGroupPath), [groups, pane.hostGroupPath, scopedHosts]);
  const visibleHosts = useMemo(() => visibleHostPickerHosts(hosts, pane.hostGroupPath, pane.hostSearchQuery), [hosts, pane.hostGroupPath, pane.hostSearchQuery]);
  const breadcrumbs = useMemo(() => hostPickerBreadcrumbs(pane.hostGroupPath), [pane.hostGroupPath]);
  const isEmpty = visibleGroups.length === 0 && visibleHosts.length === 0;

  return (
    <div className="sftp-pane__content sftp-host-picker">
      <div className="sftp-pane__toolbar">
        <div className="sftp-source-toggle">
          <button type="button" className={pane.sourceKind === 'local' ? 'active' : ''} onClick={() => void onActivatePaneSource('local')}>
            Local
          </button>
          <button type="button" className={pane.sourceKind === 'host' ? 'active' : ''} onClick={() => void onActivatePaneSource('host')}>
            Host
          </button>
        </div>
      </div>

      <div className="search-panel">
        <input
          id={`${pane.id}-host-search`}
          value={pane.hostSearchQuery}
          onChange={(event) => onHostSearchChange(event.target.value)}
          aria-label="Search hosts"
          placeholder="Search hosts..."
        />
      </div>

      {breadcrumbs.length > 0 ? (
        <div className="host-browser__breadcrumbs">
          {breadcrumbs.map((crumb) => (
            <button
              key={crumb.path ?? 'root'}
              type="button"
              className={`host-browser__breadcrumb ${crumb.path === pane.hostGroupPath ? 'active' : ''}`}
              onClick={() => onNavigateHostGroup(crumb.path)}
            >
              {crumb.label}
            </button>
          ))}
        </div>
      ) : null}

      {visibleGroups.length > 0 ? (
        <div className="group-grid">
          {visibleGroups.map((group) => (
            <article
              key={group.path}
              className="group-card group-card--interactive"
              onClick={() => onNavigateHostGroup(group.path)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onNavigateHostGroup(group.path);
                }
              }}
            >
              <div className="group-card__icon">{group.name.slice(0, 1).toUpperCase()}</div>
              <div>
                <strong>{group.name}</strong>
                <span>{group.hostCount} hosts</span>
              </div>
            </article>
          ))}
        </div>
      ) : null}

      <div className="host-grid">
        {isEmpty ? (
          <div className="empty-callout">
            <strong>{hosts.length === 0 ? '표시할 SSH 호스트가 없습니다.' : pane.hostSearchQuery ? '검색 결과가 없습니다.' : '이 위치에는 아직 SSH 호스트가 없습니다.'}</strong>
            <p>
              {hosts.length === 0
                ? 'Home에서 SSH 호스트를 추가한 뒤 다시 확인해보세요.'
                : pane.hostSearchQuery
                  ? '검색어를 지우거나 다른 이름으로 다시 찾아보세요.'
                  : '다른 그룹으로 이동하거나 Home에서 호스트 구성을 확인해보세요.'}
            </p>
          </div>
        ) : (
          visibleHosts.map((host) => (
            <article
              key={host.id}
              className={`host-browser-card ${pane.selectedHostId === host.id ? 'active' : ''}`}
              onClick={() => onSelectHost(host.id)}
              onDoubleClick={() => void onConnectHost(host.id)}
            >
              <div className="host-browser-card__icon">{getHostBadgeLabel(host)}</div>
              <div className="host-browser-card__meta">
                <strong>{host.label}</strong>
                <span>{getHostSubtitle(host)}</span>
                <small>{host.groupName || 'Ungrouped'}</small>
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}

function TransferBar({
  transfers,
  onCancelTransfer,
  onRetryTransfer
}: {
  transfers: TransferJob[];
  onCancelTransfer: (jobId: string) => Promise<void>;
  onRetryTransfer: (jobId: string) => Promise<void>;
}) {
  if (transfers.length === 0) {
    return null;
  }

  return (
    <div className="sftp-transfer-bar">
      {transfers.slice(0, 6).map((job) => {
        const progress = job.bytesTotal > 0 ? Math.min(100, Math.round((job.bytesCompleted / job.bytesTotal) * 100)) : 0;
        return (
          <article key={job.id} className={`transfer-card ${job.status}`}>
            <div className="transfer-card__top">
              <strong>{job.activeItemName || buildTransferDirection(job)}</strong>
              <span>{job.status}</span>
            </div>
            <div className="transfer-card__meta">
              <span>{buildTransferDirection(job)}</span>
              <span>{job.bytesTotal > 0 ? `${progress}%` : '--'}</span>
            </div>
            <div className="transfer-card__progress">
              <div style={{ width: `${progress}%` }} />
            </div>
            <div className="transfer-card__actions">
              <span>
                {formatSize(job.bytesCompleted)} / {formatSize(job.bytesTotal)}
              </span>
              {job.status === 'running' ? (
                <button type="button" className="secondary-button sftp-inline-button" onClick={() => void onCancelTransfer(job.id)}>
                  취소
                </button>
              ) : null}
              {job.status === 'failed' ? (
                <button type="button" className="secondary-button sftp-inline-button" onClick={() => void onRetryTransfer(job.id)}>
                  재시도
                </button>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function ConflictDialog({
  pendingConflictDialog,
  onResolveConflict,
  onDismissConflict
}: {
  pendingConflictDialog: PendingConflictDialog | null;
  onResolveConflict: (resolution: 'overwrite' | 'skip' | 'keepBoth') => Promise<void>;
  onDismissConflict: () => void;
}) {
  if (!pendingConflictDialog) {
    return null;
  }

  return (
    <div className="sftp-modal-backdrop" role="presentation">
      <div className="sftp-modal">
        <div className="section-kicker">Conflict</div>
        <h3>같은 이름의 파일이 이미 존재합니다</h3>
        <p>{pendingConflictDialog.names.join(', ')}</p>
        <div className="sftp-modal__actions">
          <button type="button" className="secondary-button" onClick={onDismissConflict}>
            취소
          </button>
          <button type="button" className="secondary-button" onClick={() => void onResolveConflict('skip')}>
            건너뛰기
          </button>
          <button type="button" className="secondary-button" onClick={() => void onResolveConflict('keepBoth')}>
            이름 바꿔 저장
          </button>
          <button type="button" className="primary-button" onClick={() => void onResolveConflict('overwrite')}>
            덮어쓰기
          </button>
        </div>
      </div>
    </div>
  );
}

function ActionDialog({
  dialog,
  onChange,
  onClose,
  onSubmit
}: {
  dialog: ActionDialogState | null;
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => Promise<void>;
}) {
  if (!dialog) {
    return null;
  }

  return (
    <div className="sftp-modal-backdrop" role="presentation">
      <div className="sftp-modal">
        <div className="section-kicker">{dialog.mode === 'mkdir' ? 'New Folder' : 'Rename'}</div>
        <h3>{dialog.title}</h3>
        <input value={dialog.value} onChange={(event) => onChange(event.target.value)} placeholder={dialog.placeholder} autoFocus />
        <div className="sftp-modal__actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            취소
          </button>
          <button type="button" className="primary-button" onClick={() => void onSubmit()} disabled={!dialog.value.trim()}>
            {dialog.submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function SftpWorkspace({
  hosts,
  groups,
  sftp,
  onActivatePaneSource,
  onPaneFilterChange,
  onHostSearchChange,
  onNavigateHostGroup,
  onSelectHost,
  onConnectHost,
  onOpenEntry,
  onRefreshPane,
  onNavigateBack,
  onNavigateForward,
  onNavigateParent,
  onNavigateBreadcrumb,
  onSelectEntry,
  onCreateDirectory,
  onRenameSelection,
  onDeleteSelection,
  onPrepareTransfer,
  onResolveConflict,
  onDismissConflict,
  onCancelTransfer,
  onRetryTransfer
}: SftpWorkspaceProps) {
  const [actionDialog, setActionDialog] = useState<ActionDialogState | null>(null);
  const panes = [sftp.leftPane, sftp.rightPane] as const;
  const sshHosts = useMemo(
    () =>
      hosts.filter(
        (host): host is SshHostRecord =>
          isSshHostRecord(host) ||
          ('hostname' in host && typeof host.hostname === 'string' && 'port' in host && typeof host.port === 'number' && 'username' in host && typeof host.username === 'string')
      ),
    [hosts]
  );

  return (
    <div className="sftp-workspace">
      <div className="sftp-workspace__panes">
        {panes.map((pane) => {
          const targetPaneId = pane.id === 'left' ? 'right' : 'left';
          const connectActions = {
            onActivatePaneSource: (sourceKind: SftpSourceKind) => onActivatePaneSource(pane.id, sourceKind)
          };

          return (
            <section key={pane.id} className="sftp-pane">
              <header className="sftp-pane__header">
                <div>
                  <h2>{getSftpPaneTitle(pane)}</h2>
                </div>
              </header>

              {pane.sourceKind === 'host' && !pane.endpoint ? (
                <HostPicker
                  pane={pane}
                  groups={groups}
                  hosts={sshHosts}
                  onActivatePaneSource={connectActions.onActivatePaneSource}
                  onHostSearchChange={(query) => onHostSearchChange(pane.id, query)}
                  onNavigateHostGroup={(path) => onNavigateHostGroup(pane.id, path)}
                  onSelectHost={(hostId) => onSelectHost(pane.id, hostId)}
                  onConnectHost={(hostId) => onConnectHost(pane.id, hostId)}
                />
              ) : (
                <PaneBrowser
                  pane={pane}
                  onActivatePaneSource={connectActions.onActivatePaneSource}
                  onFilterChange={(query) => onPaneFilterChange(pane.id, query)}
                  onNavigateBack={() => onNavigateBack(pane.id)}
                  onNavigateForward={() => onNavigateForward(pane.id)}
                  onNavigateParent={() => onNavigateParent(pane.id)}
                  onNavigateBreadcrumb={(nextPath) => onNavigateBreadcrumb(pane.id, nextPath)}
                  onRefresh={() => onRefreshPane(pane.id)}
                  onSelectEntry={(entryPath) => onSelectEntry(pane.id, entryPath)}
                  onOpenEntry={(entryPath) => onOpenEntry(pane.id, entryPath)}
                  onOpenCreateDirectoryDialog={() => {
                    setActionDialog({
                      paneId: pane.id,
                      mode: 'mkdir',
                      title: '새 폴더 이름',
                      placeholder: '예: uploads',
                      submitLabel: '생성',
                      value: ''
                    });
                  }}
                  onOpenRenameDialog={() => {
                    const selected = pane.entries.find((entry) => pane.selectedPaths.includes(entry.path));
                    if (!selected) {
                      return;
                    }
                    setActionDialog({
                      paneId: pane.id,
                      mode: 'rename',
                      title: '이름 변경',
                      placeholder: '새 이름',
                      submitLabel: '변경',
                      value: selected.name
                    });
                  }}
                  onDeleteSelection={async () => {
                    if (pane.selectedPaths.length === 0) {
                      return;
                    }
                    if (!window.confirm('선택한 항목을 삭제할까요?')) {
                      return;
                    }
                    await onDeleteSelection(pane.id);
                  }}
                  onPrepareTransfer={(targetPath, draggedPath) => onPrepareTransfer(targetPaneId, pane.id, targetPath, draggedPath)}
                />
              )}
            </section>
          );
        })}
      </div>

      <TransferBar transfers={sftp.transfers} onCancelTransfer={onCancelTransfer} onRetryTransfer={onRetryTransfer} />

      <ConflictDialog
        pendingConflictDialog={sftp.pendingConflictDialog}
        onResolveConflict={onResolveConflict}
        onDismissConflict={onDismissConflict}
      />

      <ActionDialog
        dialog={actionDialog}
        onChange={(value) => {
          setActionDialog((current) => (current ? { ...current, value } : current));
        }}
        onClose={() => {
          setActionDialog(null);
        }}
        onSubmit={async () => {
          if (!actionDialog?.value.trim()) {
            return;
          }
          if (actionDialog.mode === 'mkdir') {
            await onCreateDirectory(actionDialog.paneId, actionDialog.value.trim());
          } else {
            await onRenameSelection(actionDialog.paneId, actionDialog.value.trim());
          }
          setActionDialog(null);
        }}
      />
    </div>
  );
}
