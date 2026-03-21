import { useMemo, useState } from 'react';
import Fuse from 'fuse.js';
import type { GroupRecord, HostRecord, TerminalTab } from '@keyterm/shared';

interface HostBrowserProps {
  hosts: HostRecord[];
  groups: GroupRecord[];
  tabs: TerminalTab[];
  currentGroupPath: string | null;
  searchQuery: string;
  selectedHostId: string | null;
  onSearchChange: (query: string) => void;
  onCreateHost: () => void;
  onCreateGroup: (name: string) => Promise<void>;
  onNavigateGroup: (path: string | null) => void;
  onSelectHost: (hostId: string) => void;
  onEditHost: (hostId: string) => void;
  onConnectHost: (hostId: string) => Promise<void>;
  onOpenSession: (sessionId: string) => void;
}

interface GroupCardView {
  path: string;
  name: string;
  hostCount: number;
}

function normalizeGroupPath(groupPath?: string | null): string | null {
  const normalized = (groupPath ?? '')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('/');
  return normalized.length > 0 ? normalized : null;
}

function getParentGroupPath(groupPath?: string | null): string | null {
  const normalized = normalizeGroupPath(groupPath);
  if (!normalized || !normalized.includes('/')) {
    return null;
  }
  return normalized.slice(0, normalized.lastIndexOf('/'));
}

function getGroupLabel(groupPath: string): string {
  const parts = groupPath.split('/');
  return parts[parts.length - 1];
}

function isGroupWithinPath(groupPath: string | null, currentGroupPath: string | null): boolean {
  if (!currentGroupPath) {
    return true;
  }
  if (!groupPath) {
    return false;
  }
  return groupPath === currentGroupPath || groupPath.startsWith(`${currentGroupPath}/`);
}

function isDirectHostChild(host: HostRecord, currentGroupPath: string | null): boolean {
  const hostGroupPath = normalizeGroupPath(host.groupName);
  return hostGroupPath === currentGroupPath;
}

function collectGroupPaths(groups: GroupRecord[], hosts: HostRecord[]): string[] {
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

function buildVisibleGroups(groups: GroupRecord[], hosts: HostRecord[], currentGroupPath: string | null): GroupCardView[] {
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

function findLatestTab(tabs: TerminalTab[], hostId: string): TerminalTab | null {
  const matchingTabs = tabs
    .filter((tab) => tab.hostId === hostId)
    .sort((a, b) => new Date(b.lastEventAt).getTime() - new Date(a.lastEventAt).getTime());
  return matchingTabs[0] ?? null;
}

export function HostBrowser({
  hosts,
  groups,
  tabs,
  currentGroupPath,
  searchQuery,
  selectedHostId,
  onSearchChange,
  onCreateHost,
  onCreateGroup,
  onNavigateGroup,
  onSelectHost,
  onEditHost,
  onConnectHost,
  onOpenSession
}: HostBrowserProps) {
  const [isGroupModalOpen, setIsGroupModalOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [groupError, setGroupError] = useState<string | null>(null);

  // 현재 그룹 안에서는 그 하위 트리만 검색하고, 루트에서는 전체 호스트를 그대로 보여준다.
  const scopedHosts = useMemo(
    () => hosts.filter((host) => isGroupWithinPath(normalizeGroupPath(host.groupName), currentGroupPath)),
    [currentGroupPath, hosts]
  );

  const fuse = useMemo(
    () =>
      new Fuse(scopedHosts, {
        keys: ['label', 'hostname', 'username', 'groupName'],
        threshold: 0.32
      }),
    [scopedHosts]
  );

  const visibleHosts = useMemo(() => {
    if (searchQuery) {
      return fuse.search(searchQuery).map((result) => result.item);
    }
    if (!currentGroupPath) {
      return scopedHosts;
    }
    return scopedHosts.filter((host) => isDirectHostChild(host, currentGroupPath));
  }, [currentGroupPath, fuse, scopedHosts, searchQuery]);

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

  return (
    <div className="host-browser">
      <div className="home-toolbar">
        <div className="search-panel">
          <label className="search-panel__label" htmlFor="host-search">
            Quick Connect
          </label>
          <input
            id="host-search"
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Find a host or ssh user@hostname..."
            aria-label="Search hosts"
          />
        </div>
        <div className="home-toolbar__actions">
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

      <div className="host-browser__breadcrumbs">
        <button type="button" className={`host-browser__breadcrumb ${currentGroupPath ? '' : 'active'}`} onClick={() => onNavigateGroup(null)}>
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

      <div className="browser-section">
        <div className="browser-section__header">
          <div>
            <div className="section-kicker">Groups</div>
            <h2>{currentGroupPath ? `${getGroupLabel(currentGroupPath)} / Subgroups` : 'Collections'}</h2>
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
                className="group-card group-card--interactive"
                onClick={() => onNavigateGroup(group.path)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
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
            <div className="section-kicker">Hosts</div>
            <h2>{currentGroupPath ? `${getGroupLabel(currentGroupPath)} / Connections` : 'Browse Connections'}</h2>
          </div>
        </div>
        <div className="host-grid">
          {visibleHosts.length === 0 ? (
            <div className="empty-callout">
              <strong>{emptyMessage}</strong>
              <p>
                {hosts.length === 0
                  ? 'New Host를 눌러 첫 번째 SSH 연결 대상을 등록해보세요.'
                  : searchQuery
                    ? '검색어를 지우거나 다른 호스트명으로 다시 찾아보세요.'
                    : 'New Host를 눌러 이 위치에 호스트를 추가하거나, 다른 그룹으로 이동해 장치를 확인해보세요.'}
              </p>
            </div>
          ) : (
            visibleHosts.map((host) => {
              const currentTab = findLatestTab(tabs, host.id);

              return (
                <article
                  key={host.id}
                  className={`host-browser-card ${selectedHostId === host.id ? 'active' : ''}`}
                  onClick={() => onSelectHost(host.id)}
                  onDoubleClick={async () => {
                    if (currentTab) {
                      onOpenSession(currentTab.sessionId);
                      return;
                    }
                    await onConnectHost(host.id);
                  }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void (async () => {
                        if (currentTab) {
                          onOpenSession(currentTab.sessionId);
                          return;
                        }
                        await onConnectHost(host.id);
                      })();
                    }
                  }}
                >
                  <div className="host-browser-card__icon">{host.authType === 'privateKey' ? 'K' : 'S'}</div>
                  <div className="host-browser-card__meta">
                    <strong>{host.label}</strong>
                    <span>
                      {host.username}@{host.hostname}:{host.port}
                    </span>
                    <small>{normalizeGroupPath(host.groupName) ?? 'Ungrouped'}</small>
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

      {isGroupModalOpen ? (
        <div className="home-modal-backdrop" role="presentation">
          <div className="home-modal" role="dialog" aria-modal="true" aria-labelledby="new-group-title">
            <div className="section-kicker">Create</div>
            <h3 id="new-group-title">New Group</h3>
            <p className="home-modal__description">
              {currentGroupPath ? `"${getGroupLabel(currentGroupPath)}" 안에 새 그룹을 만듭니다.` : '루트 위치에 새 그룹을 만듭니다.'}
            </p>
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
