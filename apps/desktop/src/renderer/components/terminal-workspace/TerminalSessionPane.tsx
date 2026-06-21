import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DragEvent } from 'react';
import {
  isAwsEc2HostRecord,
  isSshHostRecord,
  isWarpgateSshHostRecord,
} from '@shared';
import { cn } from '../../lib/cn';
import { useAppStore } from '../../store/appStore';
import {
  extractDroppedAbsolutePaths,
  hasExternalFileDrop,
} from '../../lib/file-drop';
import { getSessionCwd } from '../../lib/terminal-cwd-registry';
import { getPathForDroppedFile } from '../../services/desktop/files';
import { useTerminalSessionViewController } from '../../controllers/useTerminalSessionViewController';
import { TerminalChatToastRegion } from './TerminalChatToastRegion';
import { TerminalConnectionOverlay } from './TerminalConnectionOverlay';
import { TerminalMoshStatusBar } from './TerminalMoshStatusBar';
import { TerminalInteractiveAuthOverlay } from './TerminalInteractiveAuthOverlay';
import { TerminalPaneHeader } from './TerminalPaneHeader';
import { SerialSessionActions } from './SerialSessionActions';
import { TerminalSearchOverlay } from './TerminalSearchOverlay';
import { TerminalSharePopover } from './TerminalSharePopover';
import type { TerminalSessionPaneProps } from './types';
import { NoticeCard } from '../../ui';
import { resolveConnectionFailurePresentation } from '../../store/utils';
import { TerminalAutocompleteOverlay } from './TerminalAutocompleteOverlay';
import { SnippetVariablesDialog } from './SnippetVariablesDialog';
import type { CommandFinishedInfo } from '../../lib/command-notification';

export function TerminalSessionPane(props: TerminalSessionPaneProps) {
  const {
    sessionId,
    title,
    visible,
    active,
    style,
    showHeader = false,
    draggingDisabled = false,
    interactiveAuth,
    onFocus,
    onClose,
    onRetry,
    onCancelReconnect,
    onReopenInteractiveAuthUrl,
    onClearPendingInteractiveAuth,
    onOpenSessionShareChatWindow,
    tab,
  } = props;

  const snippets = useAppStore((state) => state.snippets);
  const notifyCommandFinished = useAppStore(
    (state) => state.notifyCommandFinished,
  );
  const onCommandFinished = useCallback(
    (info: CommandFinishedInfo) => {
      // 사용자가 이 명령의 출력을 지금 보고 있으면(앱 포커스 + 활성 탭) 알리지 않는다.
      notifyCommandFinished(info, {
        visibleToUser: document.hasFocus() && active,
        hostLabel: props.host?.label ?? '',
      });
    },
    [notifyCommandFinished, active, props.host],
  );
  const controller = useTerminalSessionViewController({
    ...props,
    snippets,
    onCommandFinished,
  });
  const [serialNotice, setSerialNotice] = useState<string | null>(null);

  useEffect(() => {
    setSerialNotice(null);
  }, [sessionId]);

  useEffect(() => {
    if (!serialNotice) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setSerialNotice(null);
    }, 4000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [serialNotice]);

  const serialActions = useMemo(
    () => (
      <SerialSessionActions
        sessionId={sessionId}
        host={props.host}
        connected={tab?.status === 'connected'}
        onNotice={setSerialNotice}
      />
    ),
    [props.host, sessionId, tab?.status],
  );
  const connectionFailurePresentation = useMemo(
    () =>
      tab?.errorMessage
        ? resolveConnectionFailurePresentation(tab.errorMessage)
        : null,
    [tab?.errorMessage],
  );

  // --- 터미널 파일 드롭 → 현재 cwd로 SFTP 업로드 ---
  const uploadLocalFilesToHost = useAppStore(
    (state) => state.uploadLocalFilesToHost,
  );
  const uploadHost = props.host;
  const canReceiveFileUpload =
    tab?.status === 'connected' &&
    tab?.source === 'host' &&
    !!uploadHost &&
    (isSshHostRecord(uploadHost) ||
      isAwsEc2HostRecord(uploadHost) ||
      isWarpgateSshHostRecord(uploadHost));
  const [isFileDropActive, setIsFileDropActive] = useState(false);
  const [uploadNotice, setUploadNotice] = useState<{
    tone: 'info' | 'warning' | 'danger';
    message: string;
  } | null>(null);
  // SFTP 연결을 새로 여는 동안(특히 SSM은 수 초 소요) 보여줄 준비 상태.
  // 전송이 실제 시작되기 전까지의 공백을 메운다. 자동 사라지지 않는다.
  const [uploadPending, setUploadPending] = useState<string | null>(null);

  useEffect(() => {
    if (!uploadNotice) {
      return;
    }
    const timeoutId = window.setTimeout(() => setUploadNotice(null), 5000);
    return () => window.clearTimeout(timeoutId);
  }, [uploadNotice]);

  const handleFileDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!canReceiveFileUpload || !hasExternalFileDrop(event.dataTransfer)) {
        return;
      }
      // 세션 탭(분할) 드래그가 아닌 OS 파일 드롭만 가로챈다.
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setIsFileDropActive(true);
    },
    [canReceiveFileUpload],
  );

  const handleFileDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setIsFileDropActive(false);
  }, []);

  const handleFileDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!canReceiveFileUpload || !hasExternalFileDrop(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      setIsFileDropActive(false);
      const hostId = tab?.hostId;
      if (!hostId) {
        return;
      }
      const droppedFiles = Array.from(event.dataTransfer.files);
      void (async () => {
        const localPaths = await extractDroppedAbsolutePaths(
          droppedFiles,
          getPathForDroppedFile,
        );
        if (localPaths.length === 0) {
          setUploadNotice({
            tone: 'danger',
            message: '드롭한 파일 경로를 읽지 못했습니다.',
          });
          return;
        }
        setUploadNotice(null);
        setUploadPending(
          `${localPaths.length}개 파일 업로드 준비 중… (SFTP 연결)`,
        );
        try {
          const result = await uploadLocalFilesToHost(
            {
              hostId,
              targetPath: getSessionCwd(sessionId),
              localPaths,
            },
            (message) => setUploadPending(message),
          );
          if (!result.ok) {
            setUploadNotice({
              tone: 'danger',
              message:
                result.reason === 'unsupported'
                  ? '이 세션은 SFTP 업로드를 지원하지 않습니다.'
                  : result.reason === 'connect-failed'
                    ? `SFTP 연결 실패: ${result.message ?? ''}`
                    : (result.message ?? '업로드할 항목이 없습니다.'),
            });
            return;
          }
          setUploadNotice(
            result.usedHomeFallback
              ? {
                  tone: 'warning',
                  message: `현재 경로를 찾지 못해 홈(${result.targetPath})에 업로드합니다.`,
                }
              : {
                  tone: 'info',
                  message: `${result.targetPath} 에 업로드를 시작했습니다.`,
                },
          );
        } finally {
          setUploadPending(null);
        }
      })();
    },
    [canReceiveFileUpload, tab?.hostId, sessionId, uploadLocalFilesToHost],
  );

  return (
    <div
      className={cn(
        'absolute inset-0 min-h-0 flex-col gap-[0.65rem]',
        visible || active
          ? 'flex pointer-events-auto opacity-100'
          : 'hidden pointer-events-none opacity-0',
        showHeader && 'p-[0.45rem]',
      )}
      style={style}
      onKeyDownCapture={controller.handlePaneKeyDownCapture}
      onMouseDown={controller.handlePaneMouseDown}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
    >
      {controller.canShareSession ? (
        <TerminalChatToastRegion
          notifications={controller.visibleSessionShareChatNotifications}
        />
      ) : null}

      {controller.canShareSession ? (
        <TerminalSharePopover
          anchorRef={controller.sharePopoverRef}
          showHeader={showHeader}
          open={controller.sharePopoverOpen}
          actions={serialActions}
          canStartShare={controller.canStartShare}
          shareCopyStatus={controller.shareCopyStatus}
          shareState={controller.shareState}
          onToggle={controller.toggleSharePopover}
          onStartShare={() => {
            void controller.handleStartShare();
          }}
          onCopyShareUrl={() => {
            void controller.handleCopyShareUrl();
          }}
          onSetInputEnabled={controller.handleSetSessionShareInputMode}
          onOpenChatWindow={controller.handleOpenShareChatWindow}
          onStopShare={controller.handleStopShare}
          canOpenChatWindow={Boolean(onOpenSessionShareChatWindow)}
        />
      ) : null}

      {showHeader ? (
        <TerminalPaneHeader
          sessionId={sessionId}
          title={title}
          active={active}
          draggingDisabled={draggingDisabled}
          closingDisabled={!onClose || tab?.status === 'disconnecting'}
          onFocus={onFocus}
          onClose={() => {
            void onClose?.();
          }}
          onStartDrag={props.onStartDrag}
          onEndDrag={props.onEndDrag}
        />
      ) : null}

      {tab?.errorMessage ? (
        <NoticeCard tone="danger" className="mx-[0.55rem] mt-[0.55rem]" role="alert">
          {connectionFailurePresentation?.message ?? tab.errorMessage}
        </NoticeCard>
      ) : null}
      {serialNotice ? (
        <NoticeCard tone="warning" className="mx-[0.55rem] mt-[0.55rem]" role="status">
          {serialNotice}
        </NoticeCard>
      ) : null}
      {uploadPending ? (
        <NoticeCard
          tone="info"
          className="mx-[0.55rem] mt-[0.55rem] animate-pulse"
          role="status"
        >
          {uploadPending}
        </NoticeCard>
      ) : null}
      {uploadNotice ? (
        <NoticeCard
          tone={uploadNotice.tone}
          className="mx-[0.55rem] mt-[0.55rem]"
          role="status"
        >
          {uploadNotice.message}
        </NoticeCard>
      ) : null}
      {controller.terminalInitError ? (
        <NoticeCard tone="danger" className="mx-[0.55rem] mt-[0.55rem]" role="alert">
          {controller.terminalInitError}
        </NoticeCard>
      ) : null}

      {interactiveAuth ? (
        <TerminalInteractiveAuthOverlay
          interactiveAuth={interactiveAuth}
          promptResponses={controller.promptResponses}
          onPromptResponseChange={controller.handleInteractiveAuthPromptChange}
          onSubmit={() => {
            void controller.handleInteractiveAuthSubmit();
          }}
          onCopyApprovalUrl={controller.handleCopyInteractiveAuthApprovalUrl}
          onReopenApprovalUrl={() => {
            void onReopenInteractiveAuthUrl();
          }}
          onClose={() => {
            void onClearPendingInteractiveAuth();
          }}
        />
      ) : null}

      {controller.searchOpen ? (
        <TerminalSearchOverlay
          inputRef={controller.searchInputRef}
          searchQuery={controller.searchQuery}
          onBlur={controller.blurSearch}
          onChange={controller.handleSearchQueryChange}
          onKeyDown={controller.handleSearchInputKeyDown}
          onFindPrevious={controller.findPreviousSearchMatch}
          onFindNext={controller.findNextSearchMatch}
          onClose={controller.closeSearchOverlay}
        />
      ) : null}

      <div
        ref={controller.containerRef}
        className={cn(
          'relative m-[0.55rem] flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[6px] bg-[color-mix(in_srgb,var(--surface)_96%,transparent_4%)] p-0 [&_.xterm]:min-h-full [&_.xterm]:h-full [&_.xterm]:w-full [&_.xterm-viewport]:min-h-full [&_.xterm-viewport]:h-full [&_.xterm-viewport]:w-full [&_.xterm-viewport]:bg-transparent [&_.xterm-viewport]:rounded-none',
          showHeader &&
            'mx-[0.55rem] mb-[0.55rem] mt-0 rounded-b-[6px] rounded-t-none border border-[var(--border)] border-t-0',
        )}
        data-terminal-canvas="true"
      >
        {isFileDropActive ? (
          <div className="pointer-events-none absolute inset-0 z-[6] flex items-center justify-center rounded-[6px] border-2 border-dashed border-[color-mix(in_srgb,var(--accent-strong)_60%,transparent)] bg-[color-mix(in_srgb,var(--accent-strong)_14%,transparent)]">
            <span className="rounded-[6px] bg-[var(--surface)] px-3 py-1.5 text-sm font-medium text-[var(--text)] shadow-[var(--shadow)]">
              여기로 업로드 → {getSessionCwd(sessionId) ?? '홈 디렉터리'}
            </span>
          </div>
        ) : null}
        {controller.shouldShowConnectionOverlay ? (
          <TerminalConnectionOverlay
            error={tab?.status === 'error'}
            title={controller.connectionOverlayTitle}
            message={controller.connectionOverlayMessage}
            showRetry={tab?.connectionProgress?.retryable !== false}
            onRetry={() => {
              void onRetry?.();
            }}
            onClose={() => {
              void onClose?.();
            }}
            showCancel={
              tab?.connectionProgress?.stage === 'reconnecting' &&
              tab?.status !== 'error'
            }
            onCancel={() => {
              void onCancelReconnect?.();
            }}
          />
        ) : null}
        <TerminalAutocompleteOverlay
          suggestions={controller.autocompleteSuggestions}
          command={controller.autocompleteCommand}
          anchor={controller.autocompleteAnchor}
          selectedIndex={controller.autocompleteSelectedIndex}
          onAccept={controller.acceptAutocompleteSuggestion}
        />
        <SnippetVariablesDialog
          pending={controller.autocompletePendingSnippet}
          onConfirm={controller.confirmAutocompleteSnippet}
          onCancel={controller.cancelAutocompleteSnippet}
        />
      </div>
      {tab?.moshState ? (
        <TerminalMoshStatusBar
          state={tab.moshState}
          lastResponseAt={tab.lastMoshResponseAt ?? null}
        />
      ) : null}
    </div>
  );
}
