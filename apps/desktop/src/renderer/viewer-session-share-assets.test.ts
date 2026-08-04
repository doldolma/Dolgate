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

// 서버(share_viewer_text.go)가 요청 언어로 골라 data 속성에 실어 주는 문구 집합. 여기서는
// 그 전달 경로를 검증하는 것이 목적이라 필요한 항목만 담는다 — 카탈로그 자체의 완전성은
// sync-api 쪽 테스트가 본다.
const viewerTextFixture = {
  lang: 'ko',
  timeLocale: 'ko-KR',
  sharedSession: '공유된 세션',
  statusConnecting: '연결 중',
  statusEnded: '종료됨',
  shareEnded: '세션 공유가 종료되었습니다.',
  chatOpen: '채팅 열기',
  chatCollapse: '채팅 접기',
  chatStatusConnecting: '연결 중',
  chatStatusEnded: '종료됨',
  chatEmpty: '아직 채팅이 없습니다. 첫 메시지를 보내보세요.',
  chatOwnerBadge: '소유자',
  chatUnknownSender: '알 수 없음',
};

const rawViewerHtml = fs.readFileSync(viewerHtmlPath, 'utf8');

function renderViewerHtml(textJson: string | null): string {
  return rawViewerHtml
    .replaceAll('{{ .AssetVersion }}', 'test')
    .replaceAll('{{ .ShareID }}', 'share-1')
    .replaceAll('{{ .ViewerToken }}', 'viewer-token-1')
    .replaceAll(
      '{{ .TextJSON }}',
      // html/template 이 속성 문맥에서 따옴표를 이스케이프하는 것과 같은 형태로 넣는다.
      textJson === null ? '' : textJson.replaceAll('"', '&#34;'),
    );
}

const viewerHtml = renderViewerHtml(JSON.stringify(viewerTextFixture));
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
  private onRenderListener: (() => void) | null = null;

  constructor(_options: unknown) {
    MockTerminal.instances.push(this);
  }

  onData(listener: (data: string) => void) {
    this.onDataListener = listener;
  }

  onBinary(listener: (data: string) => void) {
    this.onBinaryListener = listener;
  }

  // viewer.js 는 렌더 프레임마다 .xterm-screen 크기를 재서 stage 스케일을 자기교정한다.
  // 여기서는 등록만 받아둔다 — onData/onBinary 와 같이, 이 목은 이벤트를 발화시키지 않는다.
  onRender(listener: () => void) {
    this.onRenderListener = listener;
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

function bootstrapViewerAsset(html: string = viewerHtml) {
  document.open();
  document.write(html);
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

  // 뷰어의 CSP 는 script-src 'self' 라 문구를 data 속성으로 넘긴다. 속성이 비거나 깨져도
  // 페이지는 떠야 한다 — 여기서 죽으면 공유 링크가 아예 열리지 않는다.
  it('문구 속성이 없어도 기본 문구로 동작한다', async () => {
    bootstrapViewerAsset(renderViewerHtml(null));
    await Promise.resolve();

    const chatOpenButton = document.getElementById('viewer-chat-open') as HTMLButtonElement;

    expect(chatOpenButton.textContent?.trim()).toBe('Open chat');
    expect(latestSocket()).toBeTruthy();
  });

  // 익명 닉네임은 페이지 언어에 맞는 낱말로 만들어야 한다 — 영어 페이지에서 "맑은 여우" 가
  // 나오면 읽을 수 없는 사용자에게 자기 이름이 정체불명 문자열로 보인다.
  it.each([
    { lang: 'ko', pattern: /^[가-힣]+ [가-힣]+$/u },
    { lang: 'en', pattern: /^[A-Z][a-z]+ [A-Z][a-z]+$/u },
  ])('$lang 페이지의 익명 닉네임은 그 언어 낱말로 만든다', async ({ lang, pattern }) => {
    window.localStorage.clear();
    bootstrapViewerAsset(
      renderViewerHtml(JSON.stringify({ ...viewerTextFixture, lang })),
    );
    await Promise.resolve();

    const nicknameInput = document.getElementById(
      'viewer-chat-nickname',
    ) as HTMLInputElement;

    expect(nicknameInput.value).toMatch(pattern);
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

    chatInput.value = 'hello';
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
    chatInput.value = 'draft';
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
    chatInput.value = 'ime';
    chatInput.dispatchEvent(composingEnter);
    chatInput.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));

    expect(
      chatPayloads(socket).filter((payload) => payload.type === 'chat-send'),
    ).toHaveLength(sentBeforeShiftEnter);
  });

  it('renders owner messages without duplicating the owner suffix and clears chat UI on share end', async () => {
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
            nickname: 'Synology Owner',
            senderRole: 'owner',
            text: 'hello\nthere',
            sentAt: '2026-03-28T00:00:00.000Z',
          },
        }),
      }),
    );

    expect(messages.textContent).toContain('hello');
    expect(messages.textContent).toContain('there');
    expect(messages.textContent).toContain(viewerTextFixture.chatOwnerBadge);
    expect(messages.textContent).not.toContain('Synology Owner');
    expect(messages.querySelector('.viewer-chat-message--owner')).toBeTruthy();
    expect(
      messages.querySelector('.viewer-chat-message__meta strong')?.textContent,
    ).toBe('Synology');

    socket.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'share-ended',
          message: 'share ended',
          reason: 'ended',
        }),
      }),
    );

    expect(messages.textContent).toContain(viewerTextFixture.chatEmpty);
    expect(nicknameInput.disabled).toBe(true);
    expect(chatInput.disabled).toBe(true);
    expect(submitButton.disabled).toBe(true);
  });

  it('keeps multiline and owner styling in the shared asset CSS', () => {
    expect(viewerCss).toContain('.viewer-chat-message p {');
    expect(viewerCss).toContain('white-space: pre-wrap;');
    expect(viewerCss).toContain('.viewer-chat-messages {');
    expect(viewerCss).toContain('overflow-y: auto;');
    expect(viewerCss).toContain('.viewer-chat-message--owner {');
    expect(viewerCss).toContain('.viewer-chat-message__badge {');
  });

  it('writes VT snapshot resync payloads back into the viewer terminal unchanged', async () => {
    await Promise.resolve();
    const socket = latestSocket();
    const terminal = MockTerminal.instances.at(-1);
    if (!terminal) {
      throw new Error('viewer asset did not create a terminal');
    }

    const snapshot = '\u001b[?1049h\u001b[H\tfoo\r\n\t\tbar';

    socket.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'snapshot-resync',
          snapshot,
          cols: 132,
          rows: 36,
          terminalAppearance: null,
          viewportPx: null,
        }),
      }),
    );

    expect(terminal.resize).toHaveBeenCalledWith(132, 36);
    expect(terminal.reset).toHaveBeenCalled();
    expect(terminal.write).toHaveBeenCalledWith(snapshot, expect.any(Function));
    const resizeCallOrder = terminal.resize.mock.invocationCallOrder.at(-1);
    const resetCallOrder = terminal.reset.mock.invocationCallOrder.at(-1);
    const writeCallOrder = terminal.write.mock.invocationCallOrder.at(-1);
    expect(resizeCallOrder).toBeLessThan(resetCallOrder ?? Number.POSITIVE_INFINITY);
    expect(resetCallOrder).toBeLessThan(writeCallOrder ?? Number.POSITIVE_INFINITY);
  });
});
