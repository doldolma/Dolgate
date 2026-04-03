import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionShareChatWindow } from './SessionShareChatWindow';

describe('SessionShareChatWindow', () => {
  let sessionShareEventListener: ((event: any) => void) | null;
  let sessionShareChatEventListener: ((event: any) => void) | null;
  let api: any;
  let scrollIntoViewMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessionShareEventListener = null;
    sessionShareChatEventListener = null;
    scrollIntoViewMock = vi.fn();

    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });

    Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoViewMock,
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
          ownerNickname: 'Synology Owner',
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
              nickname: 'Viewer One',
              senderRole: 'viewer',
              text: 'hello',
              sentAt: '2026-03-27T00:00:00.000Z',
            },
          ],
        }),
        sendOwnerChatMessage: vi.fn().mockResolvedValue(undefined),
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

    expect(await screen.findByText('hello')).toBeInTheDocument();
    expect(screen.getByText('Host Session')).toBeInTheDocument();
    expect(screen.queryByText('Synology Owner')).toBeNull();
    expect(screen.queryByText('보내는 이름')).toBeNull();
    expect(scrollIntoViewMock).toHaveBeenCalled();
    const initialScrollCallCount = scrollIntoViewMock.mock.calls.length;

    await act(async () => {
      sessionShareChatEventListener?.({
        sessionId: 'session-1',
        message: {
          id: 'chat-2',
          nickname: 'Viewer Two',
          senderRole: 'viewer',
          text: 'second message',
          sentAt: '2026-03-27T00:01:00.000Z',
        },
      });
    });

    expect(await screen.findByText('second message')).toBeInTheDocument();
    expect(scrollIntoViewMock.mock.calls.length).toBeGreaterThan(initialScrollCallCount);
    expect(api.window.close).not.toHaveBeenCalled();
  });

  it('sends owner chat messages, clears the draft, restores focus, and renders owner badges without duplicate owner text', async () => {
    const { container } = render(<SessionShareChatWindow sessionId="session-1" />);

    expect(await screen.findByText('hello')).toBeInTheDocument();

    const input = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(input).toBeTruthy();
    input.focus();
    fireEvent.change(input, { target: { value: 'owner message' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(api.sessionShares.sendOwnerChatMessage).toHaveBeenCalledWith(
        'session-1',
        'owner message',
      );
    });
    await waitFor(() => {
      expect(input).toHaveFocus();
    });
    expect(input.value).toBe('');

    await act(async () => {
      sessionShareChatEventListener?.({
        sessionId: 'session-1',
        message: {
          id: 'chat-2',
          nickname: 'Synology Owner',
          senderRole: 'owner',
          text: 'owner message',
          sentAt: '2026-03-27T00:01:00.000Z',
        },
      });
    });

    expect(await screen.findByText('owner message')).toBeInTheDocument();
    expect(screen.getAllByText('Owner').length).toBeGreaterThan(0);
    expect(screen.queryByText('Synology Owner')).toBeNull();
    expect(
      container.querySelector(
        '.session-share-chat-window__message--owner .session-share-chat-window__meta-name strong',
      )?.textContent,
    ).toBe('Synology');
  });

  it('keeps multiline input on Shift+Enter and skips submit during IME composition', async () => {
    const { container } = render(<SessionShareChatWindow sessionId="session-1" />);

    const input = (await waitFor(() => container.querySelector('textarea'))) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'draft' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(api.sessionShares.sendOwnerChatMessage).not.toHaveBeenCalled();

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'composing' } });
    const composingEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(composingEnter, 'isComposing', {
      configurable: true,
      value: true,
    });
    input.dispatchEvent(composingEnter);
    fireEvent.compositionEnd(input);

    expect(api.sessionShares.sendOwnerChatMessage).not.toHaveBeenCalled();
  });

  it('keeps the draft and shows an inline error when send fails', async () => {
    api.sessionShares.sendOwnerChatMessage.mockRejectedValueOnce(new Error('send failed'));

    const { container } = render(<SessionShareChatWindow sessionId="session-1" />);

    const input = (await waitFor(() => container.querySelector('textarea'))) as HTMLTextAreaElement;
    const submitButton = container.querySelector('button[type="submit"]');
    expect(submitButton).toBeTruthy();

    input.focus();
    fireEvent.change(input, { target: { value: 'failed message' } });
    fireEvent.click(submitButton!);

    expect(await screen.findByText('send failed')).toBeInTheDocument();
    await waitFor(() => {
      expect(input).toHaveFocus();
    });
    expect(input.value).toBe('failed message');
  });

  it('closes the detached window when the share becomes inactive', async () => {
    render(<SessionShareChatWindow sessionId="session-1" />);

    await screen.findByText('hello');

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
      ownerNickname: 'Synology Owner',
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
