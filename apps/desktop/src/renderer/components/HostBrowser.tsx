import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import Fuse from 'fuse.js';
import { getHostBadgeLabel, getHostSearchText, getHostSubtitle } from '@shared';
import type { GroupRecord, HostRecord } from '@shared';

interface HostBrowserProps {
  hosts: HostRecord[];
  groups: GroupRecord[];
  currentGroupPath: string | null;
  searchQuery: string;
  selectedHostId: string | null;
  errorMessage?: string | null;
  onSearchChange: (query: string) => void;
  onCreateHost: () => void;
  onOpenAwsImport: () => void;
  onOpenWarpgateImport: () => void;
  onCreateGroup: (name: string) => Promise<void>;
  onNavigateGroup: (path: string | null) => void;
  onSelectHost: (hostId: string) => void;
  onEditHost: (hostId: string) => void;
  onMoveHostToGroup: (hostId: string, groupPath: string | null) => Promise<void>;
  onRemoveHost: (hostId: string) => Promise<void>;
  onConnectHost: (hostId: string) => Promise<void>;
}

interface GroupCardView {
  path: string;
  name: string;
  hostCount: number;
}

export function normalizeGroupPath(groupPath?: string | null): string | null {
  const normalized = (groupPath ?? '')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('/');
  return normalized.length > 0 ? normalized : null;
}

export function getParentGroupPath(groupPath?: string | null): string | null {
  const normalized = normalizeGroupPath(groupPath);
  if (!normalized || !normalized.includes('/')) {
    return null;
  }
  return normalized.slice(0, normalized.lastIndexOf('/'));
}

export function getGroupLabel(groupPath: string): string {
  const parts = groupPath.split('/');
  return parts[parts.length - 1];
}

export function isGroupWithinPath(groupPath: string | null, currentGroupPath: string | null): boolean {
  if (!currentGroupPath) {
    return true;
  }
  if (!groupPath) {
    return false;
  }
  return groupPath === currentGroupPath || groupPath.startsWith(`${currentGroupPath}/`);
}

export function isDirectHostChild(host: HostRecord, currentGroupPath: string | null): boolean {
  const hostGroupPath = normalizeGroupPath(host.groupName);
  return hostGroupPath === currentGroupPath;
}

export function collectGroupPaths(groups: GroupRecord[], hosts: HostRecord[]): string[] {
  const paths = new Set<string>();

  const appendPathWithAncestors = (targetPath?: string | null) => {
    const normalized = normalizeGroupPath(targetPath);
    if (!normalized) {
      return;
    }
    const segments = normalized.split('/');
    for (let index = 0; index < segments.length; index += 1) {
      paths.add(segments.slice(0, index + 1).join('/'));
    }
  };

  for (const group of groups) {
    appendPathWithAncestors(group.path);
  }

  for (const host of hosts) {
    appendPathWithAncestors(host.groupName);
  }

  return [...paths].sort((a, b) => a.localeCompare(b));
}

export function buildVisibleGroups(groups: GroupRecord[], hosts: HostRecord[], currentGroupPath: string | null): GroupCardView[] {
  const explicitGroupMap = new Map(groups.map((group) => [group.path, group]));
  return collectGroupPaths(groups, hosts)
    .filter((groupPath) => getParentGroupPath(groupPath) === currentGroupPath)
    .map((groupPath) => {
      const hostCount = hosts.filter((host) => {
        const hostGroupPath = normalizeGroupPath(host.groupName);
        return Boolean(hostGroupPath && (hostGroupPath === groupPath || hostGroupPath.startsWith(`${groupPath}/`)));
      }).length;
      return {
        path: groupPath,
        name: explicitGroupMap.get(groupPath)?.name ?? getGroupLabel(groupPath),
        hostCount
      };
    });
}

export function HostBrowser({
  hosts,
  groups,
  currentGroupPath,
  searchQuery,
  selectedHostId,
  errorMessage = null,
  onSearchChange,
  onCreateHost,
  onOpenAwsImport,
  onOpenWarpgateImport,
  onCreateGroup,
  onNavigateGroup,
  onSelectHost,
  onEditHost,
  onMoveHostToGroup,
  onRemoveHost,
  onConnectHost
}: HostBrowserProps) {
  const [isGroupModalOpen, setIsGroupModalOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [groupError, setGroupError] = useState<string | null>(null);
  const [selectedGroupPath, setSelectedGroupPath] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ hostId: string; x: number; y: number } | null>(null);
  const [dragTargetGroupPath, setDragTargetGroupPath] = useState<string | null>(null);

  useEffect(() => {
    setSelectedGroupPath(null);
  }, [currentGroupPath]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const close = () => {
      setContextMenu(null);
    };

    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);

    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [contextMenu]);

  // 현재 그룹 안에서는 그 하위 트리만 검색하고, 루트에서는 전체 호스트를 그대로 보여준다.
  const scopedHosts = useMemo(
    () => hosts.filter((host) => isGroupWithinPath(normalizeGroupPath(host.groupName), currentGroupPath)),
    [currentGroupPath, hosts]
  );

  const searchableHosts = useMemo(
    () =>
      scopedHosts.map((host) => ({
        ...host,
        searchText: getHostSearchText(host).join(' ')
      })),
    [scopedHosts]
  );

  const fuse = useMemo(
    () =>
      new Fuse(searchableHosts, {
        keys: ['label', 'groupName', 'searchText'],
        threshold: 0.32
      }),
    [searchableHosts]
  );

  const visibleHosts = useMemo(() => {
    if (searchQuery) {
      return fuse.search(searchQuery).map((result) => {
        const { searchText: _searchText, ...host } = result.item;
        return host;
      });
    }
    if (!currentGroupPath) {
      return searchableHosts;
    }
    return searchableHosts.filter((host) => isDirectHostChild(host, currentGroupPath));
  }, [currentGroupPath, fuse, searchableHosts, searchQuery]);

  const visibleGroups = useMemo(() => buildVisibleGroups(groups, hosts, currentGroupPath), [currentGroupPath, groups, hosts]);
  const breadcrumbs = useMemo(() => {
    if (!currentGroupPath) {
      return [];
    }
    const segments = currentGroupPath.split('/');
    return segments.map((segment, index) => ({
      label: segment,
      path: segments.slice(0, index + 1).join('/')
    }));
  }, [currentGroupPath]);

  const emptyMessage = hosts.length === 0 ? '아직 등록된 호스트가 없습니다.' : searchQuery ? '검색 결과가 없습니다.' : '이 위치에는 아직 호스트가 없습니다.';
  const contextMenuStyle = contextMenu
    ? {
        left: `${Math.max(12, Math.min(contextMenu.x, window.innerWidth - 172))}px`,
        top: `${Math.max(12, Math.min(contextMenu.y, window.innerHeight - 72))}px`
      }
    : null;

  return (
    <div className="host-browser">
      <div className="home-toolbar">
        <div className="search-panel">
          <input
            id="host-search"
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search hosts or instances"
            aria-label="Search hosts"
          />
        </div>
        <div className="home-toolbar__actions">
          <button type="button" className="secondary-button" onClick={onOpenAwsImport}>
            Import from AWS
          </button>
          <button type="button" className="secondary-button" onClick={onOpenWarpgateImport}>
            Import from Warpgate
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setIsGroupModalOpen(true);
              setNewGroupName('');
              setGroupError(null);
            }}
          >
            New Group
          </button>
          <button type="button" className="primary-button" onClick={onCreateHost}>
            New Host
          </button>
        </div>
      </div>

      {errorMessage ? <div className="terminal-error-banner host-browser__error-banner">{errorMessage}</div> : null}

      {breadcrumbs.length > 0 ? (
        <div className="host-browser__breadcrumbs">
          <button type="button" className="host-browser__breadcrumb" onClick={() => onNavigateGroup(null)}>
            Hosts
          </button>
          {breadcrumbs.map((crumb) => (
            <button
              key={crumb.path}
              type="button"
              className={`host-browser__breadcrumb ${crumb.path === currentGroupPath ? 'active' : ''}`}
              onClick={() => onNavigateGroup(crumb.path)}
            >
              {crumb.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="browser-section">
        <div className="browser-section__header">
          <div>
            <h2>Groups</h2>
          </div>
        </div>
        <div className="group-grid">
          {visibleGroups.length === 0 ? (
            <div className="empty-callout">
              <strong>{currentGroupPath ? '이 위치에는 아직 그룹이 없습니다.' : '아직 만든 그룹이 없습니다.'}</strong>
              <p>New Group을 눌러 현재 위치 아래에 첫 번째 그룹을 만들어보세요.</p>
            </div>
          ) : (
            visibleGroups.map((group) => (
              <article
                key={group.path}
                className={`group-card group-card--interactive ${selectedGroupPath === group.path ? 'active' : ''} ${dragTargetGroupPath === group.path ? 'drop-target' : ''}`}
                onClick={() => setSelectedGroupPath(group.path)}
                onDoubleClick={() => onNavigateGroup(group.path)}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  setDragTargetGroupPath(group.path);
                }}
                onDragLeave={(event) => {
                  const nextTarget = event.relatedTarget;
                  if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
                    return;
                  }
                  setDragTargetGroupPath((current) => (current === group.path ? null : current));
                }}
                onDrop={async (event) => {
                  event.preventDefault();
                  const hostId = event.dataTransfer.getData('application/x-dolssh-host-id');
                  setDragTargetGroupPath(null);
                  if (!hostId) {
                    return;
                  }
                  await onMoveHostToGroup(hostId, group.path);
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === ' ') {
                    event.preventDefault();
                    setSelectedGroupPath(group.path);
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    onNavigateGroup(group.path);
                  }
                }}
              >
                <div className="group-card__icon">{group.name.slice(0, 1).toUpperCase()}</div>
                <div>
                  <strong>{group.name}</strong>
                  <span>{group.hostCount} hosts</span>
                </div>
              </article>
            ))
          )}
        </div>
      </div>

      <div className="browser-section">
        <div className="browser-section__header">
          <div>
            <h2>Hosts</h2>
          </div>
        </div>
        <div className="host-grid">
          {visibleHosts.length === 0 ? (
            <div className="empty-callout">
              <strong>{emptyMessage}</strong>
              <p>
                {hosts.length === 0
                  ? 'New Host 또는 Import from AWS/Warpgate를 눌러 첫 번째 연결 대상을 추가해보세요.'
                  : searchQuery
                    ? '검색어를 지우거나 다른 호스트명으로 다시 찾아보세요.'
                    : 'New Host를 눌러 이 위치에 호스트를 추가하거나, 다른 그룹으로 이동해 장치를 확인해보세요.'}
              </p>
            </div>
          ) : (
            visibleHosts.map((host) => {
              return (
                <article
                  key={host.id}
                  className={`host-browser-card ${selectedHostId === host.id ? 'active' : ''}`}
                  draggable
                  onClick={() => {
                    setContextMenu(null);
                    onSelectHost(host.id);
                  }}
                  onDragStart={(event) => {
                    onSelectHost(host.id);
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('application/x-dolssh-host-id', host.id);
                    event.dataTransfer.setData('text/plain', host.label);
                  }}
                  onDragEnd={() => {
                    setDragTargetGroupPath(null);
                  }}
                  onDoubleClick={async () => {
                    await onConnectHost(host.id);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    onSelectHost(host.id);
                    setContextMenu({
                      hostId: host.id,
                      x: event.clientX,
                      y: event.clientY
                    });
                  }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void (async () => {
                        await onConnectHost(host.id);
                      })();
                    }
                  }}
                >
                  <div className="host-browser-card__icon">{getHostBadgeLabel(host)}</div>
                  <div className="host-browser-card__meta">
                    <strong>{host.label}</strong>
                    <span>{getHostSubtitle(host)}</span>
                    <small>{normalizeGroupPath(host.groupName) ?? 'Ungrouped'}</small>
                    {host.tags && host.tags.length > 0 ? (
                      <div className="host-browser-card__tags">
                        {host.tags.map((tag) => (
                          <span key={tag} className="host-browser-card__tag">
                            #{tag}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="host-browser-card__edit"
                    aria-label={`${host.label} 수정`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onEditHost(host.id);
                    }}
                  >
                    ✎
                  </button>
                </article>
              );
            })
          )}
        </div>
      </div>

      {contextMenu ? (
        createPortal(
          <div className="context-menu" style={contextMenuStyle ?? undefined} role="menu">
            <button
              type="button"
              className="context-menu__item context-menu__item--danger"
              onClick={async () => {
                const targetHost = hosts.find((host) => host.id === contextMenu.hostId);
                setContextMenu(null);
                if (!targetHost) {
                  return;
                }
                const confirmed = window.confirm(`"${targetHost.label}" 호스트를 삭제할까요? 연결된 키체인 항목은 유지됩니다.`);
                if (!confirmed) {
                  return;
                }
                await onRemoveHost(targetHost.id);
              }}
            >
              삭제
            </button>
          </div>,
          document.body
        )
      ) : null}

      {isGroupModalOpen ? (
        <div className="home-modal-backdrop" role="presentation">
          <div className="home-modal" role="dialog" aria-modal="true" aria-labelledby="new-group-title">
            <div className="section-kicker">Create</div>
            <h3 id="new-group-title">New Group</h3>
            <input
              value={newGroupName}
              onChange={(event) => {
                setNewGroupName(event.target.value);
                setGroupError(null);
              }}
              placeholder="Group name"
              autoFocus
            />
            {groupError ? <p className="home-modal__error">{groupError}</p> : null}
            <div className="home-modal__actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setIsGroupModalOpen(false);
                  setNewGroupName('');
                  setGroupError(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={async () => {
                  try {
                    await onCreateGroup(newGroupName);
                    setIsGroupModalOpen(false);
                    setNewGroupName('');
                    setGroupError(null);
                  } catch (error) {
                    setGroupError(error instanceof Error ? error.message : '그룹을 만들지 못했습니다.');
                  }
                }}
              >
                Create group
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
