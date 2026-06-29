import { useMemo } from 'react';
import { cn } from '../../lib/cn';
import { ChevronDown, LayoutGrid, List, Search } from '../../ui/icons';
import { HostListCard } from './HostListCard';
import { HostListTable } from './HostListTable';
import {
  Button,
  EmptyState,
  SplitButton,
  SplitButtonMain,
  SplitButtonMenu,
  SplitButtonMenuItem,
  SplitButtonToggle,
} from '../../ui';
import {
  getHostBrowserEmptyCalloutMessage,
  HOST_BROWSER_IMPORT_MENU_LABELS,
  HOST_DRAG_MIME_TYPE,
  HOSTS_DRAG_MIME_TYPE,
  type HostBrowserModel,
} from './useHostBrowser';

interface HostListPanelProps {
  hb: HostBrowserModel;
}

const SORT_OPTIONS: Array<{ value: HostBrowserModel['sortKey']; label: string }> = [
  { value: 'name', label: '이름순' },
  { value: 'lastConnected', label: '최근 연결순' },
  { value: 'recent', label: '최근 수정순' },
];

export function HostListPanel({ hb }: HostListPanelProps) {
  const {
    desktopPlatform,
    hosts,
    searchQuery,
    searchPlaceholder,
    onSearchChange,
    visibleHosts,
    emptyMessage,
    selectedHostId,
    selectedHostIds,
    selectedGroupPaths,
    selectedHostIdSet,
    favoriteHostIdSet,
    viewMode,
    sortKey,
    isImportMenuOpen,
    importMenuRef,
  } = hb;

  const shortcutLabel = desktopPlatform === 'darwin' ? '⌘K' : 'Ctrl K';

  const importMenuItems = useMemo(
    () =>
      [
        { label: HOST_BROWSER_IMPORT_MENU_LABELS[0], onSelect: hb.onOpenOpenSshImport },
        { label: HOST_BROWSER_IMPORT_MENU_LABELS[1], onSelect: hb.onOpenSerialImport },
        { label: HOST_BROWSER_IMPORT_MENU_LABELS[2], onSelect: hb.onOpenTermiusImport },
        ...(desktopPlatform === 'win32'
          ? [{ label: HOST_BROWSER_IMPORT_MENU_LABELS[3], onSelect: hb.onOpenXshellImport }]
          : []),
        { label: HOST_BROWSER_IMPORT_MENU_LABELS[4], onSelect: hb.onOpenWarpgateImport },
        { label: HOST_BROWSER_IMPORT_MENU_LABELS[5], onSelect: hb.onOpenAwsImport },
      ],
    [
      desktopPlatform,
      hb.onOpenAwsImport,
      hb.onOpenOpenSshImport,
      hb.onOpenSerialImport,
      hb.onOpenTermiusImport,
      hb.onOpenWarpgateImport,
      hb.onOpenXshellImport,
    ],
  );

  function handleBackgroundClick(event: React.MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (
      target.closest('[data-host-card="true"]') ||
      target.closest('[role="menu"]') ||
      target.closest('button') ||
      target.closest('input') ||
      target.closest('select') ||
      target.closest('[data-host-browser-modal="true"]')
    ) {
      return;
    }
    hb.clearSelections();
  }

  function openHostMenu(host: (typeof visibleHosts)[number], x: number, y: number) {
    // 우클릭/⋮ 메뉴는 선택(상세 패널 포커스)을 바꾸지 않는다 — 메뉴 대상만 계산:
    // 이미 다중선택에 든 호스트면 그 선택 전체, 아니면 클릭한 호스트 하나.
    const targetHostIds = selectedHostIdSet.has(host.id)
      ? hb.getOrderedSelectedHostIds(selectedHostIds)
      : [host.id];
    hb.setContextMenu({ kind: 'host', hostIds: targetHostIds, x, y });
  }

  function renderHostCard(host: (typeof visibleHosts)[number]) {
    return (
      <HostListCard
        key={host.id}
        host={host}
        selected={
          selectedHostIdSet.has(host.id) ||
          (selectedHostIds.length === 0 &&
            selectedGroupPaths.length === 0 &&
            selectedHostId === host.id)
        }
        focused={
          selectedHostIds.length <= 1 &&
          selectedGroupPaths.length === 0 &&
          selectedHostId === host.id
        }
        favorite={favoriteHostIdSet.has(host.id)}
        favoriteLabel={`${host.label} 즐겨찾기`}
        lastUsedAt={hb.lastConnectedByHostId.get(host.id)}
        onToggleFavorite={() => hb.toggleFavorite(host.id)}
        onOpenMenu={({ x, y }) => openHostMenu(host, x, y)}
        style={hb.clampedHostCardStyle}
        draggable
        role="button"
        tabIndex={0}
        onClick={(event) => {
          hb.handleHostSelection(host.id, event);
        }}
        onDragStart={(event) => {
          const nextDraggedHostIds = hb.getNextDraggedHostIds(host);
          if (!selectedHostIdSet.has(host.id)) {
            hb.selectSingleHost(host.id);
          }
          hb.setDraggedGroupPath(null);
          hb.setDraggedHostIds(nextDraggedHostIds);
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData(HOST_DRAG_MIME_TYPE, nextDraggedHostIds[0] ?? host.id);
          event.dataTransfer.setData(HOSTS_DRAG_MIME_TYPE, JSON.stringify(nextDraggedHostIds));
          event.dataTransfer.setData(
            'text/plain',
            nextDraggedHostIds.length === 1 ? host.label : `${nextDraggedHostIds.length} hosts`,
          );
        }}
        onDragEnd={() => hb.clearDragState()}
        onDoubleClick={async () => {
          await hb.onConnectHost(host.id);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          openHostMenu(host, event.clientX, event.clientY);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void (async () => {
              await hb.onConnectHost(host.id);
            })();
          }
        }}
      />
    );
  }

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      onClickCapture={handleBackgroundClick}
    >
      {/* Toolbar row: search + actions */}
      <div className="flex items-center gap-3 px-[1.1rem] pb-[0.7rem] pt-[1.1rem] max-[760px]:flex-col max-[760px]:items-stretch">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-[0.75rem] top-1/2 h-[1rem] w-[1rem] -translate-y-1/2 text-[var(--text-muted)]"
            aria-hidden="true"
          />
          <input
            id="host-search"
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label="Search hosts"
            className="pl-[2.4rem] pr-[3.4rem]"
          />
          <kbd className="pointer-events-none absolute right-[0.6rem] top-1/2 inline-flex -translate-y-1/2 items-center rounded-[6px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] px-[0.4rem] py-[0.1rem] text-[0.7rem] font-medium text-[var(--text-muted)]">
            {shortcutLabel}
          </kbd>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="primary"
            onClick={() => {
              hb.setIsImportMenuOpen(false);
              hb.onCreateHost();
            }}
          >
            New Host
          </Button>
          <SplitButton ref={importMenuRef}>
            <SplitButtonMain
              variant="secondary"
              onClick={() => {
                hb.setIsImportMenuOpen(false);
                hb.onOpenOpenSshImport();
              }}
            >
              Import
            </SplitButtonMain>
            <SplitButtonToggle
              variant="secondary"
              aria-label="Open import menu"
              aria-expanded={isImportMenuOpen}
              aria-haspopup="menu"
              onClick={() => hb.setIsImportMenuOpen((current) => !current)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  hb.setIsImportMenuOpen((current) => !current);
                }
              }}
            >
              <ChevronDown
                className={cn(
                  'h-[0.95rem] w-[0.95rem] transition-transform duration-140',
                  isImportMenuOpen && 'rotate-180',
                )}
                aria-hidden="true"
              />
            </SplitButtonToggle>
            {isImportMenuOpen ? (
              <SplitButtonMenu role="menu" aria-label="Import host menu">
                {importMenuItems.map((item) => (
                  <SplitButtonMenuItem
                    key={item.label}
                    role="menuitem"
                    onClick={() => {
                      hb.setIsImportMenuOpen(false);
                      item.onSelect();
                    }}
                  >
                    {item.label}
                  </SplitButtonMenuItem>
                ))}
              </SplitButtonMenu>
            ) : null}
          </SplitButton>
          <Button
            variant="secondary"
            onClick={() => {
              hb.setIsImportMenuOpen(false);
              hb.onOpenLocalTerminal();
            }}
          >
            Local Terminal
          </Button>
        </div>
      </div>

      {/* Meta row: count + sort + view toggle */}
      <div className="flex items-center justify-between gap-3 px-[1.1rem] pb-[0.7rem]">
        <span className="text-[0.9rem] font-semibold text-[var(--text)]">
          {visibleHosts.length} hosts
        </span>
        <div className="flex items-center gap-2">
          <div className="inline-flex items-center gap-[0.25rem] rounded-[10px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] p-[0.25rem]">
            <button
              type="button"
              aria-label="격자 보기"
              aria-pressed={viewMode === 'grid'}
              className={cn(
                'inline-grid h-[1.6rem] w-[1.85rem] place-items-center rounded-[8px] text-[0.82rem] transition-colors duration-140',
                viewMode === 'grid'
                  ? 'bg-[var(--selection-tint)] text-[var(--accent-strong)]'
                  : 'text-[var(--text-soft)] hover:text-[var(--text)]',
              )}
              onClick={() => {
                void hb.setViewMode('grid');
              }}
            >
              <LayoutGrid className="h-[1rem] w-[1rem]" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="목록 보기"
              aria-pressed={viewMode === 'list'}
              className={cn(
                'inline-grid h-[1.6rem] w-[1.85rem] place-items-center rounded-[8px] text-[0.82rem] transition-colors duration-140',
                viewMode === 'list'
                  ? 'bg-[var(--selection-tint)] text-[var(--accent-strong)]'
                  : 'text-[var(--text-soft)] hover:text-[var(--text)]',
              )}
              onClick={() => {
                void hb.setViewMode('list');
              }}
            >
              <List className="h-[1rem] w-[1rem]" aria-hidden="true" />
            </button>
          </div>
          {/* 목록(테이블) 뷰는 헤더 클릭으로 정렬하므로 드롭다운은 격자 뷰에서만 노출. */}
          {viewMode === 'list' ? null : (
            <>
              <label className="sr-only" htmlFor="host-sort">
                정렬
              </label>
              <div className="relative shrink-0">
                <select
                  id="host-sort"
                  value={sortKey}
                  onChange={(event) =>
                    hb.setSort(event.target.value as HostBrowserModel['sortKey'])
                  }
                  className="h-[2rem] w-[8rem] appearance-none rounded-[10px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] py-0 pl-[0.7rem] pr-[1.7rem] text-[0.82rem] font-medium leading-none text-[var(--text-soft)] outline-none transition-colors duration-140 hover:text-[var(--text)] focus-visible:border-[var(--selection-border)]"
                >
                  {SORT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  className="pointer-events-none absolute right-[0.5rem] top-1/2 h-[0.85rem] w-[0.85rem] -translate-y-1/2 text-[var(--text-soft)]"
                  aria-hidden="true"
                />
              </div>
            </>
          )}
        </div>
      </div>

      {/* Cards */}
      <div
        className={cn(
          'min-h-0 flex-1 overflow-y-auto px-[1.1rem] pb-[1.1rem]',
          // 목록(테이블)은 흰 배경, 격자(카드)는 기존 투명 배경 위에 둔다.
          viewMode === 'list' ? 'bg-[var(--surface-strong)] pt-0' : 'pt-[0.4rem]',
        )}
        data-testid="host-browser-content"
      >
        {visibleHosts.length === 0 ? (
          <EmptyState
            title={emptyMessage}
            description={getHostBrowserEmptyCalloutMessage(hosts.length, searchQuery)}
          />
        ) : viewMode === 'list' ? (
          <HostListTable hb={hb} />
        ) : (
          <div
            data-host-grid="true"
            className="grid content-start gap-[0.9rem]"
            ref={hb.hostGridRef}
            style={hb.hostGridStyle}
          >
            {visibleHosts.map(renderHostCard)}
          </div>
        )}
      </div>
    </div>
  );
}
