import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');
const viewerHtmlPath = path.join(
  repoRoot,
  'services/sync-api/internal/http/share_assets/viewer.html',
);
const viewerJsPath = path.join(
  repoRoot,
  'services/sync-api/internal/http/share_assets/viewer.js',
);
const viewerCssPath = path.join(
  repoRoot,
  'services/sync-api/internal/http/share_assets/viewer.css',
);

const viewerHtml = fs
  .readFileSync(viewerHtmlPath, 'utf8')
  .replaceAll('{{ .AssetVersion }}', 'test')
  .replaceAll('{{ .ShareID }}', 'share-1')
  .replaceAll('{{ .ViewerToken }}', 'viewer-token-1');
const viewerScript = fs.readFileSync(viewerJsPath, 'utf8');
const viewerCss = fs.readFileSync(viewerCssPath, 'utf8');

class MockResizeObserver {
  observe() {}
  disconnect() {}
}

class MockTerminal {
  static instances: MockTerminal[] = [];

  cols = 80;
  rows = 24;
  options = {
    disableStdin: false,
    fontFamily: '',
    fontSize: 13,
    lineHeight: 1,
    letterSpacing: 0,
  };
  unicode = {
    activeVersion: '',
  };
  readonly open = vi.fn();
  readonly loadAddon = vi.fn();
  readonly attachCustomKeyEventHandler = vi.fn();
  readonly focus = vi.fn();
  readonly resize = vi.fn((cols: number, rows: number) => {
    this.cols = cols;
    this.rows = rows;
  });
  readonly write = vi.fn((_data: unknown, callback?: () => void) => {
    callback?.();
  });
  readonly writeln = vi.fn();
  readonly reset = vi.fn();
  private onDataListener: ((data: string) => void) | null = null;
  private onBinaryListener: ((data: string) => void) | null = null;

  constructor(_options: unknown) {
    MockTerminal.instances.push(this);
  }

  onData(listener: (data: string) => void) {
    this.onDataListener = listener;
  }

  onBinary(listener: (data: string) => void) {
    this.onBinaryListener = listener;
  }
}

class MockWebSocket extends EventTarget {
  static instances: MockWebSocket[] = [];
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readonly sent: string[] = [];
  readonly url: string;
  readyState = MockWebSocket.OPEN;

  constructor(url: string) {
    super();
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.dispatchEvent(new Event('open'));
    });
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }
}

function bootstrapViewerAsset() {
  document.open();
  document.write(viewerHtml);
  document.close();
  window.history.replaceState({}, '', '/share/share-1/viewer-token-1');
  Object.defineProperty(window, 'Terminal', {
    configurable: true,
    writable: true,
    value: MockTerminal,
  });
  Object.defineProperty(window, 'WebSocket', {
    configurable: true,
    writable: true,
    value: MockWebSocket,
  });
  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: MockResizeObserver,
  });
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
  });
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  window.eval(viewerScript);
}

function latestSocket(): MockWebSocket {
  const socket = MockWebSocket.instances.at(-1);
  if (!socket) {
    throw new Error('viewer asset did not create a websocket');
  }
  return socket;
}

function chatPayloads(socket: MockWebSocket): Array<{ type: string; [key: string]: unknown }> {
  return socket.sent.map((payload) => JSON.parse(payload) as { type: string });
}

describe('session share viewer assets', () => {
  beforeEach(() => {
    MockTerminal.instances.length = 0;
    MockWebSocket.instances.length = 0;
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    bootstrapViewerAsset();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('starts collapsed and opens the chat panel from the small open button', async () => {
    const chatOpenButton = document.getElementById('viewer-chat-open') as HTMLButtonElement;
    const chatPanel = document.getElementById('viewer-chat-panel') as HTMLElement;
    const chatBody = document.getElementById('viewer-chat-body') as HTMLElement;

    await Promise.resolve();

    expect(chatOpenButton.hidden).toBe(false);
    expect(chatPanel.hidden).toBe(true);
    expect(chatBody.hidden).toBe(true);

    chatOpenButton.click();

    expect(chatOpenButton.hidden).toBe(true);
    expect(chatPanel.hidden).toBe(false);
    expect(chatBody.hidden).toBe(false);
  });

  it('submits once on Enter, skips Shift+Enter, and ignores Enter during IME composition', async () => {
    const chatInput = document.getElementById('viewer-chat-input') as HTMLTextAreaElement;

    await Promise.resolve();
    const socket = latestSocket();
    const initialMessageCount = chatPayloads(socket).filter(
      (payload) => payload.type === 'chat-send',
    ).length;

    chatInput.value = '안녕하세요';
    chatInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    const payloadsAfterEnter = chatPayloads(socket);
    expect(
      payloadsAfterEnter.filter((payload) => payload.type === 'chat-send'),
    ).toHaveLength(initialMessageCount + 1);
    expect(
      payloadsAfterEnter.filter((payload) => payload.type === 'chat-profile'),
    ).toHaveLength(1);

    const sentBeforeShiftEnter = chatPayloads(socket).filter(
      (payload) => payload.type === 'chat-send',
    ).length;
    chatInput.value = '줄1';
    chatInput.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }),
    );
    expect(
      chatPayloads(socket).filter((payload) => payload.type === 'chat-send'),
    ).toHaveLength(sentBeforeShiftEnter);

    chatInput.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const composingEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(composingEnter, 'isComposing', {
      configurable: true,
      value: true,
    });
    chatInput.value = 'ㅋ';
    chatInput.dispatchEvent(composingEnter);
    chatInput.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));

    expect(
      chatPayloads(socket).filter((payload) => payload.type === 'chat-send'),
    ).toHaveLength(sentBeforeShiftEnter);
  });

  it('renders multiline chat messages and clears chat UI on share end', async () => {
    const socket = latestSocket();
    const messages = document.getElementById('viewer-chat-messages') as HTMLElement;
    const nicknameInput = document.getElementById('viewer-chat-nickname') as HTMLInputElement;
    const chatInput = document.getElementById('viewer-chat-input') as HTMLTextAreaElement;
    const submitButton = document.getElementById('viewer-chat-submit') as HTMLButtonElement;

    socket.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'chat-message',
          message: {
            id: 'chat-1',
            nickname: '맑은 다람쥐',
            text: '안녕\n하세요',
            sentAt: '2026-03-28T00:00:00.000Z',
          },
        }),
      }),
    );

    expect(messages.textContent).toContain('안녕\n하세요');

    socket.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'share-ended',
          message: '세션 공유가 종료되었습니다.',
        }),
      }),
    );

    expect(messages.textContent).toContain('아직 채팅이 없습니다.');
    expect(nicknameInput.disabled).toBe(true);
    expect(chatInput.disabled).toBe(true);
    expect(submitButton.disabled).toBe(true);
  });

  it('keeps multiline and internal scroll styling in the shared asset CSS', () => {
    expect(viewerCss).toContain('.viewer-chat-message p {');
    expect(viewerCss).toContain('white-space: pre-wrap;');
    expect(viewerCss).toContain('.viewer-chat-messages {');
    expect(viewerCss).toContain('overflow-y: auto;');
  });
});
