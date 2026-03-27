(function () {
  const body = document.body;
  const shareId = body.dataset.shareId;
  const viewerToken = body.dataset.viewerToken;
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
  const CHAT_EMPTY_MESSAGE = "아직 채팅이 없습니다. 첫 메시지를 보내보세요.";
  const CHAT_COLLAPSED_LABEL = "채팅 열기";
  const CHAT_EXPANDED_LABEL = "채팅 접기";
  const KOREAN_CHAT_ADJECTIVES = [
    "맑은",
    "반짝이는",
    "든든한",
    "재빠른",
    "부드러운",
    "고요한",
    "용감한",
    "기분좋은",
  ];
  const KOREAN_CHAT_NOUNS = [
    "여우",
    "고래",
    "다람쥐",
    "호랑이",
    "참새",
    "고양이",
    "해달",
    "별빛",
  ];
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
    chatOpenNode.textContent = CHAT_COLLAPSED_LABEL;
    chatOpenNode.setAttribute("aria-expanded", chatCollapsed ? "false" : "true");
    chatToggleNode.textContent = CHAT_EXPANDED_LABEL;
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
    setStatus(inputEnabled ? "Input enabled" : "Read only");
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

  function randomKoreanNickname() {
    const adjective =
      KOREAN_CHAT_ADJECTIVES[Math.floor(Math.random() * KOREAN_CHAT_ADJECTIVES.length)] || "맑은";
    const noun = KOREAN_CHAT_NOUNS[Math.floor(Math.random() * KOREAN_CHAT_NOUNS.length)] || "여우";
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
    const generated = randomKoreanNickname();
    storeChatNickname(generated);
    return generated;
  }

  function formatChatTimestamp(sentAt) {
    const date = new Date(sentAt);
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    return date.toLocaleTimeString("ko-KR", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function renderChatMessages() {
    chatMessagesNode.replaceChildren();

    if (chatMessages.length === 0) {
      const emptyNode = document.createElement("div");
      emptyNode.className = "viewer-chat-empty";
      emptyNode.textContent = CHAT_EMPTY_MESSAGE;
      chatMessagesNode.appendChild(emptyNode);
      return;
    }

    for (const message of chatMessages) {
      const item = document.createElement("article");
      item.className = "viewer-chat-message";

      const meta = document.createElement("div");
      meta.className = "viewer-chat-message__meta";

      const nickname = document.createElement("strong");
      nickname.textContent = message.nickname || "알 수 없음";
      meta.appendChild(nickname);

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

    setStageDimensions(baseViewport.width, baseViewport.height);

    const safeWidth = Math.max(0, availableWidth - VIEWPORT_SAFE_GUTTER_PX);
    const safeHeight = Math.max(0, availableHeight - VIEWPORT_SAFE_GUTTER_PX);
    const widthScale = safeWidth / baseViewport.width;
    const heightScale = safeHeight / baseViewport.height;
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
  }

  term.open(terminalNode);
  initializeAddons();
  chatNicknameNode.value = resolveInitialChatNickname();
  renderChatMessages();
  setChatStatus("연결 중");
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
  setStatus("Connecting");

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
    setChatStatus("대화 가능");
    syncChatNicknameFromInput();
  });

  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(String(event.data));

    if (payload.type === "init") {
      currentTransport = payload.transport === "aws-ssm" ? "aws-ssm" : "ssh";
      titleNode.textContent = payload.title || payload.hostLabel || "Shared Session";
      applyViewerLayoutMetadata(payload);
      term.resize(payload.cols || 80, payload.rows || 24);
      setInputEnabled(Boolean(payload.inputEnabled));
      scheduleScaleSync();
      return;
    }

    if (payload.type === "snapshot-init" || payload.type === "snapshot-resync") {
      applyViewerLayoutMetadata(payload);
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
      const suffix = term.options.disableStdin ? "Read only" : "Input enabled";
      setStatus(`${suffix} · ${payload.viewerCount} viewer${payload.viewerCount === 1 ? "" : "s"}`);
      return;
    }

    if (payload.type === "share-ended") {
      term.options.disableStdin = true;
      clearChatMessages();
      setChatEnabled(false);
      setChatStatus("종료됨");
      setStatus("Ended");
      if (payload.message) {
        term.writeln("");
        term.writeln(payload.message);
      }
    }
  });

  socket.addEventListener("close", () => {
    term.options.disableStdin = true;
    clearChatMessages();
    setChatEnabled(false);
    setChatStatus("종료됨");
    setStatus("Ended");
    viewportResizeObserver.disconnect();
    window.removeEventListener("resize", scheduleScaleSync);
    window.removeEventListener("keydown", handleWindowKeyDown, true);
  });
})();
