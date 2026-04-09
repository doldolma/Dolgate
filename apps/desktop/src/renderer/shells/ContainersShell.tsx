import { useState } from 'react';
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
  const hostTabShellBaseClass =
    'group relative inline-flex min-w-0 flex-none items-center gap-[0.3rem] rounded-[18px] border border-[color-mix(in_srgb,var(--border)_88%,transparent_12%)] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--surface-strong)_92%,transparent_8%),color-mix(in_srgb,var(--surface)_96%,transparent_4%))] pr-[0.24rem] shadow-[var(--shadow-soft)] transition-[border-color,background-color,box-shadow,transform] duration-200';
  const hostTabShellActiveClass =
    'border-[color-mix(in_srgb,var(--accent-strong)_52%,var(--border)_48%)] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--accent-strong)_13%,var(--surface-strong)_87%),color-mix(in_srgb,var(--accent-strong)_7%,var(--surface)_93%))] shadow-[0_0_0_1px_color-mix(in_srgb,var(--accent-strong)_18%,transparent_82%),0_16px_28px_-22px_color-mix(in_srgb,var(--accent-strong)_42%,transparent_58%),var(--shadow)]';
  const hostTabButtonBaseClass =
    'inline-flex min-w-0 max-w-[min(260px,42vw)] items-center gap-[0.55rem] rounded-[16px] px-[0.92rem] py-[0.72rem] text-left transition-[background-color,color,box-shadow,transform] duration-200';
  const hostTabButtonActiveClass =
    'bg-[color-mix(in_srgb,var(--accent-strong)_14%,var(--surface-strong)_86%)] text-[var(--text)] shadow-[inset_0_1px_0_color-mix(in_srgb,white_48%,transparent_52%)]';
  const hostTabButtonInactiveClass =
    'bg-transparent text-[var(--text-soft)] hover:bg-[color-mix(in_srgb,var(--surface-strong)_82%,transparent_18%)] hover:text-[var(--text)]';
  const hostTabBadgeBaseClass =
    'min-h-6 px-[0.52rem] py-[0.14rem] text-[0.72rem] transition-[border-color,background-color,color] duration-200';
  const hostTabBadgeActiveClass =
    'border-[color-mix(in_srgb,var(--accent-strong)_24%,var(--border)_76%)] bg-[color-mix(in_srgb,var(--accent-strong)_12%,transparent_88%)] text-[var(--text)]';
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
      <div
        className="flex min-w-0 items-stretch gap-[0.55rem] overflow-x-auto px-[0.1rem] py-[0.2rem]"
        role="tablist"
        aria-label="Containers hosts"
      >
        {containersViewModel.containerTabs.length > 0 ? (
          containersViewModel.containerTabs.map((tab) => {
            const host = findHost(homeViewModel.hosts, tab.hostId);
            const title = host?.label ?? tab.title.replace(/ · (Containers|ECS)$/, '');
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
                  type="button"
                  role="tab"
                  aria-selected={isActiveTab}
                  className={cn(
                    hostTabButtonBaseClass,
                    isActiveTab
                      ? hostTabButtonActiveClass
                      : hostTabButtonInactiveClass,
                  )}
                  onClick={() => {
                    containersViewModel.focusHostContainersTab(tab.hostId);
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
                key={tab.hostId}
                className={cn('h-full min-h-0', isActiveTab ? 'block' : 'hidden')}
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
