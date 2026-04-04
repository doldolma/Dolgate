import { useTerminalSessionViewController } from '../../controllers/useTerminalSessionViewController';
import { TerminalChatToastRegion } from './TerminalChatToastRegion';
import { TerminalConnectionOverlay } from './TerminalConnectionOverlay';
import { TerminalInteractiveAuthOverlay } from './TerminalInteractiveAuthOverlay';
import { TerminalPaneHeader } from './TerminalPaneHeader';
import { TerminalSearchOverlay } from './TerminalSearchOverlay';
import { TerminalSharePopover } from './TerminalSharePopover';
import type { TerminalSessionPaneProps } from './types';

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

  return (
    <div
      className={`terminal-session ${visible ? 'visible' : 'hidden'} ${
        active ? 'active' : ''
      } ${showHeader ? 'terminal-session--pane' : ''}`}
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
        <div className="terminal-error-banner">{tab.errorMessage}</div>
      ) : null}
      {controller.terminalInitError ? (
        <div className="terminal-error-banner">
          {controller.terminalInitError}
        </div>
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

      <div ref={controller.containerRef} className="terminal-canvas">
        {controller.shouldShowConnectionOverlay ? (
          <TerminalConnectionOverlay
            error={tab?.status === 'error'}
            title={controller.connectionOverlayTitle}
            message={controller.connectionOverlayMessage}
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
