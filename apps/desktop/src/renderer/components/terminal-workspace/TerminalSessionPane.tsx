import { useEffect, useMemo, useState } from 'react';
import { cn } from '../../lib/cn';
import { useTerminalSessionViewController } from '../../controllers/useTerminalSessionViewController';
import { TerminalChatToastRegion } from './TerminalChatToastRegion';
import { TerminalConnectionOverlay } from './TerminalConnectionOverlay';
import { TerminalInteractiveAuthOverlay } from './TerminalInteractiveAuthOverlay';
import { TerminalPaneHeader } from './TerminalPaneHeader';
import { SerialSessionActions } from './SerialSessionActions';
import { TerminalSearchOverlay } from './TerminalSearchOverlay';
import { TerminalSharePopover } from './TerminalSharePopover';
import type { TerminalSessionPaneProps } from './types';
import { NoticeCard } from '../../ui';

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
    onReopenInteractiveAuthUrl,
    onClearPendingInteractiveAuth,
    onOpenSessionShareChatWindow,
    tab,
  } = props;

  const controller = useTerminalSessionViewController(props);
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
          {tab.errorMessage}
        </NoticeCard>
      ) : null}
      {serialNotice ? (
        <NoticeCard tone="warning" className="mx-[0.55rem] mt-[0.55rem]" role="status">
          {serialNotice}
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
          />
        ) : null}
      </div>
    </div>
  );
}
