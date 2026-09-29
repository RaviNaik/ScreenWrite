// Entry point / lifecycle owner: builds and tears down the overlay DOM,
// wires pointer input into the drawing engine, tracks viewport resize/zoom,
// and handles messages from the background worker. Loaded last by the
// injection file list, after canvas-engine.js, toolbar.js and shortcuts.js
// have each registered their factory on window.__OSW__.
(function () {
  if (window.__OSW__?.controllerLoaded) return; // already running in this tab

  const { TOOLS, MESSAGE_TYPES } = self.OSW_CONSTANTS;

  const STORAGE_KEY = "oswPrefs";

  let state = "hidden";
  let engine = null;
  let toolbar = null;
  let shortcuts = null;
  let root = null;
  let backdrop = null;
  let canvas = null;
  let toolbarHost = null;
  let activeTextEditor = null;
  let cancelActiveTextEdit = () => {};
  const cleanupFns = [];

  function loadPrefs() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([STORAGE_KEY], (result) => resolve(result?.[STORAGE_KEY] || {}));
      } catch (_e) {
        resolve({});
      }
    });
  }

  function savePrefsDebounced() {
    clearTimeout(savePrefsDebounced._t);
    savePrefsDebounced._t = setTimeout(() => {
      try {
        chrome.storage.local.set({
          [STORAGE_KEY]: {
            color: engine.currentColor,
            width: engine.currentWidth,
            background: engine.backgroundMode,
          },
        });
      } catch (_e) {
        // Storage can be unavailable in rare contexts; preferences are a
        // nice-to-have, never required for the tool to work.
      }
    }, 400);
  }

  function openTextEditor(x, y) {
    if (activeTextEditor) return; // one note at a time
    const ta = document.createElement("textarea");
    const fontSize = 14 + engine.currentWidth;
    Object.assign(ta.style, {
      position: "fixed",
      left: x + "px",
      top: y + "px",
      minWidth: "160px",
      minHeight: fontSize * 1.6 + "px",
      font: `${fontSize}px system-ui, -apple-system, Segoe UI, sans-serif`,
      color: engine.currentColor,
      background: "rgba(255,255,255,0.92)",
      border: `1px dashed ${engine.currentColor}`,
      borderRadius: "4px",
      padding: "3px 5px",
      zIndex: "2147483647",
      resize: "both",
      pointerEvents: "auto",
      outline: "none",
    });
    ta.spellcheck = false;
    root.appendChild(ta);
    activeTextEditor = ta;
    ta.focus();

    function commit() {
      if (activeTextEditor !== ta) return;
      ta.removeEventListener("blur", commit);
      activeTextEditor = null;
      const text = ta.value;
      const color = engine.currentColor;
      const width = engine.currentWidth;
      ta.remove();
      engine.commitText(x, y, text, color, width);
    }

    function cancel() {
      if (activeTextEditor !== ta) return;
      ta.removeEventListener("blur", commit);
      activeTextEditor = null;
      ta.remove();
    }

    ta.addEventListener("blur", commit);
    cancelActiveTextEdit = cancel;
  }

  function clientPointFromEvent(e) {
    return { x: e.clientX, y: e.clientY };
  }

  function wirePointerEvents() {
    function onDown(e) {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      // The canvas itself isn't focusable, so without this the browser's
      // default mousedown action blurs whatever currently has focus right
      // after this handler runs — including a text-tool <textarea> we just
      // created and focused in engine.pointerDown() below, which would
      // instantly commit-and-remove it before anything could be typed.
      e.preventDefault();
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch (_e) {
        /* ignore */
      }
      const p = clientPointFromEvent(e);
      engine.pointerDown(p.x, p.y);
    }
    function onMove(e) {
      const p = clientPointFromEvent(e);
      engine.pointerMove(p.x, p.y);
    }
    function onUp(e) {
      const p = clientPointFromEvent(e);
      engine.pointerUp(p.x, p.y);
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch (_e) {
        /* ignore */
      }
    }
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    cleanupFns.push(() => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
    });
  }

  function wireResizeTracking() {
    let scheduled = false;
    function scheduleResize() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        engine.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
      });
    }

    window.addEventListener("resize", scheduleResize);
    cleanupFns.push(() => window.removeEventListener("resize", scheduleResize));

    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", scheduleResize);
      window.visualViewport.addEventListener("scroll", scheduleResize);
      cleanupFns.push(() => {
        window.visualViewport.removeEventListener("resize", scheduleResize);
        window.visualViewport.removeEventListener("scroll", scheduleResize);
      });
    }

    // There's no native "devicePixelRatio changed" event; a matchMedia query
    // tuned to the current ratio fires a `change` event the moment it stops
    // matching (e.g. dragging the window to a monitor with different scale).
    let mql = null;
    function onDprChange() {
      scheduleResize();
      armDprWatch();
    }
    function armDprWatch() {
      if (mql) mql.removeEventListener("change", onDprChange);
      mql = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      mql.addEventListener("change", onDprChange, { once: true });
    }
    armDprWatch();
    cleanupFns.push(() => mql && mql.removeEventListener("change", onDprChange));
  }

  async function mount() {
    if (document.getElementById("osw-root")) return; // already mounted, idempotent

    root = document.createElement("div");
    root.id = "osw-root";
    Object.assign(root.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      pointerEvents: "none",
    });

    backdrop = document.createElement("div");
    backdrop.id = "osw-backdrop";
    Object.assign(backdrop.style, {
      position: "absolute",
      inset: "0",
      background: self.OSW_CONSTANTS.DARK_BACKDROP_COLOR,
      display: "none",
      pointerEvents: "none",
    });
    root.appendChild(backdrop);

    canvas = document.createElement("canvas");
    canvas.id = "osw-canvas";
    Object.assign(canvas.style, {
      position: "absolute",
      inset: "0",
      width: "100vw",
      height: "100vh",
      pointerEvents: "none",
      touchAction: "none",
    });
    root.appendChild(canvas);

    document.documentElement.appendChild(root);

    toolbarHost = document.createElement("div");
    toolbarHost.id = "osw-toolbar-host";
    Object.assign(toolbarHost.style, {
      position: "fixed",
      top: "16px",
      right: "16px",
    });
    document.documentElement.appendChild(toolbarHost);
    state = "visible"; // set synchronously so a rapid re-toggle during the
    // awaited prefs load below correctly tears down instead of no-oping

    engine = window.__OSW__.createEngine(canvas);
    engine.onTextRequest = openTextEditor;

    toolbar = window.__OSW__.createToolbar({ hostElement: toolbarHost, engine });
    shortcuts = window.__OSW__.createShortcuts({
      engine,
      getActiveTextEditor: () => activeTextEditor,
      cancelTextEdit: () => cancelActiveTextEdit(),
    });

    function syncCanvasChrome() {
      const dark = engine.backgroundMode === "dark";
      backdrop.style.display = dark ? "block" : "none";
      backdrop.style.pointerEvents = dark ? "auto" : "none";
      canvas.style.cursor = !engine.currentTool ? "" : engine.currentTool === TOOLS.ERASER ? "cell" : "crosshair";
      savePrefsDebounced();
    }
    engine.addListener(syncCanvasChrome);

    wirePointerEvents();
    wireResizeTracking();
    engine.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
    syncCanvasChrome();

    // Restore last-used color/width/background (never the active tool —
    // the overlay always starts pass-through so it's never surprising).
    const mountedEngine = engine;
    const prefs = await loadPrefs();
    if (engine !== mountedEngine) return; // torn down again before prefs loaded
    if (prefs.color) engine.setColor(prefs.color);
    if (prefs.width) engine.setWidth(prefs.width);
    if (prefs.background) engine.setBackgroundMode(prefs.background);
  }

  function teardown() {
    if (state !== "visible") return;
    cancelActiveTextEdit();
    shortcuts?.destroy();
    toolbar?.destroy();
    cleanupFns.forEach((fn) => fn());
    cleanupFns.length = 0;
    root?.remove();
    toolbarHost?.remove();
    root = backdrop = canvas = toolbarHost = null;
    engine = null;
    toolbar = null;
    shortcuts = null;
    state = "hidden";
  }

  function toggle() {
    if (state === "hidden") mount();
    else teardown();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return false;
    switch (message.type) {
      case MESSAGE_TYPES.PING:
        sendResponse({ ok: true });
        return false;
      case MESSAGE_TYPES.TOGGLE:
        toggle();
        sendResponse({ ok: true });
        return false;
      case MESSAGE_TYPES.CLEAR:
        engine?.clearAll();
        sendResponse({ ok: true });
        return false;
      default:
        return false;
    }
  });

  window.__OSW__ = window.__OSW__ || {};
  window.__OSW__.controllerLoaded = true;
  window.__OSW__.toggle = toggle;
  window.__OSW__.mount = mount;
  window.__OSW__.teardown = teardown;
})();
