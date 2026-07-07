import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAppStore } from '../../store/appStore';
import { redactAiContext } from '../../lib/ai-context-redact';
import { captureTerminalRecentText } from '../../lib/terminal-write-registry';
import { Button, Textarea } from '../../ui';

interface AiChatPanelProps {
  sessionId: string;
  // 터미널 최근 출력 캡처는 stableId 로 살아있는 런타임 레지스트리에서 읽는다.
  stableId: string;
  width: number;
}

// 전송할 때마다 함께 실어 보내는 터미널 최근 출력 줄 수(토큰 과다 방지 위해 보수적으로).
const RECENT_OUTPUT_LINES = 40;

// 마크다운 출력 스타일(테일윈드 arbitrary child selector로 typography 플러그인 없이 처리).
const MARKDOWN_CLASSNAME =
  'text-[0.85rem] leading-relaxed [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 ' +
  '[&_pre]:my-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded-[8px] [&_pre]:border [&_pre]:border-[var(--border)] [&_pre]:bg-[var(--surface-strong)] [&_pre]:p-2 ' +
  '[&_code]:font-mono [&_code]:text-[0.8rem] [&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-[var(--surface-strong)] [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 ' +
  '[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:my-0.5 ' +
  '[&_a]:text-[var(--accent-strong)] [&_a]:underline [&_strong]:font-semibold ' +
  '[&_h1]:my-1 [&_h1]:text-[1rem] [&_h1]:font-semibold [&_h2]:my-1 [&_h2]:text-[0.95rem] [&_h2]:font-semibold [&_h3]:my-1 [&_h3]:font-semibold';

export function AiChatPanel({ sessionId, stableId, width }: AiChatPanelProps) {
  const conversation = useAppStore((state) => state.aiConversations[sessionId]);
  const aiEnabled = useAppStore((state) => state.settings.ai?.enabled ?? false);
  const sendAiMessage = useAppStore((state) => state.sendAiMessage);
  const cancelAiMessage = useAppStore((state) => state.cancelAiMessage);
  const clearAiConversation = useAppStore((state) => state.clearAiConversation);
  const toggleAiPanel = useAppStore((state) => state.toggleAiPanel);
  const openSettingsSection = useAppStore((state) => state.openSettingsSection);
  const openExternalUrl = useAppStore((state) => state.openExternalUrl);
  const setAiPanelWidth = useAppStore((state) => state.setAiPanelWidth);

  const [input, setInput] = useState('');
  const transcriptRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const messages = conversation?.messages ?? [];
  const streaming = conversation?.streaming ?? false;
  const streamingText = conversation?.streamingText ?? '';
  const error = conversation?.error ?? null;
  const toolActivity = conversation?.toolActivity ?? null;

  useEffect(() => {
    const node = transcriptRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [messages.length, streamingText, error]);

  function handleSend() {
    const text = input.trim();
    if (!text || streaming) {
      return;
    }
    setInput('');
    // 터미널 최근 출력을 자동으로 컨텍스트에 포함(redaction 후). 표시 메시지엔 안 들어간다.
    const recent = captureTerminalRecentText(stableId, RECENT_OUTPUT_LINES);
    const context = recent.trim() ? redactAiContext(recent) : undefined;
    void sendAiMessage(sessionId, text, context);
  }

  function handleResizeMouseDown(event: React.MouseEvent) {
    dragRef.current = { startX: event.clientX, startWidth: width };
    const onMove = (moveEvent: MouseEvent) => {
      if (!dragRef.current) {
        return;
      }
      // 왼쪽 가장자리를 왼쪽으로 끌수록 폭이 커진다.
      const delta = dragRef.current.startX - moveEvent.clientX;
      setAiPanelWidth(dragRef.current.startWidth + delta);
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    event.preventDefault();
  }

  return (
    <div
      className="relative flex min-h-0 select-text flex-col border-l border-[var(--border)] bg-[var(--surface)]"
      style={{ width, flex: `0 0 ${width}px` }}
    >
      <div
        className="absolute left-0 top-0 z-[2] h-full w-[6px] -translate-x-1/2 cursor-col-resize"
        onMouseDown={handleResizeMouseDown}
      />

      <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
        <span className="text-[0.82rem] font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]">
          AI Assistant
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rounded-[6px] px-2 py-1 text-[0.8rem] text-[var(--text-soft)] hover:bg-[var(--surface-strong)]"
            onClick={() => clearAiConversation(sessionId)}
          >
            지우기
          </button>
          <button
            type="button"
            className="rounded-[6px] px-2 py-1 text-[0.8rem] text-[var(--text-soft)] hover:bg-[var(--surface-strong)]"
            onClick={() => toggleAiPanel(sessionId)}
            aria-label="AI 패널 닫기"
          >
            ✕
          </button>
        </div>
      </div>

      <div
        ref={transcriptRef}
        className="flex min-h-0 flex-1 select-text flex-col gap-2 overflow-y-auto p-3"
      >
        {!aiEnabled ? (
          <div className="flex flex-col items-start gap-2 text-[0.85rem] text-[var(--text-soft)]">
            <p>AI 어시스턴트가 꺼져 있습니다.</p>
            <button
              type="button"
              className="font-medium text-[var(--accent-strong)] hover:underline"
              onClick={() => openSettingsSection('ai')}
            >
              설정 → AI에서 활성화 ↗
            </button>
          </div>
        ) : messages.length === 0 && !streaming ? (
          <p className="text-[0.85rem] text-[var(--text-soft)]">
            무엇이든 물어보세요. 터미널 최근 출력이 자동으로 함께 전달됩니다.
          </p>
        ) : null}

        {messages.map((message, index) =>
          message.role === 'user' ? (
            <div
              key={index}
              className="max-w-[92%] self-end whitespace-pre-wrap break-words rounded-[10px] bg-[color-mix(in_srgb,var(--accent-strong)_16%,transparent)] px-3 py-2 text-[0.85rem] text-[var(--text)]"
            >
              {message.content}
            </div>
          ) : (
            <div
              key={index}
              className={`max-w-[92%] self-start break-words rounded-[10px] bg-[var(--surface-strong)] px-3 py-2 text-[var(--text)] ${MARKDOWN_CLASSNAME}`}
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ href, children }) => (
                    <a
                      href={href}
                      onClick={(event) => {
                        event.preventDefault();
                        if (href) {
                          void openExternalUrl(href);
                        }
                      }}
                    >
                      {children}
                    </a>
                  ),
                }}
              >
                {message.content}
              </ReactMarkdown>
            </div>
          ),
        )}

        {streaming && toolActivity ? (
          <div className="self-start text-[0.8rem] italic text-[var(--text-soft)]">
            {toolActivity}
          </div>
        ) : null}

        {streaming ? (
          <div
            className={`max-w-[92%] self-start break-words rounded-[10px] bg-[var(--surface-strong)] px-3 py-2 text-[var(--text)] ${MARKDOWN_CLASSNAME}`}
          >
            {streamingText ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingText}</ReactMarkdown>
            ) : (
              <span className="text-[var(--text-soft)]">…</span>
            )}
          </div>
        ) : null}

        {error ? (
          <div className="rounded-[10px] border border-[color-mix(in_srgb,var(--danger,#dc2626)_45%,transparent)] bg-[color-mix(in_srgb,var(--danger,#dc2626)_12%,transparent)] px-3 py-2 text-[0.8rem] text-[var(--text)]">
            {error.message}
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 border-t border-[var(--border)] p-3">
        <Textarea
          aria-label="AI 메시지 입력"
          rows={2}
          value={input}
          disabled={!aiEnabled}
          placeholder="메시지 입력 (Enter 전송, Shift+Enter 줄바꿈)"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            // IME 조합 중 Enter 는 무시(한글 등 마지막 글자 유실 방지).
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              handleSend();
            }
          }}
        />
        {streaming ? (
          <Button variant="secondary" onClick={() => cancelAiMessage(sessionId)}>
            정지
          </Button>
        ) : (
          <Button variant="primary" onClick={handleSend} disabled={!aiEnabled || !input.trim()}>
            전송
          </Button>
        )}
      </div>
    </div>
  );
}
