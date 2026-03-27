import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionShareChatWindow } from './SessionShareChatWindow';

describe('SessionShareChatWindow', () => {
  let sessionShareEventListener: ((event: any) => void) | null;
  let sessionShareChatEventListener: ((event: any) => void) | null;
  let api: any;

  beforeEach(() => {
    sessionShareEventListener = null;
    sessionShareChatEventListener = null;

    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });

    api = {
      settings: {
        get: vi.fn().mockResolvedValue({
          theme: 'system',
        }),
      },
      sessionShares: {
        getOwnerChatSnapshot: vi.fn().mockResolvedValue({
          sessionId: 'session-1',
          title: 'Host Session',
          state: {
            status: 'active',
            shareUrl: 'https://sync.example.com/share/share-1/token-1',
            inputEnabled: false,
            viewerCount: 2,
            errorMessage: null,
          },
          messages: [
            {
              id: 'chat-1',
              nickname: '맑은 다람쥐',
              text: '안녕하세요',
              sentAt: '2026-03-27T00:00:00.000Z',
            },
          ],
        }),
        onEvent: vi.fn((listener: (event: unknown) => void) => {
          sessionShareEventListener = listener as any;
          return () => undefined;
        }),
        onChatEvent: vi.fn((listener: (event: unknown) => void) => {
          sessionShareChatEventListener = listener as any;
          return () => undefined;
        }),
      },
      window: {
        close: vi.fn().mockResolvedValue(undefined),
      },
    };

    Object.defineProperty(window, 'dolssh', {
      configurable: true,
      writable: true,
      value: api,
    });
  });

  it('loads the initial snapshot and appends real-time chat events', async () => {
    render(<SessionShareChatWindow sessionId="session-1" />);

    expect(await screen.findByText('안녕하세요')).toBeInTheDocument();
    expect(screen.getByText('Host Session')).toBeInTheDocument();

    await act(async () => {
      sessionShareChatEventListener?.({
        sessionId: 'session-1',
        message: {
          id: 'chat-2',
          nickname: '반짝이는 고래',
          text: '새 메시지',
          sentAt: '2026-03-27T00:01:00.000Z',
        },
      });
    });

    expect(await screen.findByText('새 메시지')).toBeInTheDocument();
    expect(api.window.close).not.toHaveBeenCalled();
  });

  it('closes the detached window when the share becomes inactive', async () => {
    render(<SessionShareChatWindow sessionId="session-1" />);

    await screen.findByText('안녕하세요');

    await act(async () => {
      sessionShareEventListener?.({
        sessionId: 'session-1',
        state: {
          status: 'inactive',
          shareUrl: null,
          inputEnabled: false,
          viewerCount: 0,
          errorMessage: null,
        },
      });
    });

    await waitFor(() => {
      expect(api.window.close).toHaveBeenCalledTimes(1);
    });
  });

  it('closes immediately when the initial snapshot is already inactive', async () => {
    api.sessionShares.getOwnerChatSnapshot.mockResolvedValueOnce({
      sessionId: 'session-1',
      title: 'Host Session',
      state: {
        status: 'inactive',
        shareUrl: null,
        inputEnabled: false,
        viewerCount: 0,
        errorMessage: null,
      },
      messages: [],
    });

    render(<SessionShareChatWindow sessionId="session-1" />);

    await waitFor(() => {
      expect(api.window.close).toHaveBeenCalledTimes(1);
    });
  });
});
