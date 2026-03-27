import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppTheme,
  SessionShareChatMessage,
  SessionShareOwnerChatSnapshot,
} from '@shared';
import { SESSION_SHARE_CHAT_HISTORY_LIMIT } from '@shared';

function createInactiveSnapshot(sessionId: string): SessionShareOwnerChatSnapshot {
  return {
    sessionId,
    title: '',
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
  const listRef = useRef<HTMLDivElement | null>(null);
  const desktopPlatform = useMemo(() => detectDesktopPlatform(), []);
  const resolvedTheme = useMemo(
    () => resolveTheme(settingsTheme, prefersDark),
    [prefersDark, settingsTheme],
  );

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
    const listNode = listRef.current;
    if (!listNode) {
      return;
    }

    listNode.scrollTop = listNode.scrollHeight;
  }, [snapshot.messages.length]);

  return (
    <div className="session-share-chat-window">
      <header className="session-share-chat-window__header">
        <div>
          <div className="session-share-chat-window__eyebrow">Session Share</div>
          <strong>{snapshot.title || '채팅 기록'}</strong>
        </div>
        <span className="session-share-chat-window__status">
          {loading ? '불러오는 중' : '실시간 기록'}
        </span>
      </header>

      {errorMessage ? (
        <div className="session-share-chat-window__error">{errorMessage}</div>
      ) : null}

      <div
        ref={listRef}
        className="session-share-chat-window__messages"
        aria-live="polite"
      >
        {!loading && snapshot.messages.length === 0 ? (
          <div className="session-share-chat-window__empty">
            아직 채팅이 없습니다.
          </div>
        ) : null}

        {snapshot.messages.map((message) => (
          <article key={message.id} className="session-share-chat-window__message">
            <div className="session-share-chat-window__meta">
              <strong>{message.nickname}</strong>
              <time dateTime={message.sentAt}>
                {formatChatTimestamp(message.sentAt)}
              </time>
            </div>
            <p>{message.text}</p>
          </article>
        ))}
      </div>
    </div>
  );
}
