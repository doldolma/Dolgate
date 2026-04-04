import type { MutableRefObject } from 'react';
import type { TerminalTab } from '@shared';
import { Button, Card, SectionLabel } from '../../ui';

interface TerminalSharePopoverProps {
  anchorRef: MutableRefObject<HTMLDivElement | null>;
  showHeader: boolean;
  open: boolean;
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

export function TerminalSharePopover({
  anchorRef,
  showHeader,
  open,
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
  return (
    <div
      ref={anchorRef}
      className={`terminal-share-anchor ${showHeader ? 'terminal-share-anchor--pane' : ''}`}
    >
      <Button
        variant="secondary"
        size="sm"
        className="terminal-share-button min-h-9 rounded-full px-3.5"
        onClick={onToggle}
      >
        Share
      </Button>
      {open ? (
        <Card className="terminal-share-popover absolute right-0 top-[calc(100%+0.6rem)] z-30 w-[min(24rem,calc(100vw-2rem))] rounded-[24px] p-4">
          {shareState?.status === 'inactive' || !shareState ? (
            <>
              <SectionLabel className="terminal-share-popover__label mb-2">Session Share</SectionLabel>
              <strong>현재 세션을 브라우저로 공유합니다.</strong>
              <p className="mt-2 text-sm leading-[1.55] text-[var(--text-soft)]">링크를 아는 사용자는 로그인 없이 접속할 수 있습니다.</p>
              <Button
                variant="primary"
                className="terminal-share-popover__action mt-4 w-full"
                onClick={onStartShare}
                disabled={!canStartShare}
              >
                공유 시작
              </Button>
            </>
          ) : (
            <>
              <SectionLabel className="terminal-share-popover__label mb-2">Session Share</SectionLabel>
              <strong>
                {shareState.status === 'starting'
                  ? '공유를 준비하는 중입니다.'
                  : '공유 링크가 준비되었습니다.'}
              </strong>
              {shareState.errorMessage ? (
                <p className="terminal-share-popover__error mt-2 text-sm text-[var(--danger-text)]">
                  {shareState.errorMessage}
                </p>
              ) : null}
              {shareState.shareUrl ? (
                <button
                  type="button"
                  className="terminal-share-popover__url mt-3 flex w-full items-center justify-between gap-3 rounded-[18px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] px-4 py-3 text-left transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--surface-muted)_94%,transparent_6%)]"
                  onClick={onCopyShareUrl}
                  aria-label="공유 링크 복사"
                  title="클릭하여 링크 복사"
                >
                  <span className="terminal-share-popover__url-text truncate text-sm text-[var(--text)]">
                    {shareState.shareUrl}
                  </span>
                  <span
                    className="terminal-share-popover__url-icon inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] text-[var(--text-soft)]"
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
              ) : (
                <p className="mt-3 text-sm text-[var(--text-soft)]">공유 링크를 생성하는 중입니다.</p>
              )}
              <div className="terminal-share-popover__meta mt-3 space-y-3">
                <span className="block text-sm text-[var(--text-soft)]">시청자 {shareState.viewerCount}명</span>
                <div
                  className="terminal-share-popover__mode inline-flex rounded-full border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] p-1"
                  role="group"
                  aria-label="세션 공유 입력 모드"
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    className={`terminal-share-popover__mode-button rounded-full px-3 ${
                      !shareState.inputEnabled
                        ? 'bg-[var(--surface-elevated)] text-[var(--text)] shadow-[0_8px_18px_rgba(15,23,38,0.08)]'
                        : ''
                    }`}
                    onClick={() => {
                      onSetInputEnabled(false);
                    }}
                    disabled={
                      shareState.status !== 'active' &&
                      shareState.status !== 'starting'
                    }
                    aria-pressed={!shareState.inputEnabled}
                  >
                    읽기 전용
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={`terminal-share-popover__mode-button rounded-full px-3 ${
                      shareState.inputEnabled
                        ? 'bg-[var(--surface-elevated)] text-[var(--text)] shadow-[0_8px_18px_rgba(15,23,38,0.08)]'
                        : ''
                    }`}
                    onClick={() => {
                      onSetInputEnabled(true);
                    }}
                    disabled={
                      shareState.status !== 'active' &&
                      shareState.status !== 'starting'
                    }
                    aria-pressed={shareState.inputEnabled}
                  >
                    입력 허용
                  </Button>
                </div>
              </div>
              {shareCopyStatus ? (
                <div className="terminal-share-popover__hint mt-3 text-sm text-[var(--text-soft)]">
                  {shareCopyStatus}
                </div>
              ) : null}
              <div className="terminal-share-popover__actions mt-4 flex items-center justify-end gap-3">
                <Button
                  variant="secondary"
                  onClick={onOpenChatWindow}
                  disabled={shareState.status !== 'active' || !canOpenChatWindow}
                >
                  채팅 기록
                </Button>
                <Button
                  variant="danger"
                  className="terminal-share-popover__danger"
                  onClick={onStopShare}
                >
                  공유 종료
                </Button>
              </div>
            </>
          )}
        </Card>
      ) : null}
    </div>
  );
}
