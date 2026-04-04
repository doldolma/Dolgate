import { useState } from 'react';
import type { AuthState } from '@shared';
import { AwsEcsWorkspace } from '../components/AwsEcsWorkspace';
import { ContainersWorkspace } from '../components/ContainersWorkspace';
import { SectionLabel } from '../ui';
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

  const activeContainersHostId = active
    ? containersViewModel.activeContainerHostId ??
      containersViewModel.containerTabs[0]?.hostId ??
      null
    : null;
  const activeContainersTab = activeContainersHostId
    ? containersViewModel.containerTabs.find(
        (tab) => tab.hostId === activeContainersHostId,
      ) ?? null
    : null;
  const activeContainerHost = findHost(homeViewModel.hosts, activeContainersHostId);

  return (
    <section className={`containers-shell ${active ? 'active' : 'hidden'}`}>
      {authState.status === 'offline-authenticated' && authState.offline ? (
        <OfflineModeBanner
          expiryLabel={offlineLeaseExpiryLabel}
          isRetrying={loginController.isRetryingOnline}
          onRetry={() => {
            void loginController.retryOnline();
          }}
        />
      ) : null}
      <div className="containers-shell__tabs" role="tablist" aria-label="Containers hosts">
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
                className={`containers-shell__tab-shell ${isActiveTab ? 'active' : ''} ${
                  preview === 'before'
                    ? 'containers-shell__tab-shell--drop-before'
                    : ''
                } ${preview === 'after' ? 'containers-shell__tab-shell--drop-after' : ''}`}
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
                  className={`containers-shell__tab ${isActiveTab ? 'active' : ''}`}
                  onClick={() => {
                    containersViewModel.focusHostContainersTab(tab.hostId);
                  }}
                >
                  <span className="containers-shell__tab-title">{title}</span>
                  {runtimeLabel ? (
                    <span className="containers-shell__tab-badge">{runtimeLabel}</span>
                  ) : null}
                </button>
                <button
                  type="button"
                  className="containers-shell__tab-close"
                  aria-label={`${title} 닫기`}
                  onClick={async (event) => {
                    event.stopPropagation();
                    await containersViewModel.closeHostContainersTab(tab.hostId);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })
        ) : (
          <div className="containers-shell__tabs-empty">
            열린 컨테이너 화면이 없습니다.
          </div>
        )}
      </div>
      <div className="containers-shell__content">
        {activeContainerHost && activeContainersTab ? (
          activeContainersTab.kind === 'ecs-cluster' ? (
            <AwsEcsWorkspace
              host={activeContainerHost}
              tab={activeContainersTab}
              isActive={active}
              onRefresh={containersViewModel.refreshHostContainers}
              onRefreshUtilization={containersViewModel.refreshEcsClusterUtilization}
              onSelectService={containersViewModel.setEcsClusterSelectedService}
              onSetPanel={containersViewModel.setEcsClusterActivePanel}
              onSetTunnelState={containersViewModel.setEcsClusterTunnelState}
              onOpenEcsExecShell={containersViewModel.openEcsExecShell}
            />
          ) : (
            <ContainersWorkspace
              host={activeContainerHost}
              tab={activeContainersTab}
              isActive={active}
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
              onClearLogsSearch={containersViewModel.clearHostContainerLogsSearch}
              onRefreshMetrics={containersViewModel.refreshHostContainerStats}
              onRunAction={containersViewModel.runHostContainerAction}
              onOpenShell={containersViewModel.openHostContainerShell}
              onRespondInteractiveAuth={modalViewModel.respondInteractiveAuth}
              onReopenInteractiveAuthUrl={modalViewModel.reopenInteractiveAuthUrl}
              onClearInteractiveAuth={modalViewModel.clearPendingInteractiveAuth}
            />
          )
        ) : (
          <div className="empty-state-card containers-shell__empty-state">
            <SectionLabel>Containers</SectionLabel>
            <h3>열린 컨테이너 화면이 없습니다.</h3>
            <p>Host 카드에서 우클릭한 뒤 컨테이너를 열어 주세요.</p>
          </div>
        )}
      </div>
    </section>
  );
}
