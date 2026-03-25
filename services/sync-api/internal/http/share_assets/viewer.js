(function () {
  const body = document.body;
  const shareId = body.dataset.shareId;
  const viewerToken = body.dataset.viewerToken;
  const titleNode = document.getElementById("viewer-title");
  const statusNode = document.getElementById("viewer-status");
  const viewportNode = document.getElementById("viewer-terminal-viewport");
  const stageNode = document.getElementById("viewer-terminal-stage");
  const terminalNode = document.getElementById("viewer-terminal");
  const textEncoder = new TextEncoder();
  const DEFAULT_FALLBACK_SCALE = 0.85;
  const VIEWPORT_SAFE_GUTTER_PX = 6;

  if (!shareId || !viewerToken || !window.Terminal || !viewportNode || !stageNode || !terminalNode) {
    return;
  }

  const term = new window.Terminal({
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

  function sendUtf8Text(text) {
    if (!text) {
      return;
    }

    sendBinaryMessage(encodeBytesBase64(textEncoder.encode(text)));
  }

  function mapKeyDownToTerminalInput(event) {
    if (event.isComposing || isComposing || event.key === "Process" || event.key === "Dead") {
      return null;
    }

    if (event.ctrlKey && !event.altKey && !event.metaKey) {
      const key = event.key;
      if (key.length === 1) {
        const upperKey = key.toUpperCase();
        if (upperKey >= "A" && upperKey <= "Z") {
          return String.fromCharCode(upperKey.charCodeAt(0) - 64);
        }
      }

      switch (key) {
        case " ":
        case "@":
        case "2":
          return "\u0000";
        case "[":
          return "\u001b";
        case "\\":
          return "\u001c";
        case "]":
          return "\u001d";
        case "^":
        case "6":
          return "\u001e";
        case "_":
        case "/":
          return "\u001f";
        case "?":
        case "7":
          return "\u007f";
        case "Backspace":
          return "\u0008";
        default:
          return null;
      }
    }

    if (event.metaKey) {
      return null;
    }

    switch (event.key) {
      case "Enter":
        return "\r";
      case "Backspace":
        return "\u007f";
      case "Tab":
        return event.shiftKey ? "\u001b[Z" : "\t";
      case "Escape":
        return "\u001b";
      case "ArrowUp":
        return "\u001b[A";
      case "ArrowDown":
        return "\u001b[B";
      case "ArrowRight":
        return "\u001b[C";
      case "ArrowLeft":
        return "\u001b[D";
      case "Home":
        return "\u001b[H";
      case "End":
        return "\u001b[F";
      case "Delete":
        return "\u001b[3~";
      case "PageUp":
        return "\u001b[5~";
      case "PageDown":
        return "\u001b[6~";
      default:
        break;
    }

    if (event.altKey && event.key.length === 1) {
      return `\u001b${event.key}`;
    }

    if (!event.ctrlKey && !event.altKey && event.key.length === 1) {
      return event.key;
    }

    return null;
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
  let scaleFrameHandle = 0;

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
    const scale = Math.min(widthScale, heightScale, 1);
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

  term.open(terminalNode);
  term.focus();
  setStatus("Connecting");

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(
    `${protocol}//${window.location.host}/share/${encodeURIComponent(shareId)}/${encodeURIComponent(viewerToken)}/ws`
  );

  let isComposing = false;

  terminalNode.addEventListener("mousedown", () => {
    term.focus();
  });

  if (term.textarea) {
    term.textarea.addEventListener("keydown", (event) => {
      if (term.options.disableStdin) {
        return;
      }

      const payload = mapKeyDownToTerminalInput(event);
      if (payload == null) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      sendUtf8Text(payload);
      term.textarea.value = "";
    }, true);

    term.textarea.addEventListener("compositionstart", (event) => {
      isComposing = true;
      event.stopImmediatePropagation();
    }, true);

    term.textarea.addEventListener("compositionend", (event) => {
      isComposing = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.data) {
        sendUtf8Text(event.data);
      }
      term.textarea.value = "";
    }, true);

    term.textarea.addEventListener("paste", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const pastedText = event.clipboardData?.getData("text/plain");
      if (pastedText) {
        sendUtf8Text(pastedText);
      }
      term.textarea.value = "";
    }, true);
  }

  const viewportResizeObserver = new ResizeObserver(() => {
    scheduleScaleSync();
  });
  viewportResizeObserver.observe(viewportNode);
  window.addEventListener("resize", scheduleScaleSync);

  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(String(event.data));

    if (payload.type === "init") {
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
  });
})();
