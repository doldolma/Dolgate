// 출력 안으로 스크롤해 들어가 명령 줄이 화면 위로 사라졌을 때 상단에 붙는 헤더.
// "지금 보고 있는 출력이 어느 명령의 것인가"를 잃지 않게 한다(VS Code 의 sticky scroll 과 같은 역할).
// 클릭하면 그 명령 줄로 되돌아간다.

import type { TerminalBlockStickyState } from '../../controllers/useTerminalBlockOverlay';
import { cn } from '../../lib/cn';
import { formatBlockDuration } from './blockFormat';
import { useTranslation } from 'react-i18next';

interface TerminalBlockStickyHeaderProps {
  sticky: TerminalBlockStickyState;
  onJumpToCommand: () => void;
}

export function TerminalBlockStickyHeader({
  sticky,
  onJumpToCommand,
}: TerminalBlockStickyHeaderProps) {
  const { t: translate } = useTranslation();
  const failed = sticky.state === 'failed';
  const running = sticky.state === 'running';
  const duration = formatBlockDuration(sticky.durationMs);

  return (
    <button
      type="button"
      className="absolute inset-x-0 z-[6] flex items-center gap-2 border-b border-[rgba(255,255,255,0.12)] bg-[rgba(16,23,38,0.96)] px-2 text-left backdrop-blur-[2px] transition-colors duration-150 hover:bg-[rgba(28,38,60,0.98)]"
      style={{ top: sticky.top, minHeight: Math.max(sticky.height, 18) }}
      onClick={onJumpToCommand}
      // 터미널이 포커스를 잃지 않도록 mousedown 기본동작을 막는다.
      onMouseDown={(event) => event.preventDefault()}
      title={translate('stickyHeader.jumpToCommand')}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          failed
            ? 'bg-[#ef6f6c]'
            : running
              ? 'bg-[#7aa2ff]'
              : 'bg-[rgba(122,200,160,0.7)]',
        )}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate font-mono text-[0.72rem] text-[rgba(232,239,255,0.92)]">
        {sticky.command ?? translate('stickyHeader.unreadable')}
      </span>
      {failed && sticky.exitCode !== null ? (
        <span className="shrink-0 text-[0.68rem] font-semibold text-[#ffb1b1]">
          exit {sticky.exitCode}
        </span>
      ) : null}
      {duration ? (
        <span className="shrink-0 text-[0.68rem] font-semibold tabular-nums text-[rgba(226,234,255,0.7)]">
          {duration}
        </span>
      ) : null}
    </button>
  );
}
