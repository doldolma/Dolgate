import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { AuthState } from '@shared';
import { RemoteFileEditorModal } from '../components/RemoteFileEditorModal';
import { SftpWorkspace } from '../components/SftpWorkspace';
import { buildBrowserVaults } from '../components/host-browser/browserVaults';
import type { useLoginController } from '../controllers/useLoginController';
import { cn } from '../lib/cn';
import { getPathForDroppedFile, listLocalRoots } from '../services/desktop/files';
import type {
  useAppModalViewModel,
  useAppSettingsViewModel,
  useHomeViewModel,
  useSftpViewModel,
} from '../view-models/appViewModels';
import { OfflineModeBanner } from './OfflineModeBanner';

interface SftpShellProps {
  active: boolean;
  /**
   * 세션이 없을 수 있다 — 계정 없이 이 기기에서만 쓰는 상태(`local-only`)가 그렇다.
   * 계정 정보를 읽는 자리는 없을 때를 다뤄야 한다.
   */
  authState: AuthState;
  offlineLeaseExpiryLabel: string | null;
  desktopPlatform: 'darwin' | 'win32' | 'linux' | 'unknown';
  homeViewModel: ReturnType<typeof useHomeViewModel>;
  sftpViewModel: ReturnType<typeof useSftpViewModel>;
  settingsViewModel: ReturnType<typeof useAppSettingsViewModel>;
  modalViewModel: ReturnType<typeof useAppModalViewModel>;
  loginController: ReturnType<typeof useLoginController>;
}

export function SftpShell({
  active,
  authState,
  offlineLeaseExpiryLabel,
  desktopPlatform,
  homeViewModel,
  sftpViewModel,
  settingsViewModel,
  modalViewModel,
  loginController,
}: SftpShellProps) {
  const { t: translate } = useTranslation();
  // 호스트 고르기의 맨 위 볼트들(홈 사이드바와 같은 것). 팀이 없으면 비어 있고 고르기는 지금 그대로다.
  const vaults = useMemo(
    () =>
      buildBrowserVaults({
        hosts: homeViewModel.hosts,
        groups: homeViewModel.groups,
        savedWorkspaces: homeViewModel.savedWorkspaces ?? [],
        vaultIndex: homeViewModel.vaultIndex,
        personalName: translate('sidebar.personalVault'),
      }),
    [homeViewModel.groups, homeViewModel.hosts, homeViewModel.savedWorkspaces, homeViewModel.vaultIndex, translate],
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
      <div className="min-h-0 flex-1">
        <SftpWorkspace
          desktopPlatform={desktopPlatform}
          hosts={homeViewModel.hosts}
          groups={homeViewModel.groups}
          vaults={vaults}
          myUsernameByHostId={homeViewModel.vaultIndex?.myUsernameByHostId}
          sftp={sftpViewModel.sftpState}
          transfers={sftpViewModel.transfers}
          settings={settingsViewModel.settings}
          // 판마다 자기 엔드포인트의 것을 고른다 — 다른 판·터미널의 요청이 이 카드를 밀어내지 않는다.
          interactiveAuths={modalViewModel.pendingInteractiveAuths.filter(
            (auth) => auth.source === 'sftp',
          )}
          onActivatePaneSource={sftpViewModel.setSftpPaneSource}
          onDisconnectPane={sftpViewModel.disconnectSftpPane}
          onPaneFilterChange={sftpViewModel.setSftpPaneFilter}
          onHostSearchChange={sftpViewModel.setSftpHostSearchQuery}
          onNavigateHostGroup={sftpViewModel.navigateSftpHostGroup}
          onSelectHost={sftpViewModel.selectSftpHost}
          onConnectHost={sftpViewModel.connectSftpHost}
          onOpenHostSettings={homeViewModel.openEditHostDrawer}
          onOpenEntry={sftpViewModel.openSftpEntry}
          onRefreshPane={sftpViewModel.refreshSftpPane}
          onNavigateBack={sftpViewModel.navigateSftpBack}
          onNavigateForward={sftpViewModel.navigateSftpForward}
          onNavigateParent={sftpViewModel.navigateSftpParent}
          onNavigateBreadcrumb={sftpViewModel.navigateSftpBreadcrumb}
          onListLocalRoots={listLocalRoots}
          onGetPathForDroppedFile={getPathForDroppedFile}
          onSelectEntry={sftpViewModel.selectSftpEntry}
          onCreateDirectory={sftpViewModel.createSftpDirectory}
          onRenameSelection={sftpViewModel.renameSftpSelection}
          onChangeSelectionPermissions={
            sftpViewModel.changeSftpSelectionPermissions
          }
          onChangeSelectionOwner={sftpViewModel.changeSftpSelectionOwner}
          onListPrincipals={sftpViewModel.listSftpPrincipals}
          onDeleteSelection={sftpViewModel.deleteSftpSelection}
          onDownloadSelection={sftpViewModel.downloadSftpSelection}
          onPrepareTransfer={sftpViewModel.prepareSftpTransfer}
          onPrepareExternalTransfer={sftpViewModel.prepareSftpExternalTransfer}
          onTransferSelectionToPane={sftpViewModel.transferSftpSelectionToPane}
          onResolveConflict={sftpViewModel.resolveSftpConflict}
          onDismissConflict={sftpViewModel.dismissSftpConflict}
          onCancelTransfer={sftpViewModel.cancelTransfer}
          onPauseTransfer={sftpViewModel.pauseTransfer}
          onResumeTransfer={sftpViewModel.resumeTransfer}
          onRetryTransfer={sftpViewModel.retryTransfer}
          onDismissTransfer={sftpViewModel.dismissTransfer}
          onRespondInteractiveAuth={modalViewModel.respondInteractiveAuth}
          onReopenInteractiveAuthUrl={modalViewModel.reopenInteractiveAuthUrl}
          onClearInteractiveAuth={modalViewModel.clearPendingInteractiveAuth}
          onUpdateSettings={settingsViewModel.updateSettings}
        />
      </div>
      <RemoteFileEditorModal />
    </section>
  );
}
