import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface TerminalTmuxControlBarProps {
  /** 이 pane 이 속한 tmux window id (예: "@1"). 표시용. */
  windowId: string;
  /**
   * Detach — 서버 tmux 세션·프로세스는 살린 채 control 채널만 분리한다(detach-client).
   * 재접속(attach)하면 그대로 복원된다.
   */
  onDetach: () => void;
  /**
   * Kill — 이 control 세션을 종료(kill-session/kill-pane)해 서버 프로세스째 없앤다.
   * 되돌릴 수 없으므로 인라인 확인 단계를 거친다.
   */
  onKill: () => void;
}

// control mode(tmux -CC) pane 하단의 상태/액션 바. "서버에서 유지 중" 을 알리고,
// 탭 닫기의 두 의미(Detach=유지 / Kill=종료)를 명시적으로 분리·시각화한다.
// Detach 는 중립(살아남음), Kill 은 위험(빨강)으로 구분하고 Kill 은 한 번 더 확인한다.
export function TerminalTmuxControlBar({
  windowId,
  onDetach,
  onKill,
}: TerminalTmuxControlBarProps) {
  const { t: translate } = useTranslation();
  const [confirmingKill, setConfirmingKill] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 확인 단계에서 바깥 클릭/ESC 면 취소(=실수 보호).
  useEffect(() => {
    if (!confirmingKill) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setConfirmingKill(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setConfirmingKill(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [confirmingKill]);

  return (
    <div
      ref={rootRef}
      className="mx-[0.55rem] mb-[0.55rem] flex items-center gap-1.5 rounded-[6px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_96%,transparent)] px-[0.7rem] py-[0.25rem] text-[0.7rem] text-[var(--text-muted)]"
      role="status"
    >
      <span
        className="leading-none"
        style={{ color: 'var(--accent, #6aa84f)' }}
        aria-hidden
      >
        ▤
      </span>
      <span className="font-medium text-[var(--text)]">{translate('tmuxControl.title')}</span>
      <span aria-hidden>·</span>
      <span>{windowId}</span>
      <span aria-hidden>·</span>
      <span className="text-[0.7rem]">{translate('tmuxControl.keptOnServer')}</span>

      {confirmingKill ? (
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-[0.7rem] text-[var(--danger,#e5484d)]">
            {translate('tmuxControl.killConfirm')}
          </span>
          <button
            type="button"
            onClick={() => {
              setConfirmingKill(false);
              onKill();
            }}
            className="rounded-[4px] border border-[color-mix(in_srgb,var(--danger,#e5484d)_55%,var(--border))] bg-[color-mix(in_srgb,var(--danger,#e5484d)_18%,var(--surface))] px-[0.55rem] py-[0.25rem] text-[0.7rem] font-medium text-[var(--danger,#e5484d)] hover:bg-[color-mix(in_srgb,var(--danger,#e5484d)_28%,var(--surface))]"
          >
            {translate('tmuxControl.kill')}
          </button>
          <button
            type="button"
            onClick={() => setConfirmingKill(false)}
            className="rounded-[4px] border border-[var(--border)] bg-[var(--surface)] px-[0.55rem] py-[0.25rem] text-[0.7rem] font-medium text-[var(--text)] hover:bg-[color-mix(in_srgb,var(--surface)_80%,var(--text)_20%)]"
          >
            {translate('common.cancel')}
          </button>
        </div>
      ) : (
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={onDetach}
            title={translate('tmuxControl.detachTitle')}
            className="rounded-[4px] border border-[var(--border)] bg-[var(--surface)] px-[0.55rem] py-[0.25rem] text-[0.7rem] font-medium text-[var(--text)] hover:bg-[color-mix(in_srgb,var(--surface)_80%,var(--text)_20%)]"
          >
            Detach
          </button>
          <button
            type="button"
            onClick={() => setConfirmingKill(true)}
            title={translate('tmuxControl.killTitle')}
            className="rounded-[4px] border border-[color-mix(in_srgb,var(--danger,#e5484d)_45%,var(--border))] bg-[var(--surface)] px-[0.55rem] py-[0.25rem] text-[0.7rem] font-medium text-[var(--danger,#e5484d)] hover:bg-[color-mix(in_srgb,var(--danger,#e5484d)_14%,var(--surface))]"
          >
            Kill
          </button>
        </div>
      )}
    </div>
  );
}
