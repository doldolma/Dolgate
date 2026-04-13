import { useAppStore } from '../store/appStore';

export function useSftpViewModel() {
  const localHomePath = useAppStore((state) => state.sftp.localHomePath);
  const leftPane = useAppStore((state) => state.sftp.leftPane);
  const rightPane = useAppStore((state) => state.sftp.rightPane);
  const pendingConflictDialog = useAppStore(
    (state) => state.sftp.pendingConflictDialog,
  );
  const transfers = useAppStore((state) => state.sftp.transfers);
  const activateSftp = useAppStore((state) => state.activateSftp);
  const setSftpPaneSource = useAppStore((state) => state.setSftpPaneSource);
  const disconnectSftpPane = useAppStore((state) => state.disconnectSftpPane);
  const setSftpPaneFilter = useAppStore((state) => state.setSftpPaneFilter);
  const setSftpHostSearchQuery = useAppStore((state) => state.setSftpHostSearchQuery);
  const navigateSftpHostGroup = useAppStore((state) => state.navigateSftpHostGroup);
  const selectSftpHost = useAppStore((state) => state.selectSftpHost);
  const connectSftpHost = useAppStore((state) => state.connectSftpHost);
  const openSftpEntry = useAppStore((state) => state.openSftpEntry);
  const refreshSftpPane = useAppStore((state) => state.refreshSftpPane);
  const navigateSftpBack = useAppStore((state) => state.navigateSftpBack);
  const navigateSftpForward = useAppStore((state) => state.navigateSftpForward);
  const navigateSftpParent = useAppStore((state) => state.navigateSftpParent);
  const navigateSftpBreadcrumb = useAppStore((state) => state.navigateSftpBreadcrumb);
  const selectSftpEntry = useAppStore((state) => state.selectSftpEntry);
  const createSftpDirectory = useAppStore((state) => state.createSftpDirectory);
  const renameSftpSelection = useAppStore((state) => state.renameSftpSelection);
  const changeSftpSelectionPermissions = useAppStore(
    (state) => state.changeSftpSelectionPermissions,
  );
  const deleteSftpSelection = useAppStore((state) => state.deleteSftpSelection);
  const downloadSftpSelection = useAppStore((state) => state.downloadSftpSelection);
  const prepareSftpTransfer = useAppStore((state) => state.prepareSftpTransfer);
  const prepareSftpExternalTransfer = useAppStore(
    (state) => state.prepareSftpExternalTransfer,
  );
  const transferSftpSelectionToPane = useAppStore(
    (state) => state.transferSftpSelectionToPane,
  );
  const resolveSftpConflict = useAppStore((state) => state.resolveSftpConflict);
  const dismissSftpConflict = useAppStore((state) => state.dismissSftpConflict);
  const cancelTransfer = useAppStore((state) => state.cancelTransfer);
  const retryTransfer = useAppStore((state) => state.retryTransfer);
  const dismissTransfer = useAppStore((state) => state.dismissTransfer);
  const handleSftpConnectionProgressEvent = useAppStore(
    (state) => state.handleSftpConnectionProgressEvent,
  );
  const handleTransferEvent = useAppStore((state) => state.handleTransferEvent);

  return {
    sftpState: {
      localHomePath,
      leftPane,
      rightPane,
      pendingConflictDialog,
    },
    transfers,
    activateSftp,
    setSftpPaneSource,
    disconnectSftpPane,
    setSftpPaneFilter,
    setSftpHostSearchQuery,
    navigateSftpHostGroup,
    selectSftpHost,
    connectSftpHost,
    openSftpEntry,
    refreshSftpPane,
    navigateSftpBack,
    navigateSftpForward,
    navigateSftpParent,
    navigateSftpBreadcrumb,
    selectSftpEntry,
    createSftpDirectory,
    renameSftpSelection,
    changeSftpSelectionPermissions,
    deleteSftpSelection,
    downloadSftpSelection,
    prepareSftpTransfer,
    prepareSftpExternalTransfer,
    transferSftpSelectionToPane,
    resolveSftpConflict,
    dismissSftpConflict,
    cancelTransfer,
    retryTransfer,
    dismissTransfer,
    handleSftpConnectionProgressEvent,
    handleTransferEvent,
  };
}
