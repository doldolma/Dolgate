(function () {
  const body = document.body;
  const shareId = body.dataset.shareId;
  const viewerToken = body.dataset.viewerToken;
  const titleNode = document.getElementById("viewer-title");
  const statusNode = document.getElementById("viewer-status");
  const viewportNode = document.getElementById("viewer-terminal-viewport");
  const stageNode = document.getElementById("viewer-terminal-stage");
  const terminalNode = document.getElementById("viewer-terminal");
  const searchOverlayNode = document.getElementById("viewer-search-overlay");
  const searchInputNode = document.getElementById("viewer-search-input");
  const searchPrevButtonNode = document.getElementById("viewer-search-prev");
  const searchNextButtonNode = document.getElementById("viewer-search-next");
  const searchCloseButtonNode = document.getElementById("viewer-search-close");
  const textEncoder = new TextEncoder();
  const DEFAULT_FALLBACK_SCALE = 0.85;
  const VIEWPORT_SAFE_GUTTER_PX = 24;
  const VIEWPORT_SAFE_SCALE_FACTOR = 0.98;
  const SEARCH_DECORATIONS = {
    matchBackground: "#243451",
    matchBorder: "#42567f",
    matchOverviewRuler: "#42567f",
    activeMatchBackground: "#4663de",
    activeMatchBorder: "#9fb3ff",
    activeMatchColorOverviewRuler: "#9fb3ff",
  };

  if (!shareId || !viewerToken || !window.Terminal || !viewportNode || !stageNode || !terminalNode) {
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
      setStatus("Ended");
      if (payload.message) {
        term.writeln("");
        term.writeln(payload.message);
      }
    }
  });

  socket.addEventListener("close", () => {
    term.options.disableStdin = true;
    setStatus("Ended");
    viewportResizeObserver.disconnect();
    window.removeEventListener("resize", scheduleScaleSync);
    window.removeEventListener("keydown", handleWindowKeyDown, true);
  });
})();
