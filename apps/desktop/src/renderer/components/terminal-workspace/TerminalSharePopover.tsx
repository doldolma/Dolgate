import type { MutableRefObject, ReactNode } from 'react';
import type { TerminalTab } from '@shared';
import { cn } from '../../lib/cn';
import { Button, SectionLabel } from '../../ui';
import { useTranslation } from 'react-i18next';

interface TerminalSharePopoverProps {
  anchorRef: MutableRefObject<HTMLDivElement | null>;
  showHeader: boolean;
  /**
   * 이 묶음이 어디에 놓이는가.
   *
   * `inline` = pane 헤더 안(헤더가 있는 워크스페이스 pane). `floating` = 터미널 위에 뜨는
   * 절대 위치(헤더가 없는 tmux·standalone 경로). 팝오버는 두 경우 모두 이 묶음을 기준으로
   * 열리므로, 바뀌는 것은 묶음 자체의 위치와 버튼 크기뿐이다.
   */
  variant?: 'inline' | 'floating';
  open: boolean;
  actions?: ReactNode;
  // Share 버튼 왼쪽에 함께 놓이는 토글(AI 패널 등).
  canStartShare: boolean;
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

// 헤더 안에 놓일 때의 Share 버튼 스킨. 헤더는 한 줄 크롬이라 36px 알약이 들어가면 헤더가
// 그만큼 두꺼워진다 — 닫기 아이콘(1.25rem)과 같은 높이로 맞춘다.
const SHARE_INLINE_BUTTON =
  'h-[1.25rem] min-h-0 rounded-[5px] border-0 bg-transparent px-[0.3rem] text-[0.65rem] font-semibold text-[var(--text-soft)] hover:bg-[color-mix(in_srgb,var(--surface)_88%,transparent_12%)] hover:text-[var(--text)]';

export function TerminalSharePopover({
  anchorRef,
  showHeader,
  variant = 'floating',
  open,
  actions,
  canStartShare,
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
  return (
    <div
      ref={anchorRef}
      className={cn(
        inline
          ? 'relative flex items-center gap-[0.15rem]'
          : 'absolute right-[0.85rem] top-[0.85rem] z-[4] flex items-center gap-2',
        !inline && showHeader && 'right-[0.8rem] top-[0.8rem]',
      )}
    >
      {actions}
      <Button
        variant="secondary"
        size="sm"
        className={
          inline
            ? SHARE_INLINE_BUTTON
            : 'min-h-9 rounded-full px-3.5'
        }
        onClick={onToggle}
      >
        Share
      </Button>
      {open ? (
        <div className="absolute right-0 top-[calc(100%+0.6rem)] z-30 grid min-w-0 w-[min(24rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] gap-3 overflow-hidden rounded-[12px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] p-4 shadow-[var(--shadow-soft)]">
          {shareState?.status === 'inactive' || !shareState ? (
            <>
              <SectionLabel className="mb-2">Session Share</SectionLabel>
              <strong>{translate('sharePopover.title')}</strong>
              <p className="mt-2 text-sm leading-[1.55] text-[var(--text-soft)]">{translate('sharePopover.hint')}</p>
              <Button
                variant="primary"
                className="mt-4 w-full"
                onClick={onStartShare}
                disabled={!canStartShare}
              >
                {translate('sharePopover.start')}
              </Button>
            </>
          ) : (
            <>
              <SectionLabel className="mb-2">Session Share</SectionLabel>
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
