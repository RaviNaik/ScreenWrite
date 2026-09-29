// In-page keyboard shortcuts. Only meaningful while the overlay is mounted;
// overlay-controller.js attaches/detaches this on mount/teardown. Careful to
// never steal keystrokes from the host page's own inputs, and to only allow
// modifier combos (not bare letters) while the extension's own text-tool
// box is focused, so typing a note doesn't accidentally switch tools.
(function () {
  if (window.__OSW__?.moduleLoaded?.shortcuts) return;

  const { TOOLS, MIN_WIDTH, MAX_WIDTH } = self.OSW_CONSTANTS;

  const TOOL_KEY_MAP = {
    p: TOOLS.PEN,
    h: TOOLS.HIGHLIGHTER,
    u: TOOLS.UNDERLINE,
    e: TOOLS.ERASER,
    r: TOOLS.RECT,
    o: TOOLS.ELLIPSE,
    l: TOOLS.LINE,
    a: TOOLS.ARROW,
    t: TOOLS.TEXT,
  };

  function isEditableElement(el) {
    if (!el) return false;
    const tag = el.tagName;
    return el.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  /**
   * @param {object} opts
   * @param {object} opts.engine - the canvas engine instance
   * @param {() => HTMLElement|null} opts.getActiveTextEditor - returns the
   *   in-progress text-tool <textarea>, if one is currently open
   * @param {() => void} opts.cancelTextEdit - discards the in-progress edit
   */
  function createShortcuts({ engine, getActiveTextEditor, cancelTextEdit }) {
    function handleKeydown(event) {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
      const trueTarget = path[0] || event.target;
      const withinOwnUi = path.some((node) => node && (node.id === "osw-root" || node.id === "osw-toolbar-host"));
      const ownTextEditorFocused = withinOwnUi && trueTarget && trueTarget.tagName === "TEXTAREA";
      const hostPageEditable = !withinOwnUi && isEditableElement(trueTarget);
      const ctrlOrCmd = event.ctrlKey || event.metaKey;

      // Typing into a page's own input/textarea/select/contentEditable:
      // only Escape gets through, everything else is the page's business.
      if (hostPageEditable) {
        if (event.key === "Escape" && engine.currentTool) {
          engine.setActiveTool(null);
          event.preventDefault();
        }
        return;
      }

      if (event.key === "Escape") {
        if (getActiveTextEditor?.()) {
          cancelTextEdit?.();
          event.preventDefault();
          return;
        }
        if (engine.currentTool) {
          engine.setActiveTool(null);
          event.preventDefault();
        }
        return;
      }

      // Undo / redo / export: safe modifier combos. Allowed even while our
      // own text-tool box is focused (Ctrl+Z there reads as "undo my typing"
      // to the browser anyway, harmlessly; we still handle it ourselves so
      // behavior is consistent whether or not text is mid-edit).
      if (ctrlOrCmd) {
        const key = event.key.toLowerCase();
        if (key === "z" && event.shiftKey) {
          engine.redo();
          event.preventDefault();
        } else if (key === "z") {
          engine.undo();
          event.preventDefault();
        } else if (key === "y") {
          engine.redo();
          event.preventDefault();
        } else if (key === "s") {
          engine.exportPNG();
          event.preventDefault();
        }
        return;
      }

      // Everything below is a bare, unmodified key — never fire these while
      // the user is actively typing a note into the text tool.
      if (ownTextEditorFocused) return;
      if (event.altKey) return;

      const lower = event.key.length === 1 ? event.key.toLowerCase() : event.key;

      if (TOOL_KEY_MAP[lower]) {
        const tool = TOOL_KEY_MAP[lower];
        engine.setActiveTool(engine.currentTool === tool ? null : tool);
        event.preventDefault();
        return;
      }

      if (event.key === "[") {
        engine.setWidth(Math.max(MIN_WIDTH, engine.currentWidth - 1));
        event.preventDefault();
      } else if (event.key === "]") {
        engine.setWidth(Math.min(MAX_WIDTH, engine.currentWidth + 1));
        event.preventDefault();
      } else if (lower === "b") {
        engine.setBackgroundMode(engine.backgroundMode === "dark" ? "transparent" : "dark");
        event.preventDefault();
      }
    }

    window.addEventListener("keydown", handleKeydown, true);

    return {
      destroy() {
        window.removeEventListener("keydown", handleKeydown, true);
      },
    };
  }

  window.__OSW__ = window.__OSW__ || {};
  window.__OSW__.moduleLoaded = window.__OSW__.moduleLoaded || {};
  window.__OSW__.moduleLoaded.shortcuts = true;
  window.__OSW__.createShortcuts = createShortcuts;
})();
