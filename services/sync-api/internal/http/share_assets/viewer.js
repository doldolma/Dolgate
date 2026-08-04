(function () {
  const body = document.body;
  const shareId = body.dataset.shareId;
  const viewerToken = body.dataset.viewerToken;
  // 서버가 요청 언어로 고른 문구 집합. 뷰어의 CSP 는 script-src 'self' 라 인라인 <script>
  // 로는 넘길 수 없어서 data 속성으로 받는다. 속성이 없거나 깨져도 페이지는 떠야 하므로
  // 영어 기본값으로 채운다.
  const TEXT = (function () {
    const fallback = {
      lang: "en",
      timeLocale: "en-US",
      sharedSession: "Shared Session",
      statusConnecting: "Connecting",
      statusReadOnly: "Read only",
      statusInputEnabled: "Input enabled",
      statusEnded: "Ended",
      viewerCountOneFormat: "%s · %d viewer",
      viewerCountManyFormat: "%s · %d viewers",
      shareEnded: "The session share has ended.",
      chatOpen: "Open chat",
      chatCollapse: "Collapse chat",
      chatStatusConnecting: "Connecting",
      chatStatusReady: "Ready",
      chatStatusEnded: "Ended",
      chatEmpty: "No messages yet. Send the first one.",
      chatOwnerBadge: "Owner",
      chatUnknownSender: "Unknown",
    };
    try {
      const parsed = JSON.parse(body.dataset.viewerText || "{}");
      return Object.assign(fallback, parsed && typeof parsed === "object" ? parsed : {});
    } catch (error) {
      return fallback;
    }
  })();

  function formatCount(template, label, count) {
    return String(template).replace("%s", label).replace("%d", String(count));
  }
  const titleNode = document.getElementById("viewer-title");
  const statusNode = document.getElementById("viewer-status");
  const shellNode = document.getElementById("viewer-shell");
  const viewportNode = document.getElementById("viewer-terminal-viewport");
  const stageNode = document.getElementById("viewer-terminal-stage");
  const terminalNode = document.getElementById("viewer-terminal");
  const searchOverlayNode = document.getElementById("viewer-search-overlay");
  const searchInputNode = document.getElementById("viewer-search-input");
  const searchPrevButtonNode = document.getElementById("viewer-search-prev");
  const searchNextButtonNode = document.getElementById("viewer-search-next");
  const searchCloseButtonNode = document.getElementById("viewer-search-close");
  const chatOpenNode = document.getElementById("viewer-chat-open");
  const chatPanelNode = document.getElementById("viewer-chat-panel");
  const chatBodyNode = document.getElementById("viewer-chat-body");
  const chatStatusNode = document.getElementById("viewer-chat-status");
  const chatToggleNode = document.getElementById("viewer-chat-toggle");
  const chatMessagesNode = document.getElementById("viewer-chat-messages");
  const chatFormNode = document.getElementById("viewer-chat-form");
  const chatNicknameNode = document.getElementById("viewer-chat-nickname");
  const chatInputNode = document.getElementById("viewer-chat-input");
  const chatSubmitNode = document.getElementById("viewer-chat-submit");
  const textEncoder = new TextEncoder();
  const DEFAULT_FALLBACK_SCALE = 0.85;
  const VIEWPORT_SAFE_GUTTER_PX = 24;
  const VIEWPORT_SAFE_SCALE_FACTOR = 0.98;
  const CHAT_NICKNAME_STORAGE_KEY = "dolssh.sessionShare.chatNickname";
  // 소유자 앱이 닉네임 뒤에 붙여 보내는 와이어 값. 화면에 보이는 배지 문구
  // (TEXT.chatOwnerBadge)와 달리 절대 번역하지 않는다 — 아래에서 이 접미사를 정규식으로
  // 벗겨내므로, 번역하면 소유자 닉네임이 "Synology Owner" 처럼 그대로 남는다.
  const OWNER_NICKNAME_WIRE_SUFFIX = "Owner";
  // 익명 닉네임 후보. 8×8=64 조합은 방에 사람이 몇 명만 모여도 겹쳤다 — 16×16=256 으로 늘렸다.
  const CHAT_NICKNAME_WORDS = {
    ko: {
      adjectives: [
        "맑은",
        "반짝이는",
        "든든한",
        "재빠른",
        "부드러운",
        "고요한",
        "용감한",
        "기분좋은",
        "산뜻한",
        "다정한",
        "씩씩한",
        "느긋한",
        "총명한",
        "발랄한",
        "우아한",
        "야무진",
      ],
      nouns: [
        "여우",
        "고래",
        "다람쥐",
        "호랑이",
        "참새",
        "고양이",
        "해달",
        "별빛",
        "사슴",
        "물범",
        "학",
        "부엉이",
        "살쾡이",
        "오리",
        "나비",
        "반달곰",
      ],
    },
    en: {
      adjectives: [
        "Bright",
        "Sparkling",
        "Sturdy",
        "Swift",
        "Gentle",
        "Quiet",
        "Brave",
        "Cheerful",
        "Clever",
        "Curious",
        "Eager",
        "Kind",
        "Lively",
        "Mellow",
        "Nimble",
        "Sunny",
      ],
      nouns: [
        "Fox",
        "Whale",
        "Squirrel",
        "Tiger",
        "Sparrow",
        "Cat",
        "Otter",
        "Starlight",
        "Deer",
        "Seal",
        "Crane",
        "Owl",
        "Lynx",
        "Duck",
        "Moth",
        "Bear",
      ],
    },
  };
  const SEARCH_DECORATIONS = {
    matchBackground: "#243451",
    matchBorder: "#42567f",
    matchOverviewRuler: "#42567f",
    activeMatchBackground: "#4663de",
    activeMatchBorder: "#9fb3ff",
    activeMatchColorOverviewRuler: "#9fb3ff",
  };

  if (
    !shareId ||
    !viewerToken ||
    !window.Terminal ||
    !shellNode ||
    !viewportNode ||
    !stageNode ||
    !terminalNode ||
    !chatOpenNode ||
    !chatPanelNode ||
    !chatBodyNode ||
    !chatStatusNode ||
    !chatToggleNode ||
    !chatMessagesNode ||
    !chatFormNode ||
    !chatNicknameNode ||
    !chatInputNode ||
    !chatSubmitNode
  ) {
    return;
  }

  // 인라인 이미지 애드온은 출력 캔버스의 2d 컨텍스트를 desynchronized: true(저지연 캔버스)로
  // 만든다. 그러면 브라우저가 그 캔버스를 오버레이 합성 평면으로 승격시키고, 그 평면은 캔버스
  // 비트맵만 표시하면서 아래 레이어를 가려버린다 — 투명 픽셀(RGBA 0,0,0,0)이어도 마찬가지다.
  // 이미지가 뜨는 순간 터미널 전체가 검게 보이는 원인이 이것이다.
  //
  // CSS 로는 되돌릴 수 없다. isolation: isolate, mix-blend-mode, 캔버스 요소에 배경색 지정
  // 모두 실패했다(요소의 CSS 배경은 가려지는 쪽 레이어에 그려진다). 그래서 플래그 자체를 뗀다.
  //
  // 데스크톱 앱이 멀쩡한 이유는 버전이 아니라 렌더러다 — 거기는 WebGL 렌더러가 기본이라
  // 텍스트도 .xterm-screen 안의 캔버스이고, 애드온이 설계된 환경이다. 뷰어는 DOM 렌더러라
  // 텍스트가 흐름 안의 div 이므로 오버레이에 가려진다. 뷰어는 transform: scale() 로 확대하기
  // 때문에 캔버스 렌더러를 쓰면 글자가 흐려져서, 렌더러를 바꾸는 대신 이 플래그를 떼는 쪽을
  // 택했다.
  //
  // 애드온이 클래스를 먼저 붙이고 getContext 를 부르므로(ImageRenderer.insertLayerToDom) 그
  // 캔버스만 정확히 겨냥할 수 있다. desynchronized 는 지연 최적화 힌트일 뿐이라 떼도 기능은
  // 같다.
  const nativeGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (contextType, options) {
    if (options?.desynchronized && this.classList?.contains("xterm-image-layer")) {
      return nativeGetContext.call(this, contextType, { ...options, desynchronized: false });
    }
    return nativeGetContext.call(this, contextType, options);
  };

  const term = new window.Terminal({
    allowProposedApi: true,
    cursorBlink: false,
    convertEol: false,
    fontFamily:
      'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    lineHeight: 1,
    letterSpacing: 0,
    theme: {
      background: "#0f1726",
      foreground: "#eef3ff",
      cursor: "#8aa1ff",
      black: "#0f1726",
      blue: "#7d98ff",
      brightBlack: "#61719a",
      brightBlue: "#9fb3ff",
      brightCyan: "#94eef8",
      brightGreen: "#a1f0bf",
      brightMagenta: "#d5b6ff",
      brightRed: "#ff9fb0",
      brightWhite: "#ffffff",
      brightYellow: "#ffe49d",
      cyan: "#73d9e5",
      green: "#7ed6a2",
      magenta: "#c6a0ff",
      red: "#ff7d90",
      white: "#eef3ff",
      yellow: "#ffd579",
    },
  });

  function setStatus(text) {
    statusNode.textContent = text;
  }

  function setChatStatus(text) {
    chatStatusNode.textContent = text;
  }

  function setChatEnabled(enabled) {
    chatNicknameNode.disabled = !enabled;
    chatInputNode.disabled = !enabled;
    chatSubmitNode.disabled = !enabled;
  }

  function setChatCollapsed(collapsed) {
    chatCollapsed = Boolean(collapsed);
    shellNode.dataset.chatCollapsed = chatCollapsed ? "true" : "false";
    chatPanelNode.dataset.collapsed = chatCollapsed ? "true" : "false";
    chatPanelNode.hidden = chatCollapsed;
    chatBodyNode.hidden = chatCollapsed;
    chatOpenNode.hidden = !chatCollapsed;
    chatOpenNode.textContent = TEXT.chatOpen;
    chatOpenNode.setAttribute("aria-expanded", chatCollapsed ? "false" : "true");
    chatToggleNode.textContent = TEXT.chatCollapse;
    chatToggleNode.setAttribute("aria-expanded", chatCollapsed ? "false" : "true");

    if (!chatCollapsed) {
      requestAnimationFrame(() => {
        chatMessagesNode.scrollTop = chatMessagesNode.scrollHeight;
        if (!chatInputNode.disabled) {
          chatInputNode.focus();
        }
      });
    }
  }

  function setInputEnabled(inputEnabled) {
    term.options.disableStdin = !inputEnabled;
    setStatus(inputEnabled ? TEXT.statusInputEnabled : TEXT.statusReadOnly);
  }

  function decodeBase64Bytes(input) {
    const raw = atob(input);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) {
      bytes[index] = raw.charCodeAt(index);
    }
    return bytes;
  }

  function encodeBytesBase64(bytes) {
    let raw = "";
    for (let index = 0; index < bytes.length; index += 1) {
      raw += String.fromCharCode(bytes[index]);
    }
    return btoa(raw);
  }

  function sendBinaryMessage(base64Data) {
    if (socket.readyState !== WebSocket.OPEN || term.options.disableStdin) {
      return;
    }

    socket.send(
      JSON.stringify({
        type: "input",
        encoding: "binary",
        data: base64Data,
      })
    );
  }

  function sendControlSignal(signal) {
    if (!signal || socket.readyState !== WebSocket.OPEN || term.options.disableStdin) {
      return;
    }

    socket.send(
      JSON.stringify({
        type: "control-signal",
        signal,
      })
    );
  }

  function sendChatProfile(nickname) {
    if (!nickname || socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    socket.send(
      JSON.stringify({
        type: "chat-profile",
        nickname,
      })
    );
    syncedChatNickname = nickname;
    return true;
  }

  function syncChatNicknameFromInput() {
    const normalized = normalizeChatNickname(chatNicknameNode.value);
    if (!normalized) {
      if (syncedChatNickname) {
        chatNicknameNode.value = syncedChatNickname;
      }
      return "";
    }

    chatNicknameNode.value = normalized;
    storeChatNickname(normalized);
    if (normalized !== syncedChatNickname) {
      sendChatProfile(normalized);
    }
    return normalized;
  }

  function sendChatText(text) {
    if (!text || socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    socket.send(
      JSON.stringify({
        type: "chat-send",
        text,
      })
    );
    return true;
  }

  function sendUtf8Text(text) {
    if (!text) {
      return;
    }

    sendBinaryMessage(encodeBytesBase64(textEncoder.encode(text)));
  }

  function sendBinaryInput(data) {
    if (!data) {
      return;
    }

    sendBinaryMessage(
      encodeBytesBase64(
        Uint8Array.from(data, (char) => char.charCodeAt(0))
      )
    );
  }

  function safeWarn(message, error) {
    if (error) {
      console.warn(message, error);
      return;
    }

    console.warn(message);
  }

  function normalizeChatNickname(value) {
    const trimmed = String(value || "").trim();
    if (!trimmed || /[\r\n]/.test(trimmed) || trimmed.length > 24) {
      return "";
    }
    return trimmed;
  }

  function normalizeChatText(value) {
    const normalized = String(value || "").replace(/\r\n?/g, "\n");
    const trimmed = normalized.trim();
    if (!trimmed || trimmed.length > 300) {
      return "";
    }
    return trimmed;
  }

  function randomNickname() {
    const words = CHAT_NICKNAME_WORDS[TEXT.lang] || CHAT_NICKNAME_WORDS.en;
    const adjectives = words.adjectives;
    const nouns = words.nouns;
    const adjective = adjectives[Math.floor(Math.random() * adjectives.length)] || adjectives[0];
    const noun = nouns[Math.floor(Math.random() * nouns.length)] || nouns[0];
    return `${adjective} ${noun}`;
  }

  function loadStoredChatNickname() {
    try {
      return window.localStorage.getItem(CHAT_NICKNAME_STORAGE_KEY) || "";
    } catch {
      return "";
    }
  }

  function storeChatNickname(nickname) {
    try {
      window.localStorage.setItem(CHAT_NICKNAME_STORAGE_KEY, nickname);
    } catch {
      // ignore storage failures
    }
  }

  function resolveInitialChatNickname() {
    const stored = normalizeChatNickname(loadStoredChatNickname());
    if (stored) {
      return stored;
    }
    const generated = randomNickname();
    storeChatNickname(generated);
    return generated;
  }

  function formatChatTimestamp(sentAt) {
    const date = new Date(sentAt);
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    return date.toLocaleTimeString(TEXT.timeLocale, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function resolveChatSenderRole(senderRole) {
    return senderRole === "owner" ? "owner" : "viewer";
  }

  function getDisplayChatNickname(nickname, senderRole) {
    const normalized = String(nickname || "").trim();
    if (!normalized) {
      return senderRole === "owner" ? TEXT.chatOwnerBadge : TEXT.chatUnknownSender;
    }
    if (senderRole !== "owner") {
      return normalized;
    }

    const withoutOwnerSuffix = normalized
      .replace(new RegExp(`\\s+${OWNER_NICKNAME_WIRE_SUFFIX}$`, "u"), "")
      .trim();
    return withoutOwnerSuffix || normalized;
  }

  function renderChatMessages() {
    chatMessagesNode.replaceChildren();

    if (chatMessages.length === 0) {
      const emptyNode = document.createElement("div");
      emptyNode.className = "viewer-chat-empty";
      emptyNode.textContent = TEXT.chatEmpty;
      chatMessagesNode.appendChild(emptyNode);
      return;
    }

    for (const message of chatMessages) {
      const senderRole = resolveChatSenderRole(message.senderRole);
      const item = document.createElement("article");
      item.className = senderRole === "owner" ? "viewer-chat-message viewer-chat-message--owner" : "viewer-chat-message";

      const meta = document.createElement("div");
      meta.className = "viewer-chat-message__meta";

      const nameGroup = document.createElement("div");
      nameGroup.className = "viewer-chat-message__meta-name";

      const nickname = document.createElement("strong");
      nickname.textContent = getDisplayChatNickname(message.nickname, senderRole);
      nameGroup.appendChild(nickname);

      if (senderRole === "owner") {
        const badge = document.createElement("span");
        badge.className = "viewer-chat-message__badge";
        badge.textContent = TEXT.chatOwnerBadge;
        nameGroup.appendChild(badge);
      }

      meta.appendChild(nameGroup);

      const timestamp = document.createElement("time");
      timestamp.dateTime = message.sentAt || "";
      timestamp.textContent = formatChatTimestamp(message.sentAt);
      meta.appendChild(timestamp);

      const text = document.createElement("p");
      text.textContent = message.text || "";

      item.append(meta, text);
      chatMessagesNode.appendChild(item);
    }

    chatMessagesNode.scrollTop = chatMessagesNode.scrollHeight;
  }

  function clearChatMessages() {
    chatMessages.length = 0;
    renderChatMessages();
  }

  function appendChatMessage(message) {
    if (!message || typeof message !== "object") {
      return;
    }
    chatMessages.push({
      id: String(message.id || ""),
      nickname: String(message.nickname || ""),
      senderRole: resolveChatSenderRole(message.senderRole),
      text: String(message.text || ""),
      sentAt: String(message.sentAt || ""),
    });
    renderChatMessages();
  }

  function shouldOpenTerminalSearch(event) {
    return (event.ctrlKey || event.metaKey) && typeof event.key === "string" && event.key.toLowerCase() === "f";
  }

  function normalizeTerminalAppearance(input) {
    if (!input || typeof input !== "object") {
      return null;
    }

    const fontFamily = typeof input.fontFamily === "string" && input.fontFamily.trim() ? input.fontFamily : null;
    const fontSize = Number.isFinite(input.fontSize) && input.fontSize > 0 ? input.fontSize : null;
    const lineHeight = Number.isFinite(input.lineHeight) && input.lineHeight > 0 ? input.lineHeight : null;
    const letterSpacing = Number.isFinite(input.letterSpacing) ? input.letterSpacing : null;

    if (!fontFamily || !fontSize || !lineHeight || letterSpacing == null) {
      return null;
    }

    return {
      fontFamily,
      fontSize,
      lineHeight,
      letterSpacing,
    };
  }

  function normalizeViewportPx(input) {
    if (!input || typeof input !== "object") {
      return null;
    }

    const width = Math.floor(Number(input.width));
    const height = Math.floor(Number(input.height));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null;
    }

    return { width, height };
  }

  let latestAppearance = normalizeTerminalAppearance(null);
  let latestViewportPx = null;
  let currentTransport = "ssh";
  let scaleFrameHandle = 0;
  let searchOpen = false;
  let searchAddon = null;
  let chatCollapsed = true;
  let chatInputComposing = false;
  const chatMessages = [];
  let syncedChatNickname = "";

  function scheduleScaleSync() {
    if (scaleFrameHandle) {
      cancelAnimationFrame(scaleFrameHandle);
    }

    scaleFrameHandle = requestAnimationFrame(() => {
      scaleFrameHandle = 0;
      syncStageScale();
    });
  }

  function setStageDimensions(width, height) {
    stageNode.style.width = `${width}px`;
    stageNode.style.height = `${height}px`;
    terminalNode.style.width = `${width}px`;
    terminalNode.style.height = `${height}px`;
  }

  // 주인이 보내는 viewportPx 는 주인 쪽 렌더러가 계산한 픽셀 크기다. 뷰어 브라우저는 폰트
  // 가용성과 devicePixelRatio 가 달라 같은 fontSize/lineHeight 로도 셀 크기를 다르게 잡을 수
  // 있고, 그러면 rows 를 다 그리는 데 필요한 높이가 주인의 값보다 커진다. 컨테이너에
  // overflow: hidden 이 걸려 있어 그 초과분은 마지막 행이 잘리는 형태로만 드러난다.
  //
  // xterm 은 .xterm-screen 에 그리드의 실제 픽셀 크기(dimensions.css.canvas)를 명시적으로
  // 넣으므로 그 값을 재서 하한으로 쓴다. offsetWidth/offsetHeight 를 쓰는 이유는 이 요소가
  // transform: scale() 된 stage 안에 있어서 getBoundingClientRect() 는 축소된 값을 주기
  // 때문이다 — offset* 은 변환 전 레이아웃 픽셀을 돌려준다.
  //
  // 뷰어는 fit 애드온을 쓰지 않고 그리드가 term.resize(cols, rows) 로만 정해지므로, 컨테이너를
  // 키워도 그리드가 다시 바뀌지 않는다(되먹임 없음).
  function measureRenderedGridPx() {
    const screen = terminalNode.querySelector(".xterm-screen");
    if (!screen) {
      return null;
    }

    const width = screen.offsetWidth;
    const height = screen.offsetHeight;
    if (!(width > 0) || !(height > 0)) {
      return null;
    }
    return { width, height };
  }

  function applyTerminalAppearance(appearance) {
    const normalized = normalizeTerminalAppearance(appearance);
    if (!normalized) {
      return;
    }

    latestAppearance = normalized;
    term.options.fontFamily = normalized.fontFamily;
    term.options.fontSize = normalized.fontSize;
    term.options.lineHeight = normalized.lineHeight;
    term.options.letterSpacing = normalized.letterSpacing;
  }

  function syncStageScale() {
    const availableWidth = viewportNode.clientWidth;
    const availableHeight = viewportNode.clientHeight;
    if (availableWidth <= 0 || availableHeight <= 0) {
      stageNode.style.transform = `scale(${DEFAULT_FALLBACK_SCALE})`;
      return;
    }

    const baseViewport = latestViewportPx;
    if (!baseViewport) {
      stageNode.style.transform = `scale(${DEFAULT_FALLBACK_SCALE})`;
      return;
    }

    // 주인이 보고한 크기와 뷰어가 실제로 그린 그리드 크기 중 큰 쪽을 쓴다 — 작은 쪽을 쓰면
    // 그 차이만큼 마지막 행/열이 잘린다.
    const renderedGrid = measureRenderedGridPx();
    const stageWidth = Math.max(baseViewport.width, renderedGrid?.width ?? 0);
    const stageHeight = Math.max(baseViewport.height, renderedGrid?.height ?? 0);
    setStageDimensions(stageWidth, stageHeight);

    const safeWidth = Math.max(0, availableWidth - VIEWPORT_SAFE_GUTTER_PX);
    const safeHeight = Math.max(0, availableHeight - VIEWPORT_SAFE_GUTTER_PX);
    const widthScale = safeWidth / stageWidth;
    const heightScale = safeHeight / stageHeight;
    const scale = Math.min(widthScale, heightScale, 1) * VIEWPORT_SAFE_SCALE_FACTOR;
    stageNode.style.transform = `scale(${Number.isFinite(scale) && scale > 0 ? scale : DEFAULT_FALLBACK_SCALE})`;
  }

  function applyViewerLayoutMetadata(payload) {
    applyTerminalAppearance(payload?.terminalAppearance);

    const normalizedViewport = normalizeViewportPx(payload?.viewportPx);
    latestViewportPx = normalizedViewport;

    if (!normalizedViewport) {
      stageNode.style.removeProperty("width");
      stageNode.style.removeProperty("height");
      terminalNode.style.width = "100%";
      terminalNode.style.height = "100%";
    }

    scheduleScaleSync();
  }

  function canUseSearch() {
    return Boolean(searchAddon && searchOverlayNode && searchInputNode);
  }

  function resolveAwsShareControlSignal(event) {
    if (currentTransport !== "aws-ssm" || !event.ctrlKey || event.metaKey || event.altKey) {
      return null;
    }

    if (event.code === "KeyC" || (typeof event.key === "string" && event.key.toLowerCase() === "c")) {
      return "interrupt";
    }
    if (event.code === "KeyZ" || (typeof event.key === "string" && event.key.toLowerCase() === "z")) {
      return "suspend";
    }
    if (event.code === "Backslash" || event.key === "\\") {
      return "quit";
    }

    return null;
  }

  function focusSearchInput() {
    if (!searchInputNode) {
      return;
    }

    requestAnimationFrame(() => {
      searchInputNode.focus();
      searchInputNode.select();
    });
  }

  function setSearchOpen(open) {
    searchOpen = open;
    if (!searchOverlayNode) {
      return;
    }

    searchOverlayNode.hidden = !open;
    if (open) {
      focusSearchInput();
    }
  }

  function clearSearch() {
    if (!searchAddon) {
      return;
    }

    searchAddon.clearDecorations();
  }

  function blurSearch() {
    if (!searchAddon || typeof searchAddon.clearActiveDecoration !== "function") {
      return;
    }

    searchAddon.clearActiveDecoration();
  }

  function runSearch(direction) {
    if (!searchAddon || !searchInputNode) {
      return false;
    }

    const query = searchInputNode.value.trim();
    if (!query) {
      clearSearch();
      return false;
    }

    if (direction === "previous") {
      return searchAddon.findPrevious(query, { decorations: SEARCH_DECORATIONS });
    }

    return searchAddon.findNext(query, {
      incremental: true,
      decorations: SEARCH_DECORATIONS,
    });
  }

  function closeSearchOverlay() {
    if (!searchInputNode) {
      return;
    }

    searchInputNode.value = "";
    setSearchOpen(false);
    clearSearch();
    blurSearch();
    term.focus();
  }

  function initializeAddons() {
    try {
      if (window.Unicode11Addon?.Unicode11Addon) {
        term.loadAddon(new window.Unicode11Addon.Unicode11Addon());
        term.unicode.activeVersion = "11";
      }
    } catch (error) {
      safeWarn("Unicode11 addon unavailable, continuing with default unicode width handling.", error);
    }

    try {
      if (window.WebLinksAddon?.WebLinksAddon) {
        term.loadAddon(
          new window.WebLinksAddon.WebLinksAddon((_event, uri) => {
            window.open(uri, "_blank", "noopener,noreferrer");
          })
        );
      }
    } catch (error) {
      safeWarn("WebLinks addon unavailable, continuing without clickable links.", error);
    }

    try {
      if (window.SearchAddon?.SearchAddon) {
        searchAddon = new window.SearchAddon.SearchAddon({ highlightLimit: 500 });
        term.loadAddon(searchAddon);
      }
    } catch (error) {
      searchAddon = null;
      safeWarn("Search addon unavailable, continuing without in-terminal search support.", error);
    }

    try {
      // 인라인 이미지(Sixel + iTerm2 IIP). 라이브 공유는 원시 바이트를 그대로 흘리므로 이
      // 애드온이 없으면 주인 화면에 뜬 이미지가 뷰어에서는 조용히 사라진다. storageLimit 은
      // 데스크톱(terminal-runtime.ts)과 같은 값이어야 같은 이미지가 같게 보인다.
      //
      // Sixel 디코더가 인라인 WASM 을 컴파일하기 때문에 공유 뷰어 CSP 의 script-src 에
      // 'wasm-unsafe-eval' 이 있어야 동작한다(applyShareViewerResponseHeaders 참고).
      if (window.ImageAddon?.ImageAddon) {
        term.loadAddon(new window.ImageAddon.ImageAddon({ storageLimit: 128 }));
      }
    } catch (error) {
      safeWarn("Image addon unavailable, continuing without inline image (sixel/iip) support.", error);
    }
  }

  term.open(terminalNode);
  initializeAddons();

  // 렌더러가 .xterm-screen 크기를 반영하는 시점은 term.resize() 호출 프레임보다 늦을 수 있어서,
  // resize 직후의 scheduleScaleSync() 는 아직 옛 크기를 잴 수 있다. 그리드 픽셀 크기가 실제로
  // 바뀐 프레임에서만 다시 맞춰 그 지연을 자기교정한다 — 값이 안정되면 더 이상 일하지 않는다.
  let lastRenderedGridKey = "";
  term.onRender(() => {
    const renderedGrid = measureRenderedGridPx();
    if (!renderedGrid) {
      return;
    }

    const gridKey = `${renderedGrid.width}x${renderedGrid.height}`;
    if (gridKey === lastRenderedGridKey) {
      return;
    }
    lastRenderedGridKey = gridKey;
    scheduleScaleSync();
  });

  chatNicknameNode.value = resolveInitialChatNickname();
  renderChatMessages();
  setChatStatus(TEXT.chatStatusConnecting);
  setChatEnabled(false);
  setChatCollapsed(true);
  term.attachCustomKeyEventHandler((event) => {
    const signal = resolveAwsShareControlSignal(event);
    if (!signal) {
      return true;
    }

    event.preventDefault();
    event.stopPropagation();
    sendControlSignal(signal);
    return false;
  });
  term.focus();
  setStatus(TEXT.statusConnecting);

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(
    `${protocol}//${window.location.host}/share/${encodeURIComponent(shareId)}/${encodeURIComponent(viewerToken)}/ws`
  );

  terminalNode.addEventListener("mousedown", () => {
    term.focus();
  });

  searchOverlayNode?.addEventListener("mousedown", (event) => {
    event.stopPropagation();
  });

  searchInputNode?.addEventListener("blur", () => {
    blurSearch();
  });

  searchInputNode?.addEventListener("input", (event) => {
    const nextQuery = event.target.value;
    if (!nextQuery.trim()) {
      clearSearch();
      return;
    }

    runSearch("next");
  });

  searchInputNode?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) {
        runSearch("previous");
        return;
      }

      runSearch("next");
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeSearchOverlay();
    }
  });

  searchPrevButtonNode?.addEventListener("click", () => {
    runSearch("previous");
  });

  searchNextButtonNode?.addEventListener("click", () => {
    runSearch("next");
  });

  searchCloseButtonNode?.addEventListener("click", () => {
    closeSearchOverlay();
  });

  chatNicknameNode.addEventListener("blur", () => {
    syncChatNicknameFromInput();
  });

  chatToggleNode.addEventListener("click", () => {
    setChatCollapsed(!chatCollapsed);
  });

  chatOpenNode.addEventListener("click", () => {
    setChatCollapsed(false);
  });

  chatInputNode.addEventListener("compositionstart", () => {
    chatInputComposing = true;
  });

  chatInputNode.addEventListener("compositionend", () => {
    chatInputComposing = false;
  });

  chatInputNode.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }

    if (chatInputComposing || event.isComposing || event.keyCode === 229) {
      return;
    }

    event.preventDefault();
    if (typeof chatFormNode.requestSubmit === "function") {
      chatFormNode.requestSubmit();
      return;
    }

    chatFormNode.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

  chatFormNode.addEventListener("submit", (event) => {
    event.preventDefault();
    if (chatInputComposing) {
      return;
    }
    const nickname = syncChatNicknameFromInput();
    const text = normalizeChatText(chatInputNode.value);
    if (!nickname || !text) {
      chatInputNode.value = text;
      return;
    }
    if (sendChatText(text)) {
      chatInputNode.value = "";
      chatInputNode.focus();
    }
  });

  function handleWindowKeyDown(event) {
    if (shouldOpenTerminalSearch(event) && canUseSearch()) {
      event.preventDefault();
      event.stopPropagation();
      setSearchOpen(true);
      return;
    }

    if (!searchOpen) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeSearchOverlay();
    }
  }

  window.addEventListener("keydown", handleWindowKeyDown, true);

  term.onData((data) => {
    sendUtf8Text(data);
  });

  term.onBinary((data) => {
    sendBinaryInput(data);
  });

  const viewportResizeObserver = new ResizeObserver(() => {
    scheduleScaleSync();
  });
  viewportResizeObserver.observe(viewportNode);
  window.addEventListener("resize", scheduleScaleSync);

  socket.addEventListener("open", () => {
    setChatEnabled(true);
    setChatStatus(TEXT.chatStatusReady);
    syncChatNicknameFromInput();
  });

  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(String(event.data));

    if (payload.type === "init") {
      currentTransport = payload.transport === "aws-ssm" ? "aws-ssm" : "ssh";
      titleNode.textContent = payload.title || payload.hostLabel || TEXT.sharedSession;
      applyViewerLayoutMetadata(payload);
      term.resize(payload.cols || 80, payload.rows || 24);
      setInputEnabled(Boolean(payload.inputEnabled));
      scheduleScaleSync();
      return;
    }

    if (payload.type === "snapshot-init" || payload.type === "snapshot-resync") {
      applyViewerLayoutMetadata(payload);
      // Resize before replaying the owner snapshot so cursor-addressed content
      // and tab stops are restored against the same terminal geometry.
      term.resize(payload.cols || term.cols, payload.rows || term.rows);
      term.reset();
      if (payload.snapshot) {
        term.write(payload.snapshot, () => {
          scheduleScaleSync();
        });
      } else {
        scheduleScaleSync();
      }
      return;
    }

    if (payload.type === "replay") {
      for (const entry of payload.entries || []) {
        term.write(decodeBase64Bytes(entry));
      }
      return;
    }

    if (payload.type === "output") {
      term.write(decodeBase64Bytes(payload.data));
      return;
    }

    if (payload.type === "chat-history") {
      clearChatMessages();
      for (const message of payload.messages || []) {
        appendChatMessage(message);
      }
      return;
    }

    if (payload.type === "chat-message") {
      appendChatMessage(payload.message);
      return;
    }

    if (payload.type === "resize") {
      applyViewerLayoutMetadata(payload);
      term.resize(payload.cols || term.cols, payload.rows || term.rows);
      scheduleScaleSync();
      return;
    }

    if (payload.type === "input-enabled") {
      setInputEnabled(Boolean(payload.inputEnabled));
      return;
    }

    if (payload.type === "viewer-count") {
      const suffix = term.options.disableStdin ? TEXT.statusReadOnly : TEXT.statusInputEnabled;
      const template =
        payload.viewerCount === 1 ? TEXT.viewerCountOneFormat : TEXT.viewerCountManyFormat;
      setStatus(formatCount(template, suffix, payload.viewerCount));
      return;
    }

    if (payload.type === "share-ended") {
      term.options.disableStdin = true;
      clearChatMessages();
      setChatEnabled(false);
      setChatStatus(TEXT.chatStatusEnded);
      setStatus(TEXT.statusEnded);
      // 종료 안내는 여러 언어의 시청자에게 한 번에 브로드캐스트되므로 서버가 문장을 정할
      // 수 없다. 이유 코드를 알면 이 페이지 언어로 만들고, 모르는 코드면 서버 문장을 쓴다.
      const endedNotice =
        payload.reason === "ended" ? TEXT.shareEnded : payload.message;
      if (endedNotice) {
        term.writeln("");
        term.writeln(endedNotice);
      }
    }
  });

  socket.addEventListener("close", () => {
    term.options.disableStdin = true;
    clearChatMessages();
    setChatEnabled(false);
    setChatStatus(TEXT.chatStatusEnded);
    setStatus(TEXT.statusEnded);
    viewportResizeObserver.disconnect();
    window.removeEventListener("resize", scheduleScaleSync);
    window.removeEventListener("keydown", handleWindowKeyDown, true);
  });
})();
