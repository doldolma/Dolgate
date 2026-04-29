import type { AuthState } from '@shared';
import { SftpWorkspace } from '../components/SftpWorkspace';
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
  authState: AuthState & { session: NonNullable<AuthState['session']> };
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
          sftp={sftpViewModel.sftpState}
          transfers={sftpViewModel.transfers}
          settings={settingsViewModel.settings}
          interactiveAuth={
            modalViewModel.pendingInteractiveAuth?.source === 'sftp'
              ? modalViewModel.pendingInteractiveAuth
              : null
          }
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
          onDeleteSelection={sftpViewModel.deleteSftpSelection}
          onDownloadSelection={sftpViewModel.downloadSftpSelection}
          onPrepareTransfer={sftpViewModel.prepareSftpTransfer}
          onPrepareExternalTransfer={sftpViewModel.prepareSftpExternalTransfer}
          onTransferSelectionToPane={sftpViewModel.transferSftpSelectionToPane}
          onResolveConflict={sftpViewModel.resolveSftpConflict}
          onDismissConflict={sftpViewModel.dismissSftpConflict}
          onCancelTransfer={sftpViewModel.cancelTransfer}
          onRetryTransfer={sftpViewModel.retryTransfer}
          onDismissTransfer={sftpViewModel.dismissTransfer}
          onRespondInteractiveAuth={modalViewModel.respondInteractiveAuth}
          onReopenInteractiveAuthUrl={modalViewModel.reopenInteractiveAuthUrl}
          onClearInteractiveAuth={modalViewModel.clearPendingInteractiveAuth}
          onUpdateSettings={settingsViewModel.updateSettings}
        />
      </div>
    </section>
  );
}
