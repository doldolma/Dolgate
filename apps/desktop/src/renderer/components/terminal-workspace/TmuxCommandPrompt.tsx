import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/appStore';
import { tmuxCommand } from '../../services/desktop/terminal';
import { focusTerminalSession } from '../../lib/terminal-focus-registry';

// POSIX single-quote escaping(이름에 공백/특수문자 허용).
function quotePosix(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

const PROMPT_LABEL: Record<string, string> = {
  raw: 'tmux 명령',
  'rename-window': '윈도우 이름',
  'rename-session': '세션 이름',
};

// tmux 명령 프롬프트(Ctrl-b : / $ / ,). 텍스트 입력이 필요한 명령을 활성 pane 의
// control 채널로 보낸다. tmux 의 status-line 프롬프트와 비슷하게 하단에 입력창을 띄운다.
export function TmuxCommandPrompt() {
  const prompt = useAppStore((s) => s.tmuxCommandPrompt);
  const close = useAppStore((s) => s.closeTmuxCommandPrompt);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!prompt) {
      return undefined;
    }
    setValue(prompt.initialValue ?? '');
    // 렌더 후 포커스(+선택) — 이후 키 입력이 터미널이 아니라 이 입력창으로 간다.
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [prompt]);

  if (!prompt) {
    return null;
  }

  // 닫고 활성 pane 터미널로 포커스를 되돌린다(rAF: 언마운트 후 포커스가 살아있게).
  const finish = () => {
    const sessionId = prompt.sessionId;
    close();
    requestAnimationFrame(() => focusTerminalSession(sessionId));
  };

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed) {
      let command: string;
      if (prompt.mode === 'rename-window') {
        command = `rename-window -t ${prompt.windowId ?? ''} ${quotePosix(trimmed)}`;
      } else if (prompt.mode === 'rename-session') {
        command = `rename-session ${quotePosix(trimmed)}`;
      } else {
        command = trimmed;
      }
      void tmuxCommand(prompt.sessionId, command);
    }
    finish();
  };

  return (
    <div className="absolute inset-x-0 bottom-0 z-30 flex items-center gap-2 border-t border-[var(--accent)] bg-[color-mix(in_srgb,var(--surface)_96%,transparent)] px-3 py-2 text-[0.8rem]">
      <span className="shrink-0 font-medium text-[var(--accent)]">
        {PROMPT_LABEL[prompt.mode] ?? 'tmux'}:
      </span>
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            finish();
          }
        }}
        onBlur={close}
        placeholder={prompt.mode === 'raw' ? '예: resize-pane -Z' : '이름 입력'}
        className="min-w-0 flex-1 bg-transparent text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
        spellCheck={false}
        autoComplete="off"
        aria-label={PROMPT_LABEL[prompt.mode] ?? 'tmux command'}
      />
    </div>
  );
}
