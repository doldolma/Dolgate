import type { MutableRefObject, ReactNode } from 'react';
import type { SessionShareStatus, TerminalTab } from '@shared';
import { cn } from '../../lib/cn';
import { Button, IconButton } from '../../ui';
import { Keyboard, Share2 } from '../../ui/icons';
import {
  CHROME_TOGGLE_CLASS,
  CHROME_TOGGLE_ON_CLASS,
} from '../chrome-toggle';
import { useTranslation } from 'react-i18next';

interface TerminalSharePopoverProps {
  anchorRef: MutableRefObject<HTMLDivElement | null>;
  /**
   * 이 묶음이 어디에 놓이는가. 팝오버 내용은 두 자리에서 **똑같다** — 바뀌는 것은 트리거
   * 버튼의 크기와 묶음의 정렬뿐이다.
   *
   * `inline` = pane 헤더 안(분할 화면). `chrome` = 상단 바의 세션 패널 토글 옆(단독 화면에서
   * 터미널 위에 떠 있던 알약이 여기로 왔다).
   */
  variant?: 'inline' | 'chrome';
  open: boolean;
  actions?: ReactNode;
  // Share 버튼 왼쪽에 함께 놓이는 토글(AI 패널 등).
  canStartShare: boolean;
  /**
   * 시작할 수 없는 이유. 있으면 버튼 대신 이것을 적는다.
   *
   * 버튼을 감추지 않는 이유는 감추면 그 기능이 아예 없는 줄 알기 때문이다 — 계정 없이 쓰는
   * 동안에는 공유가 서버를 거치므로 못 하는데, 그것은 로그인하면 풀린다.
   */
  unavailableReason?: string | null;
  /** 못 하는 이유가 로그인이면, 그 자리에서 로그인 창을 연다. */
  onRequestLogin?: () => void;
  shareCopyStatus: string | null;
  shareState: TerminalTab['sessionShare'] | null;
  onToggle: () => void;
  onStartShare: () => void;
  onCopyShareUrl: () => void;
  onSetInputEnabled: (inputEnabled: boolean) => void;
  onOpenChatWindow: () => void;
  onStopShare: () => void;
  canOpenChatWindow: boolean;
}

/** 공유가 돌고 있는가. 이때는 버튼이 평소 스킨을 버리고 색으로 채워진다. */
function isShareLive(status: SessionShareStatus | undefined): boolean {
  return status === 'starting' || status === 'active' || status === 'error';
}

/**
 * 공유 중일 때 상단 바 버튼을 채우는 색.
 *
 * **이 자리만 고정값이다.** 상단 바는 라이트·다크 양쪽에서 늘 진한 남색(`--chrome-bg`)인데
 * `--success`·`--accent` 같은 토큰은 밝은 표면 기준으로 잡혀 있어 그 위에서 죽는다 — 처음엔
 * 토큰으로 작은 점을 찍었더니 남색 위 남색이 되어 켜져 있는지 보이지 않았다.
 * `CHROME_TOGGLE_CLASS` 가 `rgba(255,255,255,…)` 를 박아 둔 것과 같은 이유다.
 *
 * 세 색 모두 남색 배경과 3:1 을 넘기면서 그 위의 흰 글자도 읽히는 선에서 골랐다.
 *
 * **입력을 허용한 공유는 다른 색이다.** 보기만 하는 것과 남이 내 터미널에 명령을 칠 수 있는
 * 것은 위험이 다른데, 켜 둔 채로 잊기 쉬운 쪽은 후자다. 초록(보기만)과 앰버(칠 수 있음)로
 * 가르고, 색만으로 갈리지 않게 아이콘도 함께 바꾼다.
 *
 * `starting` 도 채운다: 링크가 아직 없어도 세션 화면은 이미 넘어가고 있다. `error` 는 붉게
 * 채운다 — 공유가 끊긴 것을 모르는 편이 더 나쁘다.
 */
function chromeShareFill(
  status: SessionShareStatus | undefined,
  inputAllowed: boolean,
): string | undefined {
  if (status === 'error') {
    return '#e2504a';
  }
  if (!isShareLive(status)) {
    return undefined;
  }
  return inputAllowed ? '#b8770c' : '#15916b';
}

// 채워졌을 때의 상단 바 버튼. 이 상태만 IconButton 을 쓰지 않는다 — 그쪽은 정사각 아이콘
// 한 칸(`inline-grid`, 고정 너비)이라 아이콘 옆에 사람 수를 세우려면 크기·정렬·앱 표면
// 기준의 배경·테두리·글자색을 전부 되돌려야 한다. 평소 상태는 그대로 IconButton 이다.
const CHROME_SHARE_LIVE_BUTTON =
  'relative inline-flex h-9 min-h-9 items-center gap-[0.3rem] rounded-[10px] border border-transparent px-[0.55rem] text-white shadow-none transition-[background-color,filter] duration-150 hover:brightness-110 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[rgba(255,255,255,0.24)]';

// pane 헤더 안에 놓일 때의 Share 버튼 스킨. 헤더는 한 줄 크롬이라 36px 알약이 들어가면 헤더가
// 그만큼 두꺼워진다 — 닫기 아이콘(1.25rem)과 같은 높이로 맞춘다.
const SHARE_INLINE_BUTTON =
  'h-[1.25rem] min-h-0 rounded-[5px] border-0 px-[0.3rem] text-[0.65rem] font-semibold';
const SHARE_INLINE_IDLE =
  'bg-transparent text-[var(--text-soft)] hover:bg-[color-mix(in_srgb,var(--surface)_88%,transparent_12%)] hover:text-[var(--text)]';

// pane 헤더는 상단 바와 달리 앱 표면 위에 있다 — 여기서는 토큰이 제 일을 하므로 고정값을
// 쓰지 않는다(테마를 따라 같이 바뀐다). 가르는 기준은 상단 바와 같다.
function shareInlineLiveClass(
  status: SessionShareStatus | undefined,
  inputAllowed: boolean,
): string | undefined {
  if (status === 'error') {
    return 'bg-[var(--danger-bg)] text-[var(--danger-text)]';
  }
  if (!isShareLive(status)) {
    return undefined;
  }
  return inputAllowed
    ? 'bg-[var(--warning-bg)] text-[var(--warning-text)]'
    : 'bg-[var(--success-bg)] text-[var(--success-text)]';
}

export function TerminalSharePopover({
  anchorRef,
  variant = 'inline',
  open,
  actions,
  canStartShare,
  unavailableReason = null,
  onRequestLogin,
  shareCopyStatus,
  shareState,
  onToggle,
  onStartShare,
  onCopyShareUrl,
  onSetInputEnabled,
  onOpenChatWindow,
  onStopShare,
  canOpenChatWindow,
}: TerminalSharePopoverProps) {
  const { t: translate } = useTranslation();
  const inline = variant === 'inline';
  const status = shareState?.status;
  const live = isShareLive(status);
  // 실패한 공유에는 입력이랄 것이 없다 — 그 상태는 붉은색 하나로만 말한다.
  const inputAllowed = live && status !== 'error' && Boolean(shareState?.inputEnabled);
  // 색만으로 갈리면 색약인 사람에게는 같은 칩이다. 아이콘도 함께 바꾼다.
  const ChipIcon = inputAllowed ? Keyboard : Share2;
  // 버튼 이름은 어느 상태에서도 'Share' 다(스크린리더·테스트가 그것으로 찾는다). 상태와 보는
  // 사람 수는 tooltip 으로 붙인다 — 화면에 보이는 숫자를 이름에 섞으면 이름이 흔들린다.
  const shareTitle =
    status === 'active'
      ? [
          'Share',
          translate('sharePopover.viewers', { count: shareState?.viewerCount ?? 0 }),
          translate(inputAllowed ? 'sharePopover.allowInput' : 'sharePopover.readOnly'),
        ].join(' · ')
      : status === 'starting'
        ? `Share · ${translate('sharePopover.preparing')}`
        : status === 'error'
          ? `Share · ${translate('sharePopover.failed')}`
          : 'Share';
  return (
    <div
      ref={anchorRef}
      className={cn(
        'relative flex items-center',
        inline ? 'gap-[0.15rem]' : 'gap-2 [-webkit-app-region:no-drag]',
      )}
    >
      {actions}
      {inline ? (
        <Button
          variant="secondary"
          size="sm"
          className={cn(
            SHARE_INLINE_BUTTON,
            shareInlineLiveClass(status, inputAllowed) ?? SHARE_INLINE_IDLE,
          )}
          aria-label="Share"
          title={shareTitle}
          onClick={onToggle}
        >
          {/* 읽기 전용에는 아이콘을 두지 않는다 — 여기 아이콘은 "남이 칠 수 있다" 는 표시다. */}
          {inputAllowed ? (
            <Keyboard
              data-testid="session-share-input-icon"
              className="mr-[0.2rem] inline-block h-[0.7rem] w-[0.7rem] align-middle"
              aria-hidden="true"
            />
          ) : null}
          Share
          {status === 'active' ? (
            <span data-testid="session-share-viewers" className="ml-[0.25rem]">
              {shareState?.viewerCount ?? 0}
            </span>
          ) : null}
        </Button>
      ) : live ? (
        // 공유 중에는 아이콘만으로는 티가 나지 않는다 — 칩을 색으로 채우고 보는 사람 수를
        // 함께 세운다. 켜고 끌 때만 너비가 바뀌므로 상단 바가 흔들리지는 않는다.
        <button
          type="button"
          data-testid="session-share-live"
          className={cn(
            CHROME_SHARE_LIVE_BUTTON,
            status === 'starting' && 'animate-pulse',
          )}
          style={{ backgroundColor: chromeShareFill(status, inputAllowed) }}
          aria-pressed={open}
          aria-label="Share"
          title={shareTitle}
          onClick={onToggle}
        >
          <ChipIcon
            data-testid={inputAllowed ? 'session-share-input-icon' : 'session-share-icon'}
            className="h-[1.15rem] w-[1.15rem]"
            aria-hidden="true"
          />
          {status === 'active' ? (
            <span
              data-testid="session-share-viewers"
              className="text-[0.78rem] font-semibold leading-none"
            >
              {shareState?.viewerCount ?? 0}
            </span>
          ) : null}
        </button>
      ) : (
        // 상단 바에서는 옆의 패널·하단바 토글과 같은 아이콘 버튼이다 — 글자 알약을 두면 그
        // 줄에서 그것만 튄다. 이름은 그대로 `Share` 다(스크린리더·테스트가 그것으로 찾는다).
        <IconButton
          tone="default"
          size="sm"
          className={cn(CHROME_TOGGLE_CLASS, open && CHROME_TOGGLE_ON_CLASS)}
          aria-pressed={open}
          aria-label="Share"
          title={shareTitle}
          onClick={onToggle}
        >
          <Share2 className="h-[1.15rem] w-[1.15rem]" aria-hidden="true" />
        </IconButton>
      )}
      {open ? (
        // 글자색을 여기서 못 박는다. 이 판은 상단 바(흰 글자 · 어두운 배경) 안에 뜨므로
        // 색을 물려받으면 흰 배경에 흰 글자가 되어 제목이 사라진다 — 실제로 그렇게 됐다.
        <div className="absolute right-0 top-[calc(100%+0.6rem)] z-30 grid min-w-0 w-[min(24rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] gap-3 overflow-hidden rounded-[12px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] p-4 text-[var(--text)] shadow-[var(--shadow-soft)]">
          {shareState?.status === 'inactive' || !shareState ? (
            <>
              {/* 판 이름("Session Share")은 두지 않는다 — 바로 아래 줄이 같은 말을 하고,
                  이 판은 Share 버튼을 눌러서 열린다. 이름표는 자리만 먹었다. */}
              <strong>{translate('sharePopover.title')}</strong>
              <p className="mt-2 text-sm leading-[1.55] text-[var(--text-soft)]">
                {unavailableReason ?? translate('sharePopover.hint')}
              </p>
              {unavailableReason ? (
                onRequestLogin ? (
                  <Button
                    variant="primary"
                    className="mt-4 w-full"
                    onClick={onRequestLogin}
                  >
                    {translate('localOnly.login')}
                  </Button>
                ) : null
              ) : (
                <Button
                  variant="primary"
                  className="mt-4 w-full"
                  onClick={onStartShare}
                  disabled={!canStartShare}
                >
                  {translate('sharePopover.start')}
                </Button>
              )}
            </>
          ) : (
            <>
              <strong>
                {shareState.status === 'error'
                  ? translate('sharePopover.failed')
                  : shareState.status === 'starting'
                    ? translate('sharePopover.preparing')
                    : translate('sharePopover.ready')}
              </strong>
              {shareState.errorMessage ? (
                <p className="mt-2 text-sm text-[var(--danger-text)]">
                  {shareState.errorMessage}
                </p>
              ) : null}
              {shareState.shareUrl ? (
                <button
                  type="button"
                  className="mt-3 flex min-w-0 w-full items-center justify-between gap-3 rounded-[12px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] px-4 py-3 text-left transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--surface-muted)_94%,transparent_6%)]"
                  onClick={onCopyShareUrl}
                  aria-label={translate('sharePopover.copyLink')}
                  title={translate('sharePopover.copyLinkTitle')}
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">
                    {shareState.shareUrl}
                  </span>
                  <span
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] text-[var(--text-soft)]"
                    aria-hidden="true"
                  >
                    <svg viewBox="0 0 16 16" focusable="false">
                      <path
                        d="M5.75 2.5a1.75 1.75 0 0 0-1.75 1.75v5.5A1.75 1.75 0 0 0 5.75 11.5h5.5A1.75 1.75 0 0 0 13 9.75v-5.5A1.75 1.75 0 0 0 11.25 2.5h-5.5Zm-3 4.25a.75.75 0 0 1 .75.75v4.25c0 .69.56 1.25 1.25 1.25H9a.75.75 0 0 1 0 1.5H4.75A2.75 2.75 0 0 1 2 11.75V7.5a.75.75 0 0 1 .75-.75Z"
                        fill="currentColor"
                      />
                    </svg>
                  </span>
                </button>
              ) : shareState.status !== 'error' ? (
                <p className="mt-3 text-sm text-[var(--text-soft)]">{translate('sharePopover.creatingLink')}</p>
              ) : null}
              <div className="mt-3 space-y-3">
                <span className="block text-sm text-[var(--text-soft)]">
                  {translate('sharePopover.viewers', { count: shareState.viewerCount })}
                </span>
                <div
                  className="inline-flex rounded-full border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] p-1"
                  role="group"
                  aria-label={translate('sharePopover.inputModeAria')}
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    active={!shareState.inputEnabled}
                    className="rounded-full px-3"
                    onClick={() => {
                      onSetInputEnabled(false);
                    }}
                    disabled={
                      shareState.status !== 'active' &&
                      shareState.status !== 'starting'
                    }
                    aria-pressed={!shareState.inputEnabled}
                  >
                    {translate('sharePopover.readOnly')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    active={shareState.inputEnabled}
                    className="rounded-full px-3"
                    onClick={() => {
                      onSetInputEnabled(true);
                    }}
                    disabled={
                      shareState.status !== 'active' &&
                      shareState.status !== 'starting'
                    }
                    aria-pressed={shareState.inputEnabled}
                  >
                    {translate('sharePopover.allowInput')}
                  </Button>
                </div>
              </div>
              {shareCopyStatus ? (
                <div className="mt-3 text-sm text-[var(--text-soft)]">
                  {shareCopyStatus}
                </div>
              ) : null}
              <div className="mt-4 flex items-center justify-end gap-3">
                <Button
                  variant="secondary"
                  onClick={onOpenChatWindow}
                  disabled={shareState.status !== 'active' || !canOpenChatWindow}
                >
                  {translate('sharePopover.chatHistory')}
                </Button>
                <Button
                  variant="danger"
                  onClick={onStopShare}
                >
                  {translate('sharePopover.stop')}
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
