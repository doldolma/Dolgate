import { normalizeGroupPath } from '@shared';
import type { HostRecord } from '@shared';
import { cn } from '../../lib/cn';
import { HostRowBoundary } from './HostRowBoundary';
import { ChevronDown, ChevronUp, MoreVertical, Star } from '../../ui/icons';
import {
  formatLastUsed,
  getHostAddress,
  getHostShortType,
} from './hostDisplay';
import {
  HOST_DRAG_MIME_TYPE,
  HOSTS_DRAG_MIME_TYPE,
  type HostBrowserModel,
} from './useHostBrowser';
import { useTranslation } from 'react-i18next';
import { HostBadge } from './HostBadge';

interface HostListTableProps {
  hb: HostBrowserModel;
}

// 8열: 이름(배지+이름) · 타입 · IP/Host · 그룹 · 태그 · 최근 접속 · 즐겨찾기 · 메뉴.
// minmax(0,*fr)로 좁아져도 넘치지 않고 truncate 되게 한다(가로 스크롤 불필요).
const GRID_TEMPLATE =
  'minmax(0,1.7fr) 56px minmax(0,1.1fr) minmax(0,1.3fr) minmax(0,1fr) 80px 36px 36px';

const MAX_VISIBLE_TAGS = 2;

export function HostListTable({ hb }: HostListTableProps) {
  const { t: translate } = useTranslation();
  const {
    visibleHosts,
    selectedHostId,
    selectedHostIds,
    selectedGroupPaths,
    selectedHostIdSet,
    favoriteHostIdSet,
    sortKey,
    sortDirection,
  } = hb;

  function openHostMenu(host: (typeof visibleHosts)[number], x: number, y: number) {
    const isAlreadySelected = selectedHostIdSet.has(host.id);
    const targetHostIds = isAlreadySelected
      ? hb.getOrderedSelectedHostIds(selectedHostIds)
      : [host.id];
    if (!isAlreadySelected) {
      hb.selectSingleHost(host.id, 'menu');
    }
    hb.setContextMenu({ kind: 'host', hostIds: targetHostIds, x, y });
  }

  function SortHeader({
    label,
    column,
    className,
  }: {
    label: string;
    column: 'name' | 'lastConnected';
    className?: string;
  }) {
    const active = sortKey === column;
    const Arrow = active && sortDirection === 'asc' ? ChevronUp : ChevronDown;
    return (
      <button
        type="button"
        onClick={() => hb.toggleSort(column)}
        className={cn(
          'flex items-center gap-[0.2rem] text-left transition-colors duration-140 hover:text-[var(--text)]',
          active ? 'text-[var(--accent-strong)]' : 'text-[var(--text-soft)]',
          className,
        )}
      >
        {label}
        <Arrow
          className={cn('h-[0.8rem] w-[0.8rem]', active ? 'opacity-100' : 'opacity-40')}
          aria-hidden="true"
        />
      </button>
    );
  }

  return (
    <div className="text-[0.82rem]">
      {/* Header */}
      <div
        role="row"
        className="sticky top-0 z-[1] grid items-center gap-[0.7rem] border-b border-[var(--border)] bg-[var(--surface-strong)] px-[0.6rem] pb-[0.5rem] pt-[0.5rem] text-[0.74rem] font-semibold text-[var(--text-soft)]"
        style={{ gridTemplateColumns: GRID_TEMPLATE }}
      >
        <SortHeader label={translate('hostList.name')} column="name" />
        <span>{translate('hostList.type')}</span>
        <span>IP / Host</span>
        <span>{translate('hostList.group')}</span>
        <span>{translate('hostList.tags')}</span>
        <SortHeader label={translate('hostList.lastConnected')} column="lastConnected" />
        <span className="grid place-items-center" aria-label={translate('hostList.favorite')}>
          <Star className="h-[0.9rem] w-[0.9rem]" />
        </span>
        <span />
      </div>

      {/* Rows */}
      <div className="flex flex-col divide-y divide-[var(--border)]">
        {visibleHosts.map((host) => (
          // 행 하나가 못 그려져도 나머지 목록은 남아야 한다. 행 값을 부모의 map 에서 만들면 그
          // 오류는 부모에서 나므로, 별도 컴포넌트로 빼고 내용을 함수로 넘긴다(HostRowBoundary 참고).
          <HostRowBoundary
            key={host.id}
            host={host}
            render={() => (
              <HostListTableRow
                host={host}
                hb={hb}
                isSelected={
                  selectedHostIdSet.has(host.id) ||
                  (selectedHostIds.length === 0 &&
                    selectedGroupPaths.length === 0 &&
                    selectedHostId === host.id)
                }
                isFavorite={favoriteHostIdSet.has(host.id)}
                isMenuTarget={
                  hb.contextMenu?.kind === 'host' && hb.contextMenu.hostIds.includes(host.id)
                }
                onOpenMenu={openHostMenu}
              />
            )}
          />
        ))}
      </div>
    </div>
  );
}

function HostListTableRow({
  host,
  hb,
  isSelected,
  isFavorite,
  isMenuTarget,
  onOpenMenu,
}: {
  host: HostRecord;
  hb: HostBrowserModel;
  isSelected: boolean;
  isFavorite: boolean;
  /** 지금 열린 메뉴가 이 행을 대상으로 하는가(선택과 다른 표시 — 카드 쪽 주석 참고). */
  isMenuTarget: boolean;
  onOpenMenu: (host: HostRecord, x: number, y: number) => void;
}) {
  const { t: translate } = useTranslation();
  const group = normalizeGroupPath(host.groupName);
  const address = getHostAddress(host);
  const lastUsedAt = hb.lastConnectedByHostId.get(host.id);
  const tags = host.tags ?? [];
  const visibleTags = tags.slice(0, MAX_VISIBLE_TAGS);
  const overflowTagCount = tags.length - visibleTags.length;

  return (
            <div
              data-host-card="true"
              data-host-id={host.id}
              data-host-card-state={isSelected ? 'selected' : 'idle'}
              data-host-menu-target={isMenuTarget ? 'true' : undefined}
              role="button"
              tabIndex={0}
              draggable
              className={cn(
                'grid cursor-pointer items-center gap-[0.7rem] px-[0.6rem] py-[0.6rem] transition-[background-color] duration-140',
                isSelected
                  ? 'bg-[var(--selection-tint)]'
                  : 'hover:bg-[color-mix(in_srgb,var(--surface-elevated)_70%,transparent_30%)]',
                isMenuTarget &&
                  'ring-2 ring-inset ring-[color-mix(in_srgb,var(--accent-strong)_45%,transparent)]',
              )}
              style={{ gridTemplateColumns: GRID_TEMPLATE }}
              onClick={(event) => hb.handleHostSelection(host.id, event)}
              onDoubleClick={() => {
                void hb.onConnectHost(host.id);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                onOpenMenu(host, event.clientX, event.clientY);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void hb.onConnectHost(host.id);
                }
              }}
              onDragStart={(event) => {
                const nextDraggedHostIds = hb.getNextDraggedHostIds(host);
                if (!hb.selectedHostIdSet.has(host.id)) {
                  hb.selectSingleHost(host.id);
                }
                hb.setDraggedGroupPath(null);
                hb.setDraggedHostIds(nextDraggedHostIds);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData(HOST_DRAG_MIME_TYPE, nextDraggedHostIds[0] ?? host.id);
                event.dataTransfer.setData(
                  HOSTS_DRAG_MIME_TYPE,
                  JSON.stringify(nextDraggedHostIds),
                );
                event.dataTransfer.setData(
                  'text/plain',
                  nextDraggedHostIds.length === 1
                    ? host.label
                    : `${nextDraggedHostIds.length} hosts`,
                );
              }}
              onDragEnd={() => hb.clearDragState()}
            >
              {/* 이름 + 배지 */}
              <span className="flex min-w-0 items-center gap-[0.55rem]">
                {/* 표는 행이 얕아 뱃지도 한 단계 작게 그린다. */}
                <HostBadge
                  host={host}
                  className="h-[1.7rem] min-w-[2.1rem] rounded-[7px] text-[0.65rem]"
                />
                <span className="min-w-0 truncate font-medium text-[var(--text)]">
                  {host.label}
                </span>
              </span>

              {/* 타입 */}
              <span className="min-w-0 truncate text-[var(--text-soft)]">
                {getHostShortType(host)}
              </span>

              {/* IP / Host */}
              <span className="min-w-0 truncate text-[var(--text-soft)]">{address ?? '—'}</span>

              {/* 그룹 */}
              <span className="min-w-0 truncate text-[var(--text-soft)]">
                {group ? group.split('/').join(' / ') : 'Ungrouped'}
              </span>

              {/* 태그 */}
              <span className="flex min-w-0 items-center gap-[0.25rem]">
                {visibleTags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex min-w-0 items-center truncate rounded-full border border-[color-mix(in_srgb,var(--accent-strong)_16%,var(--border)_84%)] bg-[color-mix(in_srgb,var(--accent-strong)_9%,transparent_91%)] px-[0.4rem] py-[0.15rem] text-[0.68rem] font-medium text-[var(--accent-strong)]"
                  >
                    {tag}
                  </span>
                ))}
                {overflowTagCount > 0 ? (
                  <span className="shrink-0 text-[0.68rem] font-medium text-[var(--text-muted)]">
                    +{overflowTagCount}
                  </span>
                ) : null}
              </span>

              {/* 최근 접속 */}
              <span className="min-w-0 truncate text-[var(--text-soft)] tabular-nums">
                {lastUsedAt ? formatLastUsed(lastUsedAt) : '—'}
              </span>

              {/* 즐겨찾기 */}
              <button
                type="button"
                aria-label={translate('hostList.favoriteFor', { label: host.label })}
                aria-pressed={isFavorite}
                className={cn(
                  'inline-grid h-[1.6rem] w-[1.6rem] place-items-center rounded-[7px] transition-colors duration-140 hover:bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)]',
                  isFavorite
                    ? 'text-[#e0a23a]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-soft)]',
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  hb.toggleFavorite(host.id);
                }}
              >
                <Star className="h-[0.95rem] w-[0.95rem]" fill={isFavorite ? 'currentColor' : 'none'} />
              </button>

              {/* 메뉴 */}
              <button
                type="button"
                aria-label={translate('hostList.menuFor', { label: host.label })}
                className="inline-grid h-[1.6rem] w-[1.6rem] place-items-center rounded-[7px] text-[var(--text-muted)] transition-colors duration-140 hover:bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] hover:text-[var(--text)]"
                onClick={(event) => {
                  event.stopPropagation();
                  const rect = event.currentTarget.getBoundingClientRect();
                  onOpenMenu(host, rect.right, rect.bottom);
                }}
              >
                <MoreVertical className="h-[1.05rem] w-[1.05rem]" />
              </button>
            </div>
  );
}
