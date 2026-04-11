import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { AuthState } from '@shared';
import { AwsEcsWorkspace } from '../components/AwsEcsWorkspace';
import { ContainersWorkspace } from '../components/ContainersWorkspace';
import { cn } from '../lib/cn';
import { Badge, EmptyState, IconButton } from '../ui';
import type { useLoginController } from '../controllers/useLoginController';
import type {
  useAppModalViewModel,
  useContainersViewModel,
  useHomeViewModel,
} from '../view-models/appViewModels';
import { findHost } from './appShellUtils';
import { OfflineModeBanner } from './OfflineModeBanner';

interface ContainersShellProps {
  active: boolean;
  authState: AuthState & { session: NonNullable<AuthState['session']> };
  offlineLeaseExpiryLabel: string | null;
  homeViewModel: ReturnType<typeof useHomeViewModel>;
  containersViewModel: ReturnType<typeof useContainersViewModel>;
  modalViewModel: ReturnType<typeof useAppModalViewModel>;
  loginController: ReturnType<typeof useLoginController>;
}

export function ContainersShell({
  active,
  authState,
  offlineLeaseExpiryLabel,
  homeViewModel,
  containersViewModel,
  modalViewModel,
  loginController,
}: ContainersShellProps) {
  const [draggedContainerHostId, setDraggedContainerHostId] = useState<string | null>(
    null,
  );
  const [containerTabDropPreview, setContainerTabDropPreview] = useState<{
    targetHostId: string;
    placement: 'before' | 'after';
  } | null>(null);
  const containerTabStripRef = useRef<HTMLDivElement | null>(null);
  const containerTabButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [showLeftTabStripFade, setShowLeftTabStripFade] = useState(false);
  const [showRightTabStripFade, setShowRightTabStripFade] = useState(false);
  const hostTabShellBaseClass =
    'group relative inline-flex min-w-0 flex-none items-center gap-[0.24rem] rounded-[18px] border border-[var(--border)] bg-[var(--surface-elevated)] p-[0.24rem] shadow-none transition-[border-color,background-color] duration-200';
  const hostTabShellActiveClass =
    'border-[var(--selection-border)] bg-[var(--selection-tint)] shadow-none';
  const hostTabButtonBaseClass =
    'inline-flex min-w-0 max-w-[min(260px,42vw)] items-center gap-[0.55rem] rounded-[16px] px-[0.92rem] py-[0.72rem] text-left transition-[background-color,color] duration-200';
  const hostTabButtonActiveClass =
    'bg-[var(--surface-strong)] text-[var(--text)] shadow-none';
  const hostTabButtonInactiveClass =
    'bg-transparent text-[var(--text-soft)] hover:bg-[color-mix(in_srgb,var(--surface-muted)_82%,transparent_18%)] hover:text-[var(--text)]';
  const hostTabBadgeBaseClass =
    'min-h-6 px-[0.52rem] py-[0.14rem] text-[0.72rem] transition-[border-color,background-color,color] duration-200';
  const hostTabBadgeActiveClass =
    'border-[var(--selection-border)] bg-[var(--selection-tint)] text-[var(--accent-strong)]';
  const hostTabCloseButtonBaseClass =
    'h-[1.9rem] w-[1.9rem] rounded-full transition-[background-color,color,box-shadow] duration-200';
  const hostTabCloseButtonActiveClass =
    'text-[var(--text)] hover:bg-[color-mix(in_srgb,var(--accent-strong)_12%,transparent_88%)] hover:text-[var(--text)]';
  const hostTabCloseButtonInactiveClass =
    'text-[var(--text-soft)] hover:bg-[color-mix(in_srgb,var(--surface-strong)_72%,transparent_28%)] hover:text-[var(--text)]';

  const activeContainersHostId =
    containersViewModel.activeContainerHostId ??
    containersViewModel.containerTabs[0]?.hostId ??
    null;

  const updateContainerTabStripFades = useCallback(() => {
    const container = containerTabStripRef.current;
    if (!container) {
      setShowLeftTabStripFade(false);
      setShowRightTabStripFade(false);
      return;
    }
    const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    const nextShowLeft = container.scrollLeft > 1;
    const nextShowRight = container.scrollLeft < maxScrollLeft - 1;
    setShowLeftTabStripFade((previous) =>
      previous === nextShowLeft ? previous : nextShowLeft,
    );
    setShowRightTabStripFade((previous) =>
      previous === nextShowRight ? previous : nextShowRight,
    );
  }, []);

  useEffect(() => {
    updateContainerTabStripFades();
  }, [
    activeContainersHostId,
    containersViewModel.containerTabs.length,
    updateContainerTabStripFades,
  ]);

  useEffect(() => {
    const handleResize = () => {
      updateContainerTabStripFades();
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [updateContainerTabStripFades]);

  useLayoutEffect(() => {
    if (!activeContainersHostId || draggedContainerHostId) {
      return;
    }
    const activeButton = containerTabButtonRefs.current[activeContainersHostId];
    if (!activeButton) {
      return;
    }
    if (typeof activeButton.scrollIntoView === 'function') {
      activeButton.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    if (typeof window.requestAnimationFrame !== 'function') {
      updateContainerTabStripFades();
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      updateContainerTabStripFades();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeContainersHostId, draggedContainerHostId, updateContainerTabStripFades]);

  const focusContainerTabByIndex = useCallback(
    (index: number) => {
      const nextTab = containersViewModel.containerTabs[index];
      if (!nextTab) {
        return;
      }
      containersViewModel.focusHostContainersTab(nextTab.hostId);
      containerTabButtonRefs.current[nextTab.hostId]?.focus();
    },
    [containersViewModel],
  );

  const handleContainerTabKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
      if (containersViewModel.containerTabs.length <= 1) {
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        const nextIndex =
          currentIndex <= 0
            ? containersViewModel.containerTabs.length - 1
            : currentIndex - 1;
        focusContainerTabByIndex(nextIndex);
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        const nextIndex =
          currentIndex >= containersViewModel.containerTabs.length - 1
            ? 0
            : currentIndex + 1;
        focusContainerTabByIndex(nextIndex);
        return;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        focusContainerTabByIndex(0);
        return;
      }
      if (event.key === 'End') {
        event.preventDefault();
        focusContainerTabByIndex(containersViewModel.containerTabs.length - 1);
      }
    },
    [containersViewModel.containerTabs.length, focusContainerTabByIndex],
  );

  return (
    <section
      className={cn(
        'absolute inset-0 flex min-h-0 flex-col gap-4 p-[1rem_1.15rem_1.2rem] transition-[opacity,transform] duration-200',
        active
          ? 'pointer-events-auto scale-100 opacity-100'
          : 'pointer-events-none scale-[0.995] opacity-0',
      )}
    >
      {authState.status === 'offline-authenticated' && authState.offline ? (
        <OfflineModeBanner
          expiryLabel={offlineLeaseExpiryLabel}
          isRetrying={loginController.isRetryingOnline}
          onRetry={() => {
            void loginController.retryOnline();
          }}
        />
      ) : null}
      <div className="relative min-w-0">
        {showLeftTabStripFade ? (
          <div
            data-testid="containers-host-tab-fade-left"
            className="pointer-events-none absolute inset-y-[0.2rem] left-0 z-[1] w-10 rounded-l-[22px] bg-[linear-gradient(90deg,color-mix(in_srgb,var(--app-bg)_96%,transparent_4%),transparent)]"
          />
        ) : null}
        {showRightTabStripFade ? (
          <div
            data-testid="containers-host-tab-fade-right"
            className="pointer-events-none absolute inset-y-[0.2rem] right-0 z-[1] w-10 rounded-r-[22px] bg-[linear-gradient(270deg,color-mix(in_srgb,var(--app-bg)_96%,transparent_4%),transparent)]"
          />
        ) : null}
        <div
          ref={containerTabStripRef}
          className="flex min-w-0 items-stretch gap-[0.55rem] overflow-x-auto px-[0.1rem] py-[0.2rem]"
          role="tablist"
          aria-label="Containers hosts"
          aria-orientation="horizontal"
          onScroll={updateContainerTabStripFades}
        >
          {containersViewModel.containerTabs.length > 0 ? (
            containersViewModel.containerTabs.map((tab, index) => {
              const host = findHost(homeViewModel.hosts, tab.hostId);
              const title =
                host?.label ?? tab.title.replace(/ · (Containers|ECS)$/, '');
              const runtimeLabel =
                tab.kind === 'ecs-cluster'
                  ? 'ECS'
                  : tab.runtime === 'docker'
                    ? 'Docker'
                    : tab.runtime === 'podman'
                      ? 'Podman'
                      : null;
              const isActiveTab = activeContainersHostId === tab.hostId;
              const preview =
                containerTabDropPreview?.targetHostId === tab.hostId
                  ? containerTabDropPreview.placement
                  : null;
              const tabId = `containers-host-tab-${encodeURIComponent(tab.hostId)}`;
              const panelId = `containers-host-panel-${encodeURIComponent(tab.hostId)}`;
              return (
                <div
                  key={tab.hostId}
                  className={cn(
                    hostTabShellBaseClass,
                    isActiveTab && hostTabShellActiveClass,
                    preview === 'before' &&
                      "before:pointer-events-none before:absolute before:top-[0.36rem] before:bottom-[0.36rem] before:left-[-0.34rem] before:w-[3px] before:rounded-full before:bg-[color-mix(in_srgb,var(--accent-strong)_88%,white_12%)] before:content-[''] before:shadow-[0_0_0_1px_color-mix(in_srgb,var(--accent-strong)_18%,transparent_82%)]",
                    preview === 'after' &&
                    "after:pointer-events-none after:absolute after:top-[0.36rem] after:bottom-[0.36rem] after:right-[-0.34rem] after:w-[3px] after:rounded-full after:bg-[color-mix(in_srgb,var(--accent-strong)_88%,white_12%)] after:content-[''] after:shadow-[0_0_0_1px_color-mix(in_srgb,var(--accent-strong)_18%,transparent_82%)]",
                )}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', tab.hostId);
                  setDraggedContainerHostId(tab.hostId);
                }}
                onDragEnd={() => {
                  setDraggedContainerHostId(null);
                  setContainerTabDropPreview(null);
                }}
                onDragOver={(event) => {
                  if (
                    !draggedContainerHostId ||
                    draggedContainerHostId === tab.hostId
                  ) {
                    return;
                  }
                  event.preventDefault();
                  const bounds = event.currentTarget.getBoundingClientRect();
                  setContainerTabDropPreview({
                    targetHostId: tab.hostId,
                    placement:
                      event.clientX <= bounds.left + bounds.width / 2
                        ? 'before'
                        : 'after',
                  });
                }}
                onDragLeave={(event) => {
                  const nextTarget = event.relatedTarget;
                  if (
                    nextTarget instanceof Node &&
                    event.currentTarget.contains(nextTarget)
                  ) {
                    return;
                  }
                  setContainerTabDropPreview((current) =>
                    current?.targetHostId === tab.hostId ? null : current,
                  );
                }}
                onDrop={(event) => {
                  if (
                    !draggedContainerHostId ||
                    draggedContainerHostId === tab.hostId
                  ) {
                    return;
                  }
                  event.preventDefault();
                  const bounds = event.currentTarget.getBoundingClientRect();
                  containersViewModel.reorderContainerTab(
                    draggedContainerHostId,
                    tab.hostId,
                    event.clientX <= bounds.left + bounds.width / 2
                      ? 'before'
                      : 'after',
                  );
                  setDraggedContainerHostId(null);
                  setContainerTabDropPreview(null);
                }}
              >
                <button
                  id={tabId}
                  ref={(node) => {
                    if (node) {
                      containerTabButtonRefs.current[tab.hostId] = node;
                      return;
                    }
                    delete containerTabButtonRefs.current[tab.hostId];
                  }}
                  type="button"
                  role="tab"
                  aria-selected={isActiveTab}
                  aria-controls={panelId}
                  tabIndex={isActiveTab ? 0 : -1}
                  className={cn(
                    hostTabButtonBaseClass,
                    isActiveTab
                      ? hostTabButtonActiveClass
                      : hostTabButtonInactiveClass,
                  )}
                  onClick={() => {
                    containersViewModel.focusHostContainersTab(tab.hostId);
                  }}
                  onKeyDown={(event) => {
                    handleContainerTabKeyDown(event, index);
                  }}
                >
                  <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-semibold">
                    {title}
                  </span>
                  {runtimeLabel ? (
                    <Badge
                      tone="neutral"
                      className={cn(
                        hostTabBadgeBaseClass,
                        isActiveTab && hostTabBadgeActiveClass,
                      )}
                    >
                      {runtimeLabel}
                    </Badge>
                  ) : null}
                </button>
                <IconButton
                  type="button"
                  tone="ghost"
                  size="sm"
                  className={cn(
                    hostTabCloseButtonBaseClass,
                    isActiveTab
                      ? hostTabCloseButtonActiveClass
                      : hostTabCloseButtonInactiveClass,
                  )}
                  aria-label={`${title} 닫기`}
                  onClick={async (event) => {
                    event.stopPropagation();
                    await containersViewModel.closeHostContainersTab(tab.hostId);
                  }}
                >
                  ×
                </IconButton>
              </div>
              );
            })
          ) : (
            <div className="inline-flex min-h-12 items-center px-[0.2rem] text-[0.92rem] text-[var(--text-soft)]">
              열린 컨테이너 화면이 없습니다.
            </div>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {containersViewModel.containerTabs.length > 0 ? (
          containersViewModel.containerTabs.map((tab) => {
            const host = findHost(homeViewModel.hosts, tab.hostId);
            if (!host) {
              return null;
            }
            const isActiveTab = activeContainersHostId === tab.hostId;
            return (
              <div
                id={`containers-host-panel-${encodeURIComponent(tab.hostId)}`}
                key={tab.hostId}
                role="tabpanel"
                aria-labelledby={`containers-host-tab-${encodeURIComponent(tab.hostId)}`}
                aria-hidden={!isActiveTab}
                hidden={!isActiveTab}
                tabIndex={isActiveTab ? 0 : -1}
                className="h-full min-h-0"
              >
                {tab.kind === 'ecs-cluster' ? (
                  <AwsEcsWorkspace
                    host={host}
                    tab={tab}
                    isActive={active && isActiveTab}
                    onRefresh={containersViewModel.refreshHostContainers}
                    onRefreshUtilization={
                      containersViewModel.refreshEcsClusterUtilization
                    }
                    onSelectService={containersViewModel.setEcsClusterSelectedService}
                    onSetPanel={containersViewModel.setEcsClusterActivePanel}
                    onSetTunnelState={containersViewModel.setEcsClusterTunnelState}
                    onSetLogsState={containersViewModel.setEcsClusterLogsState}
                    onOpenEcsExecShell={containersViewModel.openEcsExecShell}
                  />
                ) : (
                  <ContainersWorkspace
                    host={host}
                    tab={tab}
                    isActive={active && isActiveTab}
                    interactiveAuth={
                      modalViewModel.pendingInteractiveAuth?.source === 'containers'
                        ? modalViewModel.pendingInteractiveAuth
                        : null
                    }
                    onRefresh={containersViewModel.refreshHostContainers}
                    onSelectContainer={containersViewModel.selectHostContainer}
                    onSetPanel={containersViewModel.setHostContainersPanel}
                    onSetTunnelState={containersViewModel.setHostContainerTunnelState}
                    onRefreshLogs={containersViewModel.refreshHostContainerLogs}
                    onLoadMoreLogs={containersViewModel.loadMoreHostContainerLogs}
                    onSetLogsFollow={containersViewModel.setHostContainerLogsFollow}
                    onSetLogsSearchQuery={
                      containersViewModel.setHostContainerLogsSearchQuery
                    }
                    onSearchLogs={containersViewModel.searchHostContainerLogs}
                    onClearLogsSearch={
                      containersViewModel.clearHostContainerLogsSearch
                    }
                    onRefreshMetrics={containersViewModel.refreshHostContainerStats}
                    onRunAction={containersViewModel.runHostContainerAction}
                    onOpenShell={containersViewModel.openHostContainerShell}
                    onRespondInteractiveAuth={modalViewModel.respondInteractiveAuth}
                    onReopenInteractiveAuthUrl={
                      modalViewModel.reopenInteractiveAuthUrl
                    }
                    onClearInteractiveAuth={
                      modalViewModel.clearPendingInteractiveAuth
                    }
                  />
                )}
              </div>
            );
          })
        ) : (
          <EmptyState
            className="max-w-[620px]"
            title="열린 컨테이너 화면이 없습니다."
            description="Host 카드에서 우클릭한 뒤 컨테이너를 열어 주세요."
          />
        )}
      </div>
    </section>
  );
}
