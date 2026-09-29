// Small floating, draggable, collapsible toolbar rendered inside an open
// Shadow DOM so its styles can never leak into (or be clobbered by) the
// host page. Talks to the drawing engine directly; overlay-controller.js
// owns background-mode DOM (the backdrop div) and reacts to engine changes
// on its own listener.
(function () {
  if (window.__OSW__?.moduleLoaded?.toolbar) return;

  const { TOOLS, DEFAULT_COLORS, MIN_WIDTH, MAX_WIDTH } = self.OSW_CONSTANTS;

  const TOOL_BUTTONS = [
    { tool: TOOLS.PEN, label: "P", title: "Pen (P)" },
    { tool: TOOLS.HIGHLIGHTER, label: "H", title: "Highlighter (H)" },
    { tool: TOOLS.UNDERLINE, label: "U", title: "Underline (U)" },
    { tool: TOOLS.ERASER, label: "E", title: "Eraser (E)" },
    { tool: TOOLS.RECT, label: "R", title: "Rectangle (R)" },
    { tool: TOOLS.ELLIPSE, label: "O", title: "Ellipse (O)" },
    { tool: TOOLS.LINE, label: "L", title: "Line (L)" },
    { tool: TOOLS.ARROW, label: "A", title: "Arrow (A)" },
    { tool: TOOLS.TEXT, label: "T", title: "Text (T)" },
  ];

  const CSS = `
    :host { all: initial; position: fixed; display: block; z-index: 2147483647; pointer-events: auto; }
    * { box-sizing: border-box; }
    .osw-toolbar {
      font: 12px/1.3 -apple-system, "Segoe UI", system-ui, sans-serif;
      background: #24242bee;
      color: #f2f2f5;
      border: 1px solid #3d3d47;
      border-radius: 12px;
      box-shadow: 0 6px 24px rgba(0,0,0,0.35);
      padding: 6px;
      backdrop-filter: blur(6px);
      user-select: none;
      width: max-content;
      max-width: min(94vw, 420px);
    }
    .osw-row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
    .osw-row + .osw-row { margin-top: 5px; padding-top: 5px; border-top: 1px solid #3a3a44; }
    .osw-grip {
      width: 16px; height: 24px; margin-right: 2px; border-radius: 5px;
      cursor: grab; flex: 0 0 auto;
      background-image: radial-gradient(circle, #8a8a99 1px, transparent 1.4px);
      background-size: 4px 4px;
      background-position: center;
    }
    .osw-grip:active { cursor: grabbing; }
    button.osw-btn {
      appearance: none; border: 1px solid transparent; border-radius: 7px;
      background: #34343d; color: #f2f2f5; width: 26px; height: 26px;
      font-size: 12px; font-weight: 600; line-height: 1; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      flex: 0 0 auto; padding: 0;
    }
    button.osw-btn:hover { background: #40404b; }
    button.osw-btn[aria-pressed="true"] { background: #5b6cff; color: #fff; border-color: #7c8aff; }
    button.osw-btn.osw-wide { width: auto; padding: 0 8px; font-weight: 500; }
    .osw-divider { width: 1px; align-self: stretch; background: #3a3a44; margin: 0 2px; }
    .osw-swatch {
      width: 20px; height: 20px; border-radius: 50%; border: 2px solid transparent;
      cursor: pointer; flex: 0 0 auto; padding: 0;
    }
    .osw-swatch[aria-pressed="true"] { border-color: #fff; box-shadow: 0 0 0 1px #5b6cff; }
    input[type="color"] {
      width: 22px; height: 22px; padding: 0; border: none; border-radius: 50%;
      background: none; cursor: pointer; flex: 0 0 auto;
    }
    input[type="color"]::-webkit-color-swatch-wrapper { padding: 0; border-radius: 50%; }
    input[type="color"]::-webkit-color-swatch { border: 2px solid #f2f2f5; border-radius: 50%; }
    input[type="range"] { width: 70px; flex: 0 0 auto; accent-color: #5b6cff; }
    .osw-width-label { width: 20px; text-align: center; opacity: 0.85; flex: 0 0 auto; }
    .osw-collapsed-btn {
      display: none; width: 36px; height: 36px; border-radius: 50%; border: 1px solid #3d3d47;
      background: #5b6cff; color: #fff; font-size: 15px; font-weight: 700; cursor: pointer;
      align-items: center; justify-content: center; box-shadow: 0 6px 20px rgba(0,0,0,0.4);
    }
    .osw-toolbar.osw-collapsed .osw-row { display: none; }
    .osw-toolbar.osw-collapsed { padding: 0; background: none; border: none; box-shadow: none; backdrop-filter: none; }
    .osw-toolbar.osw-collapsed .osw-collapsed-btn { display: flex; }
  `;

  function createToolbar({ hostElement, engine }) {
    const shadow = hostElement.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    shadow.appendChild(style);

    const wrapper = document.createElement("div");
    wrapper.className = "osw-toolbar";
    shadow.appendChild(wrapper);

    const collapsedBtn = document.createElement("button");
    collapsedBtn.className = "osw-collapsed-btn";
    collapsedBtn.type = "button";
    collapsedBtn.title = "Expand On-Screen Writer toolbar";
    collapsedBtn.textContent = "✎"; // pencil glyph
    wrapper.appendChild(collapsedBtn);

    // --- Row 1: drag handle, tools, undo/redo, collapse -------------------
    const row1 = document.createElement("div");
    row1.className = "osw-row";
    wrapper.appendChild(row1);

    const grip = document.createElement("div");
    grip.className = "osw-grip";
    grip.title = "Drag to move";
    row1.appendChild(grip);

    const toolButtons = {};
    TOOL_BUTTONS.forEach(({ tool, label, title }) => {
      const btn = document.createElement("button");
      btn.className = "osw-btn";
      btn.type = "button";
      btn.textContent = label;
      btn.title = title;
      btn.setAttribute("aria-pressed", "false");
      btn.addEventListener("click", () => {
        const next = engine.currentTool === tool ? null : tool;
        engine.setActiveTool(next);
      });
      toolButtons[tool] = btn;
      row1.appendChild(btn);
    });

    row1.appendChild(divider());

    const undoBtn = iconButton("↺", "Undo (Ctrl+Z)", () => engine.undo());
    const redoBtn = iconButton("↻", "Redo (Ctrl+Shift+Z)", () => engine.redo());
    row1.appendChild(undoBtn);
    row1.appendChild(redoBtn);

    row1.appendChild(divider());

    const collapseBtn = iconButton("–", "Minimize toolbar", () => setCollapsed(true));
    row1.appendChild(collapseBtn);

    // --- Row 2: colors, width, background, clear, export ------------------
    const row2 = document.createElement("div");
    row2.className = "osw-row";
    wrapper.appendChild(row2);

    const swatchButtons = [];
    DEFAULT_COLORS.forEach((color) => {
      const sw = document.createElement("button");
      sw.className = "osw-swatch";
      sw.type = "button";
      sw.style.background = color;
      sw.title = color;
      sw.dataset.color = color;
      sw.setAttribute("aria-pressed", String(color === engine.currentColor));
      sw.addEventListener("click", () => engine.setColor(color));
      swatchButtons.push(sw);
      row2.appendChild(sw);
    });

    const customColor = document.createElement("input");
    customColor.type = "color";
    customColor.title = "Custom color";
    customColor.value = engine.currentColor;
    customColor.addEventListener("input", () => engine.setColor(customColor.value));
    row2.appendChild(customColor);

    row2.appendChild(divider());

    const widthSlider = document.createElement("input");
    widthSlider.type = "range";
    widthSlider.min = String(MIN_WIDTH);
    widthSlider.max = String(MAX_WIDTH);
    widthSlider.value = String(engine.currentWidth);
    widthSlider.title = "Stroke / eraser size ([ and ])";
    widthSlider.addEventListener("input", () => engine.setWidth(Number(widthSlider.value)));
    const widthLabel = document.createElement("span");
    widthLabel.className = "osw-width-label";
    widthLabel.textContent = String(engine.currentWidth);
    row2.appendChild(widthSlider);
    row2.appendChild(widthLabel);

    row2.appendChild(divider());

    const bgBtn = iconButton("☀", "Toggle background (B)", () => {
      engine.setBackgroundMode(engine.backgroundMode === "dark" ? "transparent" : "dark");
    });
    row2.appendChild(bgBtn);

    const clearBtn = iconButton("✕", "Clear all (Ctrl+Shift+X)", () => engine.clearAll());
    row2.appendChild(clearBtn);

    const exportBtn = iconButton("⬇", "Export as PNG (Ctrl+S)", () => engine.exportPNG());
    row2.appendChild(exportBtn);

    // --- helpers ------------------------------------------------------------
    function divider() {
      const d = document.createElement("div");
      d.className = "osw-divider";
      return d;
    }

    function iconButton(glyph, title, onClick) {
      const btn = document.createElement("button");
      btn.className = "osw-btn";
      btn.type = "button";
      btn.textContent = glyph;
      btn.title = title;
      btn.addEventListener("click", onClick);
      return btn;
    }

    function setCollapsed(collapsed) {
      wrapper.classList.toggle("osw-collapsed", collapsed);
      if (collapsed && engine.currentTool) engine.setActiveTool(null);
    }
    collapsedBtn.addEventListener("click", () => setCollapsed(false));

    function sync() {
      Object.entries(toolButtons).forEach(([tool, btn]) => {
        btn.setAttribute("aria-pressed", String(engine.currentTool === tool));
      });
      swatchButtons.forEach((sw) => {
        sw.setAttribute("aria-pressed", String(sw.dataset.color === engine.currentColor));
      });
      widthSlider.value = String(engine.currentWidth);
      widthLabel.textContent = String(engine.currentWidth);
      bgBtn.textContent = engine.backgroundMode === "dark" ? "☽" : "☀";
      bgBtn.title = engine.backgroundMode === "dark" ? "Switch to transparent background (B)" : "Switch to dark background (B)";
    }

    engine.addListener(sync);
    sync();

    // --- dragging -------------------------------------------------------
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const rect = hostElement.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const startLeft = rect.left;
      const startTop = rect.top;
      grip.setPointerCapture(e.pointerId);

      function onMove(ev) {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        const maxLeft = Math.max(4, window.innerWidth - rect.width - 4);
        const maxTop = Math.max(4, window.innerHeight - rect.height - 4);
        const left = Math.min(Math.max(4, startLeft + dx), maxLeft);
        const top = Math.min(Math.max(4, startTop + dy), maxTop);
        hostElement.style.left = left + "px";
        hostElement.style.top = top + "px";
        hostElement.style.right = "auto";
      }
      function onUp(ev) {
        grip.releasePointerCapture(ev.pointerId);
        grip.removeEventListener("pointermove", onMove);
        grip.removeEventListener("pointerup", onUp);
      }
      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp);
    });

    return {
      destroy() {
        // hostElement itself is removed by overlay-controller; nothing else
        // holds references outside this shadow tree (no window-level
        // listeners were added), so there is nothing extra to clean up here.
      },
    };
  }

  window.__OSW__ = window.__OSW__ || {};
  window.__OSW__.moduleLoaded = window.__OSW__.moduleLoaded || {};
  window.__OSW__.moduleLoaded.toolbar = true;
  window.__OSW__.createToolbar = createToolbar;
})();
