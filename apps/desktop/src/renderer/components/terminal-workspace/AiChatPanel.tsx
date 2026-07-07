import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AiAttachment } from '@shared';
import { useAppStore } from '../../store/appStore';
import { AI_RECENT_OUTPUT_LINES, buildAiSessionContext } from '../../lib/ai-session-context';
import { createAiTerminalSnapshot } from '../../lib/ai-terminal-snapshot';
import { captureTerminalRecentText } from '../../lib/terminal-write-registry';
import { processAttachmentFiles } from '../../lib/ai-attachments';
import { hasExternalFileDrop } from '../../lib/file-drop';
import { Button } from '../../ui';
import {
  ArrowUp,
  Check,
  ChevronRight,
  Copy,
  FileText,
  Paperclip,
  RefreshCw,
  Square,
  Wrench,
  X,
} from '../../ui/icons';
import type { AiToolRun } from '../../store/types';

interface AiChatPanelProps {
  sessionId: string;
  // 터미널 최근 출력 캡처는 stableId 로 살아있는 런타임 레지스트리에서 읽는다.
  stableId: string;
  width: number;
}

// 입력창 자동 높이 상한(px). 이보다 길어지면 창은 안 커지고 내부 스크롤.
const AI_INPUT_MAX_HEIGHT = 200;

// 마크다운 출력 스타일(테일윈드 arbitrary child selector로 typography 플러그인 없이 처리).
const MARKDOWN_CLASSNAME =
  'text-[0.85rem] leading-relaxed [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 ' +
  '[&_pre]:my-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded-[8px] [&_pre]:border [&_pre]:border-[var(--border)] [&_pre]:bg-[var(--surface-strong)] [&_pre]:p-2 ' +
  '[&_code]:font-mono [&_code]:text-[0.8rem] [&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-[var(--surface-strong)] [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 ' +
  '[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:my-0.5 ' +
  '[&_a]:text-[var(--accent-strong)] [&_a]:underline [&_strong]:font-semibold ' +
  '[&_h1]:my-1 [&_h1]:text-[1rem] [&_h1]:font-semibold [&_h2]:my-1 [&_h2]:text-[0.95rem] [&_h2]:font-semibold [&_h3]:my-1 [&_h3]:font-semibold';

// react-markdown이 넘기는 hast 노드에서 원본 텍스트를 추출한다(코드블록 복사용).
function hastToText(node: unknown): string {
  const n = node as { type?: string; value?: string; children?: unknown[] } | null;
  if (!n) {
    return '';
  }
  if (n.type === 'text') {
    return n.value ?? '';
  }
  if (Array.isArray(n.children)) {
    return n.children.map(hastToText).join('');
  }
  return '';
}

function CopyButton({
  text,
  label = '복사',
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    },
    [],
  );
  return (
    <button
      type="button"
      aria-label={label}
      title={copied ? '복사됨' : label}
      className={className}
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            if (timerRef.current) {
              clearTimeout(timerRef.current);
            }
            timerRef.current = setTimeout(() => setCopied(false), 1200);
          })
          .catch(() => undefined);
      }}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-[var(--success-text)]" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
    </button>
  );
}

function ToolRunRow({ run }: { run: AiToolRun }) {
  return (
    <div className="flex items-center gap-1.5 text-[0.78rem] text-[var(--text-soft)]">
      {run.status === 'running' ? (
        <RefreshCw className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
      ) : run.status === 'error' ? (
        <X className="h-3 w-3 shrink-0 text-[var(--danger-text)]" aria-hidden />
      ) : (
        <Check className="h-3 w-3 shrink-0 text-[var(--success-text)]" aria-hidden />
      )}
      <span className="min-w-0 truncate">{run.label}</span>
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[0.82rem] font-medium text-[var(--text-soft)]"
      aria-label="생각중"
    >
      <span>생각중</span>
      <span className="inline-flex w-5 items-center gap-0.5" aria-hidden>
        <span
          className="h-1 w-1 rounded-full bg-current opacity-70 animate-bounce"
          style={{ animationDuration: '900ms' }}
        />
        <span
          className="h-1 w-1 rounded-full bg-current opacity-70 animate-bounce"
          style={{ animationDelay: '150ms', animationDuration: '900ms' }}
        />
        <span
          className="h-1 w-1 rounded-full bg-current opacity-70 animate-bounce"
          style={{ animationDelay: '300ms', animationDuration: '900ms' }}
        />
      </span>
    </span>
  );
}

export function AiChatPanel({ sessionId, stableId, width }: AiChatPanelProps) {
  const conversation = useAppStore((state) => state.aiConversations[sessionId]);
  const aiEnabled = useAppStore((state) => state.settings.ai?.enabled ?? false);
  const sendAiMessage = useAppStore((state) => state.sendAiMessage);
  const cancelAiMessage = useAppStore((state) => state.cancelAiMessage);
  const clearAiConversation = useAppStore((state) => state.clearAiConversation);
  const respondAiApproval = useAppStore((state) => state.respondAiApproval);
  const toggleAiPanel = useAppStore((state) => state.toggleAiPanel);
  const openSettingsSection = useAppStore((state) => state.openSettingsSection);
  const openExternalUrl = useAppStore((state) => state.openExternalUrl);
  const setAiPanelWidth = useAppStore((state) => state.setAiPanelWidth);
  const currentTab = useAppStore(
    (state) => state.tabs.find((tab) => tab.sessionId === sessionId) ?? null,
  );
  const currentHost = useAppStore((state) => {
    const tab = state.tabs.find((item) => item.sessionId === sessionId);
    return tab?.hostId ? (state.hosts.find((host) => host.id === tab.hostId) ?? null) : null;
  });

  const [input, setInput] = useState('');
  const [rememberApproval, setRememberApproval] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<AiAttachment[]>([]);
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  const [isDropActive, setIsDropActive] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const messages = conversation?.messages ?? [];
  const streaming = conversation?.streaming ?? false;
  const streamingText = conversation?.streamingText ?? '';
  const error = conversation?.error ?? null;
  const toolRuns = conversation?.toolRuns ?? [];
  const pendingApproval = conversation?.pendingApproval ?? null;

  useEffect(() => {
    const node = transcriptRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [messages.length, streamingText, error]);

  useEffect(() => {
    if (!attachNotice) {
      return;
    }
    const timeoutId = window.setTimeout(() => setAttachNotice(null), 5000);
    return () => window.clearTimeout(timeoutId);
  }, [attachNotice]);

  // paste/drop/파일선택 공용 진입점. 수용분은 목록에 추가, 거부분은 첫 사유만 notice 로.
  async function addAttachmentFiles(files: File[]) {
    if (files.length === 0) {
      return;
    }
    const result = await processAttachmentFiles(files, pendingAttachments);
    if (result.accepted.length > 0) {
      setPendingAttachments((current) => [...current, ...result.accepted]);
    }
    if (result.rejected.length > 0) {
      const first = result.rejected[0];
      setAttachNotice(`${first.name}: ${first.reason}`);
    }
  }

  function removeAttachment(index: number) {
    setPendingAttachments((current) => current.filter((_, i) => i !== index));
  }

  // Claude 입력창처럼: 내용/줄바꿈에 맞춰 높이 자동 증가, 상한(AI_INPUT_MAX_HEIGHT) 넘으면 내부 스크롤.
  // 상한 미만에선 overflow hidden(보더-박스 오차로 인한 얇은 스크롤바 방지), 상한에선 auto.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) {
      return;
    }
    el.style.height = 'auto';
    const capped = el.scrollHeight > AI_INPUT_MAX_HEIGHT;
    el.style.height = `${capped ? AI_INPUT_MAX_HEIGHT : el.scrollHeight}px`;
    el.style.overflowY = capped ? 'auto' : 'hidden';
  }, [input]);

  function handleSend() {
    const text = input.trim();
    const attachments = pendingAttachments;
    if ((!text && attachments.length === 0) || streaming) {
      return;
    }
    setInput('');
    setPendingAttachments([]);
    // 호스트 요약 + 터미널 최근 출력을 자동으로 컨텍스트에 포함(redaction 후).
    // 표시 메시지엔 안 들어간다.
    const terminalSnapshot = createAiTerminalSnapshot(stableId, AI_RECENT_OUTPUT_LINES);
    const recent =
      terminalSnapshot?.recentText ?? captureTerminalRecentText(stableId, AI_RECENT_OUTPUT_LINES);
    const context = buildAiSessionContext({
      tab: currentTab,
      host: currentHost,
      recentTerminalText: recent,
      recentOutputLines: AI_RECENT_OUTPUT_LINES,
    });
    void sendAiMessage(
      sessionId,
      text,
      context,
      terminalSnapshot?.snapshotRef,
      attachments.length > 0 ? attachments : undefined,
    );
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
      // OS 파일 드래그만 가로챈다. stopPropagation 은 쓰지 않는다 — 부모(TerminalSessionPane)가
      // defaultPrevented 를 보고 SFTP 업로드 오버레이를 끄는 데 의존한다.
      onDragOver={(event) => {
        if (!aiEnabled || !hasExternalFileDrop(event.dataTransfer)) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setIsDropActive(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return;
        }
        setIsDropActive(false);
      }}
      onDrop={(event) => {
        if (!aiEnabled || !hasExternalFileDrop(event.dataTransfer)) {
          return;
        }
        event.preventDefault();
        setIsDropActive(false);
        void addAttachmentFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <div
        className="absolute left-0 top-0 z-[2] h-full w-[6px] -translate-x-1/2 cursor-col-resize"
        onMouseDown={handleResizeMouseDown}
      />
      {isDropActive ? (
        <div className="pointer-events-none absolute inset-0 z-[3] flex items-center justify-center rounded-[4px] border-2 border-dashed border-[var(--accent-strong)] bg-[color-mix(in_srgb,var(--accent-strong)_8%,transparent)] text-[0.85rem] font-medium text-[var(--accent-strong)]">
          첨부하려면 놓으세요
        </div>
      ) : null}

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

        {messages.map((message, index) => {
          if (message.role === 'user') {
            return (
              <div
                key={index}
                className="max-w-[92%] self-end whitespace-pre-wrap break-words rounded-[10px] bg-[color-mix(in_srgb,var(--accent-strong)_16%,transparent)] px-3 py-2 text-[0.85rem] text-[var(--text)]"
              >
                {message.attachments?.length ? (
                  <div className="mb-1.5 flex flex-wrap gap-1.5">
                    {message.attachments.map((attachment, attachmentIndex) =>
                      attachment.kind === 'image' ? (
                        <img
                          key={attachmentIndex}
                          src={`data:${attachment.mediaType};base64,${attachment.dataBase64}`}
                          alt={attachment.name ?? '첨부 이미지'}
                          className="max-h-32 max-w-full rounded-[6px] border border-[var(--border)] object-cover"
                        />
                      ) : (
                        <span
                          key={attachmentIndex}
                          className="inline-flex max-w-full items-center gap-1 rounded-[6px] border border-[var(--border)] bg-[var(--surface-strong)] px-1.5 py-0.5 text-[0.78rem] text-[var(--text-soft)]"
                        >
                          <FileText className="h-3 w-3 shrink-0" aria-hidden />
                          <span className="min-w-0 truncate">{attachment.name}</span>
                        </span>
                      ),
                    )}
                  </div>
                ) : null}
                {message.content ? message.content : null}
              </div>
            );
          }

          const toolRunCount = message.toolRuns?.length ?? 0;
          const hasActivity = toolRunCount > 0 || Boolean(message.generationTrace);

          return (
            <div
              key={index}
              className="group/msg flex max-w-[92%] flex-col items-start gap-1 self-start"
            >
              {hasActivity ? (
                <details className="w-full px-0.5 [&[open]_.activity-chevron]:rotate-90">
                  <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[0.74rem] text-[var(--text-soft)] hover:text-[var(--text)] [&::-webkit-details-marker]:hidden">
                    <ChevronRight
                      className="activity-chevron h-3 w-3 shrink-0 transition-transform"
                      aria-hidden
                    />
                    <Wrench className="h-3 w-3 shrink-0" aria-hidden />
                    <span>작업 내역</span>
                    {toolRunCount > 0 ? (
                      <span className="rounded-full bg-[var(--surface-strong)] px-1.5 py-0.5 text-[0.68rem]">
                        도구 {toolRunCount}개
                      </span>
                    ) : null}
                  </summary>
                  <div className="ml-3.5 mt-1.5 flex flex-col gap-1.5 border-l border-[var(--border)] pl-2.5">
                    {message.generationTrace ? (
                      <div
                        className={`break-words text-[var(--text-soft)] ${MARKDOWN_CLASSNAME}`}
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
                          {message.generationTrace}
                        </ReactMarkdown>
                      </div>
                    ) : null}
                    {message.toolRuns && message.toolRuns.length > 0 ? (
                      <div className="flex flex-col gap-1">
                        {message.toolRuns.map((run) => (
                          <ToolRunRow key={run.id} run={run} />
                        ))}
                      </div>
                    ) : null}
                  </div>
                </details>
              ) : null}
              <div
                className={`w-full break-words rounded-[10px] bg-[var(--surface-strong)] px-3 py-2 text-[var(--text)] ${MARKDOWN_CLASSNAME}`}
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
                    pre: ({ node, children }) => (
                      <div className="group/code relative">
                        <CopyButton
                          text={hastToText(node)}
                          className="absolute right-1.5 top-1.5 z-[1] inline-flex items-center rounded-[6px] border border-[var(--border)] bg-[var(--surface)] p-1 text-[var(--text-soft)] opacity-0 transition-opacity hover:bg-[var(--surface-strong)] hover:text-[var(--text)] group-hover/code:opacity-100"
                        />
                        <pre>{children}</pre>
                      </div>
                    ),
                  }}
                >
                  {message.content}
                </ReactMarkdown>
              </div>
              <CopyButton
                text={message.content}
                label="응답 복사"
                className="inline-flex items-center rounded-[6px] p-1 text-[var(--text-soft)] opacity-0 transition-opacity hover:bg-[var(--surface-strong)] hover:text-[var(--text)] group-hover/msg:opacity-100"
              />
            </div>
          );
        })}

        {streaming && toolRuns.length > 0 ? (
          <div className="flex w-full max-w-[92%] flex-col gap-1 self-start rounded-[10px] border border-[var(--border)] bg-[var(--surface-strong)] px-3 py-2">
            {toolRuns.map((run) => (
              <ToolRunRow key={run.id} run={run} />
            ))}
          </div>
        ) : null}

        {streaming ? (
          <div
            className={`max-w-[92%] self-start break-words rounded-[10px] bg-[var(--surface-strong)] px-3 py-2 text-[var(--text)] ${MARKDOWN_CLASSNAME}`}
          >
            {streamingText ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingText}</ReactMarkdown>
            ) : (
              <ThinkingIndicator />
            )}
          </div>
        ) : null}

        {pendingApproval ? (
          <div className="flex flex-col gap-2.5 self-stretch rounded-[12px] border border-[color-mix(in_srgb,var(--warning-text)_26%,var(--border))] bg-[var(--warning-bg)] p-3">
            <div className="flex items-center gap-1.5 text-[0.78rem] font-semibold text-[var(--warning-text)]">
              <span aria-hidden>⚠</span>
              <span>명령 실행 승인</span>
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-[8px] border border-[var(--border)] bg-[var(--surface-strong)] px-2.5 py-2 font-mono text-[0.8rem] leading-snug text-[var(--text)]">
              {pendingApproval.command}
            </pre>
            <div className="text-[0.72rem] text-[var(--text-soft)]">{pendingApproval.reason}</div>
            <label className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-center gap-2 text-[0.76rem] text-[var(--text-soft)]">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--accent-strong)]"
                checked={rememberApproval}
                onChange={(event) => setRememberApproval(event.target.checked)}
              />
              <span>이 세션에서 자동 승인</span>
            </label>
            <div className="mt-0.5 grid grid-cols-2 gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  void respondAiApproval(sessionId, pendingApproval.toolCallId, false);
                  setRememberApproval(false);
                }}
              >
                거부
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  void respondAiApproval(sessionId, pendingApproval.toolCallId, true, rememberApproval);
                  setRememberApproval(false);
                }}
              >
                승인
              </Button>
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="rounded-[10px] border border-[color-mix(in_srgb,var(--danger,#dc2626)_45%,transparent)] bg-[color-mix(in_srgb,var(--danger,#dc2626)_12%,transparent)] px-3 py-2 text-[0.8rem] text-[var(--text)]">
            {error.message}
          </div>
        ) : null}
      </div>

      <div className="border-t border-[var(--border)] p-3">
        <div className="relative rounded-[14px] border border-[var(--border)] bg-[var(--surface-strong)] shadow-sm transition-[border-color,box-shadow,background-color] duration-150 focus-within:border-[var(--selection-border)] focus-within:ring-4 focus-within:ring-[color-mix(in_srgb,var(--accent-strong)_10%,transparent)]">
          {pendingAttachments.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
              {pendingAttachments.map((attachment, index) => (
                <span key={index} className="relative inline-flex">
                  {attachment.kind === 'image' ? (
                    <img
                      src={`data:${attachment.mediaType};base64,${attachment.dataBase64}`}
                      alt={attachment.name ?? '첨부 이미지'}
                      className="h-12 w-12 rounded-[8px] border border-[var(--border)] object-cover"
                    />
                  ) : (
                    <span className="inline-flex h-12 max-w-40 items-center gap-1.5 rounded-[8px] border border-[var(--border)] bg-[var(--surface)] px-2 text-[0.78rem] text-[var(--text-soft)]">
                      <FileText className="h-4 w-4 shrink-0" aria-hidden />
                      <span className="min-w-0 truncate">{attachment.name}</span>
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label="첨부 제거"
                    className="absolute -right-1.5 -top-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--text-soft)] hover:text-[var(--danger-text)]"
                    onClick={() => removeAttachment(index)}
                  >
                    <X className="h-2.5 w-2.5" aria-hidden />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          {attachNotice ? (
            <div className="px-3 pt-2 text-[0.78rem] text-[var(--danger-text)]">{attachNotice}</div>
          ) : null}
          <textarea
            ref={inputRef}
            aria-label="AI 메시지 입력"
            rows={1}
            value={input}
            disabled={!aiEnabled}
            placeholder="메시지 입력"
            className="max-h-[200px] min-h-[56px] w-full resize-none border-0 bg-transparent py-4 pl-12 pr-14 text-[0.9rem] leading-normal text-[var(--text)] outline-none placeholder:text-[var(--text-soft)] disabled:cursor-default disabled:opacity-60"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              // IME 조합 중 Enter 는 무시(한글 등 마지막 글자 유실 방지).
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                handleSend();
              }
            }}
            onPaste={(event) => {
              // 클립보드에 파일이 있을 때만 가로챈다(스크린샷 붙여넣기). 일반 텍스트/IME 는 그대로.
              const files: File[] = Array.from(event.clipboardData?.files ?? []);
              if (files.length === 0) {
                for (const item of Array.from(event.clipboardData?.items ?? [])) {
                  if (item.kind === 'file') {
                    const file = item.getAsFile();
                    if (file) {
                      files.push(file);
                    }
                  }
                }
              }
              if (files.length > 0) {
                event.preventDefault();
                void addAttachmentFiles(files);
              }
            }}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,text/*,.log,.conf,.env,.json,.yml,.yaml,.toml,.ini,.sh,.md,.csv,.xml"
            className="hidden"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              // 같은 파일 재선택이 가능하도록 값 초기화.
              event.target.value = '';
              void addAttachmentFiles(files);
            }}
          />
          <button
            type="button"
            aria-label="파일 첨부"
            title="파일 첨부"
            disabled={!aiEnabled}
            className="absolute bottom-3 left-3 inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-soft)] transition-colors hover:bg-[var(--surface-elevated)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[color-mix(in_srgb,var(--accent-strong)_14%,transparent)] disabled:cursor-default disabled:opacity-60"
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip className="h-4 w-4" aria-hidden />
          </button>
          {streaming ? (
            <button
              type="button"
              aria-label="응답 생성 정지"
              title="정지"
              className="absolute bottom-3 right-3 inline-flex h-8 w-8 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--text-soft)] transition-colors hover:bg-[var(--surface-elevated)] hover:text-[var(--danger-text)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[color-mix(in_srgb,var(--accent-strong)_14%,transparent)]"
              onClick={() => cancelAiMessage(sessionId)}
            >
              <Square className="h-3.5 w-3.5 fill-current" aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              aria-label="메시지 전송"
              title="전송"
              className="absolute bottom-3 right-3 inline-flex h-8 w-8 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--accent-strong)_76%,black_24%)] bg-[var(--accent-strong)] text-[var(--accent-contrast)] transition-colors hover:bg-[color-mix(in_srgb,var(--accent-strong)_92%,white_8%)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[color-mix(in_srgb,var(--accent-strong)_14%,transparent)] disabled:cursor-default disabled:border-[var(--border)] disabled:bg-[var(--surface-muted)] disabled:text-[var(--text-soft)]"
              onClick={handleSend}
              disabled={!aiEnabled || (!input.trim() && pendingAttachments.length === 0)}
            >
              <ArrowUp className="h-4 w-4" aria-hidden />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
