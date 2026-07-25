import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
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
import { AiChatPanel } from './AiChatPanel';
import { TerminalChatToastRegion } from './TerminalChatToastRegion';
import { TerminalConnectionOverlay } from './TerminalConnectionOverlay';
import { TerminalMoshStatusBar } from './TerminalMoshStatusBar';
import { TerminalTmuxStatusBar } from './TerminalTmuxStatusBar';
import { TerminalInteractiveAuthOverlay } from './TerminalInteractiveAuthOverlay';
import { TerminalPaneHeader } from './TerminalPaneHeader';
import { SerialSessionActions } from './SerialSessionActions';
import { TerminalSearchOverlay } from './TerminalSearchOverlay';
import { TerminalSharePopover } from './TerminalSharePopover';
import type { TerminalSessionPaneProps } from './types';
import { Button, NoticeCard } from '../../ui';
import { resolveConnectionFailurePresentation } from '../../store/utils';
import { TerminalAutocompleteOverlay } from './TerminalAutocompleteOverlay';
import { TerminalBlockOverlay } from './TerminalBlockOverlay';
import { TerminalBlockStickyHeader } from './TerminalBlockStickyHeader';
import { TerminalCommandPalette } from './TerminalCommandPalette';
import { SnippetVariablesDialog } from './SnippetVariablesDialog';
import type { CommandFinishedInfo } from '../../lib/command-notification';
import { supportsTmuxControlMode } from '../../lib/tmux-version';

// PASSTHROUGH_TMUX_COMMAND: control mode floor(2.6) 미만 tmux 를 일반 SSH 세션으로 띄울
// 때 접속 직후 셸에 자동 입력하는 호환 attach-or-create 명령. 모든 tmux 버전에서 동작
// (attach 실패 시 new 로 폴백). 1.8+ 면 'tmux new -A' 한 줄도 되지만, floor 미만(=구버전)
// 환경의 폭넓은 호환을 위해 가장 보수적인 폴백 형태를 쓴다.
const PASSTHROUGH_TMUX_COMMAND = 'tmux attach 2>/dev/null || tmux new';

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
    isPrimaryTmuxOverlayPane = true,
    onReopenInteractiveAuthUrl,
    onClearPendingInteractiveAuth,
    onOpenSessionShareChatWindow,
    tab,
  } = props;

  const snippets = useAppStore((state) => state.snippets);
  const connectHost = useAppStore((state) => state.connectHost);
  const killTmuxSession = useAppStore((state) => state.killTmuxSession);
  // tmux 하단바 "열기" — 같은 호스트로 control mode(tmux -CC) 연결을 시작한다(기본 dolgate 세션).
  // 이 세션(tab.sessionId)의 탭 자리를 재사용해 "현재 화면에서" tmux 가 열리게 한다.
  const handleOpenTmux = useCallback(() => {
    if (!tab?.hostId) {
      return;
    }
    const version = tab.tmuxAvailable?.version;
    // control mode floor(2.6) 미만 tmux 는 control client 사이즈 모델(refresh-client -C)
    // 이 없어 -CC 가 제대로 동작하지 않는다. 이 경우 control mode 대신 일반 SSH 세션을
    // 열고 접속 직후 호환 attach-or-create 명령을 자동 입력해 passthrough 로 tmux 를 띄운다.
    if (!supportsTmuxControlMode(version)) {
      void connectHost(
        tab.hostId,
        120,
        32,
        undefined,
        false, // tmux=false → 일반 SSH 세션(control mode 아님)
        undefined,
        tab.sessionId,
        undefined,
        undefined,
        PASSTHROUGH_TMUX_COMMAND, // startupCommandOverride
      );
      return;
    }
    void connectHost(
      tab.hostId,
      120,
      32,
      undefined,
      true,
      undefined,
      tab.sessionId,
      undefined,
      version,
    );
  }, [connectHost, tab?.hostId, tab?.sessionId, tab?.tmuxAvailable?.version]);
  // 하단바 드롭다운에서 감지된 특정 tmux 세션 [attach] — 그 세션 이름으로 control mode 진입.
  const handleAttachTmuxSession = useCallback(
    (name: string) => {
      if (!tab?.hostId) {
        return;
      }
      // tmux 세션 이름은 작은따옴표로 감싸 셸 인젝션을 막는다(이름 내 ' 는 escape).
      const quoted = `'${name.replace(/'/g, "'\\''")}'`;
      void connectHost(
        tab.hostId,
        120,
        32,
        undefined,
        true,
        `tmux -CC attach -t ${quoted}`,
        tab.sessionId,
        undefined,
        tab.tmuxAvailable?.version,
      );
    },
    [connectHost, tab?.hostId, tab?.sessionId, tab?.tmuxAvailable?.version],
  );
  // 하단바 드롭다운에서 이름 지정 신규 tmux 세션 생성 — new-session -s <name>(strict new;
  // 이름 충돌 시 tmux 에러 → 연결 실패 오버레이). attach 와 동일 escape, 현재 탭 재사용.
  const handleCreateTmuxSession = useCallback(
    (name: string) => {
      if (!tab?.hostId) {
        return;
      }
      const quoted = `'${name.replace(/'/g, "'\\''")}'`;
      void connectHost(
        tab.hostId,
        120,
        32,
        undefined,
        true,
        `tmux -CC new-session -s ${quoted}`,
        tab.sessionId,
        undefined,
        tab.tmuxAvailable?.version,
      );
    },
    [connectHost, tab?.hostId, tab?.sessionId, tab?.tmuxAvailable?.version],
  );
  // 감지 하단바에서 원격 tmux 세션 종료 — attach 없이. sessionId(이 SSH 세션)를 넘기면
  // Go runtime 이 control 세션이 아님을 보고 보조 exec 채널로 kill-session 후 목록을 재감지한다.
  const handleKillTmuxSession = useCallback(
    (name: string) => {
      killTmuxSession(sessionId, name);
    },
    [killTmuxSession, sessionId],
  );
  // tmux pane 분할은 상단 윈도우 바의 "분할" 버튼(또는 Ctrl-b % / ")이 담당한다.
  // pane 헤더/floating 의 │·─ 버튼은 헷갈려서 제거했다.
  // tmux pane 은 헤더/여백 없이 슬롯을 꽉 채운다 — 그래야 컨테이너 픽셀과 tmux 셀 그리드가
  // 일치해(여백만큼 행이 더 보고돼 밑이 짤리던 문제 제거) tmux 가 자기 경계선을 직접 그린다.
  const isTmuxPane = Boolean(tab?.tmux);
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
  const aiPanelOpen = useAppStore(
    (state) => state.aiConversations?.[sessionId]?.open ?? false,
  );
  const aiPanelWidth = useAppStore((state) => state.aiPanelWidth);
  // 블록 툴바의 AI 버튼은 AI 기능이 켜져 있을 때만 노출한다.
  const aiAssistantEnabled = useAppStore(
    (state) => state.settings?.ai?.enabled ?? false,
  );
  // 스티키 헤더가 떠 있고 hover 한 블록이 그 아래로 파고들면(=블록 상단이 화면 위로 잘린
  // 상태) 툴바가 헤더에 가린다. 그 겹치는 만큼만 툴바를 내린다.
  const blockToolbarTopOffset = (() => {
    const { blockOverlay, blockSticky } = controller;
    if (!blockOverlay || !blockSticky) {
      return 0;
    }
    const stickyBottom = blockSticky.top + blockSticky.height;
    return blockOverlay.top < stickyBottom
      ? stickyBottom - blockOverlay.top + 2
      : 0;
  })();
  const toggleAiPanel = useAppStore((state) => state.toggleAiPanel);
  // 선택/출력 캡처는 stableId 로 살아있는 런타임에서 읽는다(재연결로 sessionId가 바뀌어도 안정).
  const stableId = tab?.stableId ?? sessionId;
  const handlePaneKeyDownCapture = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      // ⌘I / Ctrl+I: AI 패널 토글. 나머지 단축키(검색 등)는 컨트롤러로 위임.
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        (event.key === 'i' || event.key === 'I')
      ) {
        event.preventDefault();
        toggleAiPanel(sessionId);
        return;
      }
      // ⌘/Ctrl+Shift+P: 명령 팔레트. 팔레트 표준 단축키라 다른 도구와 감각이 같고,
      // Ctrl+Shift+* 는 셸(readline)이 쓰지 않아 터미널 입력을 뺏지 않는다.
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        !event.altKey &&
        (event.key === 'p' || event.key === 'P')
      ) {
        event.preventDefault();
        // 이미 열려 있으면 다시 열지 않는다 — 컴포넌트가 리마운트되지 않아 검색어와
        // 선택 위치는 그대로인 채 목록만 새로 떠서, 강조된 행의 의미가 조용히 바뀐다.
        if (!controller.commandPaletteOpen) {
          controller.openCommandPalette();
        }
        return;
      }
      controller.handlePaneKeyDownCapture(event);
    },
    [controller, sessionId, toggleAiPanel],
  );

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
      // 자식(AI 패널)이 이미 처리한 드래그면 SFTP 업로드 오버레이를 끄고 물러난다.
      if (event.defaultPrevented) {
        setIsFileDropActive(false);
        return;
      }
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
      // 자식(AI 패널)이 이미 처리한 드롭이면 업로드하지 않는다.
      if (event.defaultPrevented) {
        setIsFileDropActive(false);
        return;
      }
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
            const awaitingHostTrust = result.reason === 'awaiting-host-trust';
            setUploadNotice({
              tone: awaitingHostTrust ? 'info' : 'danger',
              message: awaitingHostTrust
                ? (result.message ?? '호스트 키를 저장하면 업로드를 계속합니다.')
                : result.reason === 'unsupported'
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

  // Share 옆에 놓이는 AI 패널 토글(누르면 열림/닫힘). active=열림 상태 강조.
  const aiToggleButton = (
    <Button
      variant="secondary"
      size="sm"
      active={aiPanelOpen}
      className="min-h-9 rounded-full px-3.5"
      onClick={() => toggleAiPanel(sessionId)}
      title="AI 어시스턴트 (⌘I)"
      aria-label={aiPanelOpen ? 'AI 어시스턴트 닫기' : 'AI 어시스턴트 열기'}
    >
      AI
    </Button>
  );

  return (
    <div
      className={cn(
        'absolute inset-0 min-h-0 flex-col gap-[0.7rem]',
        visible || active
          ? 'flex pointer-events-auto opacity-100'
          : 'hidden pointer-events-none opacity-0',
        showHeader && 'p-[0.4rem]',
      )}
      style={style}
      onKeyDownCapture={handlePaneKeyDownCapture}
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

      <div className="flex min-h-0 min-w-0 flex-1 flex-row overflow-hidden">
        <div className="relative flex min-h-0 min-w-0 flex-1">
          {controller.canShareSession ? (
            <TerminalSharePopover
              anchorRef={controller.sharePopoverRef}
              showHeader={showHeader}
              open={controller.sharePopoverOpen}
              actions={serialActions}
              aiToggle={aiToggleButton}
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
          ) : (
            // 공유 불가 세션엔 Share 팝오버가 없으므로 AI 토글만 같은 위치에 띄운다.
            <div
              className={cn(
                'absolute right-[0.85rem] top-[0.85rem] z-[4] flex items-center',
                showHeader && 'right-[0.8rem] top-[0.8rem]',
              )}
            >
              {aiToggleButton}
            </div>
          )}

          <div
            ref={controller.containerRef}
            className={cn(
              'relative m-[0.35rem] flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[6px] bg-[color-mix(in_srgb,var(--surface)_96%,transparent_4%)] p-0 [&_.xterm]:min-h-full [&_.xterm]:h-full [&_.xterm]:w-full [&_.xterm-viewport]:min-h-full [&_.xterm-viewport]:h-full [&_.xterm-viewport]:w-full [&_.xterm-viewport]:bg-transparent [&_.xterm-viewport]:rounded-none',
              showHeader &&
                'mx-[0.35rem] mb-[0.35rem] mt-0 rounded-b-[6px] rounded-t-none border border-[var(--border)] border-t-0',
              // 명령 블록 점 마커가 들어갈 왼쪽 거터. 이 여백이 없으면 마커가 열 0 위에 그려져
              // 글자와 겹친다(GUTTER_WIDTH_PX 와 맞춰야 함). FitAddon 은 부모의 content width 로
              // cols 를 계산하므로 패딩만큼 자동 반영된다. tmux pane 은 컨테이너 px = tmux 셀
              // 그리드라 제외한다.
              !isTmuxPane && 'pl-[10px]',
              // tmux pane: 여백/라운드 제거 → 슬롯을 꽉 채워 컨테이너 px = tmux 셀 그리드.
              isTmuxPane && 'm-0 rounded-none border-0',
              // tmux control mode dead-zone 완화(최소·안전): 공유 크기 탓에 pane 렌더 영역보다
              // cell grid 가 작아 생기는 빈 영역(.xterm 요소 중 .xterm-screen 바깥)을, 컨테이너와
              // .xterm 배경을 패널 surface 로 맞춰 회색으로 튀지 않게 블렌딩한다. 실제 문자 셀
              // (.xterm-screen)의 터미널 테마 배경은 건드리지 않고, xterm 크기/FitAddon 측정도
              // 그대로 둬(렌더 안정성 보존) 그리드는 좌상단 정렬이되 여백이 배경과 동색이라 덜 띈다.
              tab?.tmux && 'bg-[var(--surface)] [&_.xterm]:bg-[var(--surface)]',
            )}
            data-terminal-canvas="true"
            data-tmux-pane={tab?.tmux ? 'true' : undefined}
            onMouseMove={controller.handleBlockPointerMove}
            onMouseLeave={controller.clearBlockHover}
          >
            {controller.commandPaletteOpen ? (
              <TerminalCommandPalette
                items={controller.commandPaletteItems}
                onClose={controller.closeCommandPalette}
                onJump={controller.handleCommandPaletteJump}
                onRerun={controller.handleCommandPaletteRerun}
              />
            ) : null}
            {controller.blockSticky ? (
              <TerminalBlockStickyHeader
                sticky={controller.blockSticky}
                onJumpToCommand={controller.scrollToStickyBlock}
              />
            ) : null}
            {controller.blockOverlay ? (
              <TerminalBlockOverlay
                overlay={controller.blockOverlay}
                onCopyOutput={controller.handleBlockCopyOutput}
                onCopyCommand={controller.handleBlockCopyCommand}
                onRerun={controller.handleBlockRerun}
                rerunEnabled={controller.blockRerunEnabled}
                onAskAi={controller.handleBlockAskAi}
                aiEnabled={aiAssistantEnabled}
                toolbarTopOffset={blockToolbarTopOffset}
              />
            ) : null}
            {isFileDropActive ? (
              <div className="pointer-events-none absolute inset-0 z-[6] flex items-center justify-center rounded-[6px] border-2 border-dashed border-[color-mix(in_srgb,var(--accent-strong)_60%,transparent)] bg-[color-mix(in_srgb,var(--accent-strong)_14%,transparent)]">
                <span className="rounded-[6px] bg-[var(--surface)] px-3 py-1.5 text-sm font-medium text-[var(--text)] shadow-[var(--shadow)]">
                  여기로 업로드 → {getSessionCwd(sessionId) ?? '홈 디렉터리'}
                </span>
              </div>
            ) : null}
            {/* tmux pane 분할은 상단 윈도우 바의 "분할" 버튼(또는 Ctrl-b % / ")으로 한다.
                pane 마다 떠 헷갈리던 floating │/─ 버튼은 제거했다. */}
            {controller.shouldShowConnectionOverlay && isPrimaryTmuxOverlayPane ? (
              <TerminalConnectionOverlay
                error={tab?.status === 'error'}
                title={controller.connectionOverlayTitle}
                message={controller.connectionOverlayMessage}
                steps={tab?.connectionHops}
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
        </div>
        {aiPanelOpen ? (
          <AiChatPanel sessionId={sessionId} stableId={stableId} width={aiPanelWidth} />
        ) : null}
      </div>
      {tab?.moshState ? (
        <TerminalMoshStatusBar
          state={tab.moshState}
          lastResponseAt={tab.lastMoshResponseAt ?? null}
        />
      ) : null}
      {tab?.tmuxAvailable && !tab.tmux ? (
        <TerminalTmuxStatusBar
          version={tab.tmuxAvailable.version}
          sessions={tab.tmuxAvailable.sessions}
          onOpen={handleOpenTmux}
          onAttachSession={handleAttachTmuxSession}
          onCreateSession={handleCreateTmuxSession}
          onKillSession={handleKillTmuxSession}
        />
      ) : null}
    </div>
  );
}
