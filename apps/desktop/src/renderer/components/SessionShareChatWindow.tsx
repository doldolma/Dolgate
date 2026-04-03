import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppTheme,
  SessionShareChatMessage,
  SessionShareChatSenderRole,
  SessionShareOwnerChatSnapshot,
} from '@shared';
import { SESSION_SHARE_CHAT_HISTORY_LIMIT } from '@shared';

function createInactiveSnapshot(sessionId: string): SessionShareOwnerChatSnapshot {
  return {
    sessionId,
    title: '',
    ownerNickname: 'Owner',
    state: {
      status: 'inactive',
      shareUrl: null,
      inputEnabled: false,
      viewerCount: 0,
      errorMessage: null,
    },
    messages: [],
  };
}

function detectDesktopPlatform(): 'darwin' | 'win32' | 'linux' | 'unknown' {
  const userAgent = navigator.userAgent.toLowerCase();
  const userAgentData = navigator as Navigator & {
    userAgentData?: {
      platform?: string;
    };
  };
  const platform = (userAgentData.userAgentData?.platform ?? navigator.platform ?? '').toLowerCase();

  if (platform.includes('mac') || userAgent.includes('mac os')) {
    return 'darwin';
  }
  if (platform.includes('win') || userAgent.includes('windows')) {
    return 'win32';
  }
  if (platform.includes('linux') || userAgent.includes('linux')) {
    return 'linux';
  }
  return 'unknown';
}

function resolveTheme(theme: AppTheme, prefersDark: boolean): 'light' | 'dark' {
  if (theme === 'light' || theme === 'dark') {
    return theme;
  }
  return prefersDark ? 'dark' : 'light';
}

function formatChatTimestamp(sentAt: string): string {
  const timestamp = new Date(sentAt);
  if (Number.isNaN(timestamp.getTime())) {
    return '';
  }

  return timestamp.toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function clampChatMessages(messages: SessionShareChatMessage[]): SessionShareChatMessage[] {
  const deduped = new Map<string, SessionShareChatMessage>();
  for (const message of messages) {
    deduped.set(message.id, message);
  }

  return [...deduped.values()]
    .sort((left, right) => left.sentAt.localeCompare(right.sentAt))
    .slice(-SESSION_SHARE_CHAT_HISTORY_LIMIT);
}

function appendChatMessage(
  current: SessionShareChatMessage[],
  message: SessionShareChatMessage,
): SessionShareChatMessage[] {
  return clampChatMessages([...current, message]);
}

function hydrateChatMessages(
  current: SessionShareChatMessage[],
  snapshotMessages: SessionShareChatMessage[],
): SessionShareChatMessage[] {
  return clampChatMessages([...snapshotMessages, ...current]);
}

function normalizeChatText(value: string): string {
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if (!normalized) {
    return '';
  }

  return Array.from(normalized).length <= 300 ? normalized : '';
}

function resolveSenderRole(
  message: Pick<SessionShareChatMessage, 'senderRole'>,
): SessionShareChatSenderRole {
  return message.senderRole === 'owner' ? 'owner' : 'viewer';
}

function getDisplayChatNickname(
  nickname: string,
  senderRole: SessionShareChatSenderRole,
): string {
  const normalized = nickname.trim();
  if (!normalized) {
    return senderRole === 'owner' ? 'Owner' : '';
  }
  if (senderRole !== 'owner') {
    return normalized;
  }

  const withoutOwnerSuffix = normalized.replace(/\s+Owner$/u, '').trim();
  return withoutOwnerSuffix || normalized;
}

export function SessionShareChatWindow({
  sessionId,
}: {
  sessionId: string;
}) {
  const [snapshot, setSnapshot] = useState<SessionShareOwnerChatSnapshot>(() =>
    createInactiveSnapshot(sessionId),
  );
  const [settingsTheme, setSettingsTheme] = useState<AppTheme>('system');
  const [prefersDark, setPrefersDark] = useState(() => {
    if (typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sendErrorMessage, setSendErrorMessage] = useState<string | null>(null);
  const [draftMessage, setDraftMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const refocusAfterSubmitRef = useRef(false);
  const desktopPlatform = useMemo(() => detectDesktopPlatform(), []);
  const resolvedTheme = useMemo(
    () => resolveTheme(settingsTheme, prefersDark),
    [prefersDark, settingsTheme],
  );
  const isChatActive = snapshot.state.status === 'active';

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.dataset.themeMode = settingsTheme;
    document.documentElement.dataset.platform = desktopPlatform;
  }, [desktopPlatform, resolvedTheme, settingsTheme]);

  useEffect(() => {
    document.title = snapshot.title
      ? `채팅 기록 · ${snapshot.title}`
      : '채팅 기록';
  }, [snapshot.title]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return;
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event: MediaQueryListEvent) => {
      setPrefersDark(event.matches);
    };
    media.addEventListener('change', handleChange);
    return () => {
      media.removeEventListener('change', handleChange);
    };
  }, []);

  useEffect(() => {
    void window.dolssh.settings
      .get()
      .then((settings) => {
        setSettingsTheme(settings.theme);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!sessionId) {
      void window.dolssh.window.close().catch(() => undefined);
      return;
    }

    let disposed = false;
    const closeWindow = () => {
      void window.dolssh.window.close().catch(() => undefined);
    };

    const offChat = window.dolssh.sessionShares.onChatEvent((event) => {
      if (event.sessionId !== sessionId) {
        return;
      }

      setSnapshot((current) => ({
        ...current,
        messages: appendChatMessage(current.messages, event.message),
      }));
    });

    const offState = window.dolssh.sessionShares.onEvent((event) => {
      if (event.sessionId !== sessionId) {
        return;
      }

      setSnapshot((current) => ({
        ...current,
        state: event.state,
      }));

      if (event.state.status === 'inactive' || event.state.status === 'error') {
        closeWindow();
      }
    });

    void window.dolssh.sessionShares
      .getOwnerChatSnapshot(sessionId)
      .then((nextSnapshot) => {
        if (disposed) {
          return;
        }

        if (nextSnapshot.state.status !== 'active') {
          closeWindow();
          return;
        }

        setSnapshot((current) => ({
          ...nextSnapshot,
          messages: hydrateChatMessages(current.messages, nextSnapshot.messages),
        }));
        setErrorMessage(null);
      })
      .catch((error: unknown) => {
        if (disposed) {
          return;
        }
        setErrorMessage(
          error instanceof Error
            ? error.message
            : '채팅 기록을 불러오지 못했습니다.',
        );
      })
      .finally(() => {
        if (!disposed) {
          setLoading(false);
        }
      });

    return () => {
      disposed = true;
      offChat();
      offState();
    };
  }, [sessionId]);

  useEffect(() => {
    const messagesEndNode = messagesEndRef.current;
    if (!messagesEndNode) {
      return;
    }

    messagesEndNode.scrollIntoView({
      block: 'end',
    });
  }, [snapshot.messages]);

  useEffect(() => {
    if (isSubmitting || !refocusAfterSubmitRef.current || !isChatActive) {
      return;
    }

    refocusAfterSubmitRef.current = false;
    const frameHandle = window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frameHandle);
    };
  }, [isSubmitting, isChatActive]);

  const handleSubmit = async () => {
    const normalizedText = normalizeChatText(draftMessage);
    if (!normalizedText || !isChatActive || isSubmitting) {
      return;
    }

    refocusAfterSubmitRef.current = true;
    setIsSubmitting(true);
    setSendErrorMessage(null);
    try {
      await window.dolssh.sessionShares.sendOwnerChatMessage(
        sessionId,
        normalizedText,
      );
      setDraftMessage('');
    } catch (error: unknown) {
      setSendErrorMessage(
        error instanceof Error
          ? error.message
          : '채팅 메시지를 보내지 못했습니다.',
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="session-share-chat-window">
      <header className="session-share-chat-window__header">
        <div>
          <div className="session-share-chat-window__eyebrow">Session Share</div>
          <strong>{snapshot.title || '채팅 기록'}</strong>
        </div>
        <span className="session-share-chat-window__status">
          {loading
            ? '불러오는 중'
            : isSubmitting
              ? '전송 중'
              : '실시간 채팅'}
        </span>
      </header>

      {errorMessage || sendErrorMessage ? (
        <div className="session-share-chat-window__alerts">
          {errorMessage ? (
            <div className="session-share-chat-window__error">{errorMessage}</div>
          ) : null}
          {sendErrorMessage ? (
            <div className="session-share-chat-window__error">{sendErrorMessage}</div>
          ) : null}
        </div>
      ) : null}

      <div
        className="session-share-chat-window__messages"
        aria-live="polite"
      >
        {!loading && snapshot.messages.length === 0 ? (
          <div className="session-share-chat-window__empty">
            아직 채팅이 없습니다.
          </div>
        ) : null}

        {snapshot.messages.map((message) => {
          const senderRole = resolveSenderRole(message);
          const displayNickname = getDisplayChatNickname(message.nickname, senderRole);

          return (
            <article
              key={message.id}
              className={`session-share-chat-window__message ${
                senderRole === 'owner'
                  ? 'session-share-chat-window__message--owner'
                  : ''
              }`}
            >
              <div className="session-share-chat-window__meta">
                <div className="session-share-chat-window__meta-name">
                  <strong>{displayNickname}</strong>
                  {senderRole === 'owner' ? (
                    <span className="session-share-chat-window__role-badge">Owner</span>
                  ) : null}
                </div>
                <time dateTime={message.sentAt}>
                  {formatChatTimestamp(message.sentAt)}
                </time>
              </div>
              <p>{message.text}</p>
            </article>
          );
        })}
        <div ref={messagesEndRef} aria-hidden="true" />
      </div>

      <form
        className="session-share-chat-window__composer"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <label className="session-share-chat-window__composer-field">
          <span>메시지</span>
          <textarea
            ref={textareaRef}
            value={draftMessage}
            rows={3}
            maxLength={300}
            placeholder="메시지를 입력해 주세요"
            disabled={!isChatActive || loading || isSubmitting}
            onChange={(event) => {
              setDraftMessage(event.target.value);
              if (sendErrorMessage) {
                setSendErrorMessage(null);
              }
            }}
            onCompositionStart={() => {
              setIsComposing(true);
            }}
            onCompositionEnd={() => {
              setIsComposing(false);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || isComposing || event.nativeEvent.isComposing) {
                return;
              }
              event.preventDefault();
              void handleSubmit();
            }}
          />
        </label>
        <button
          type="submit"
          className="primary-button session-share-chat-window__composer-submit"
          disabled={!isChatActive || loading || isSubmitting}
        >
          전송
        </button>
      </form>
    </div>
  );
}
