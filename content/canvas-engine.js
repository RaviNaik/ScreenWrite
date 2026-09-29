// Vector drawing engine: owns the object list, undo/redo, hit-testing
// eraser, render loop, and PNG export. Nothing here touches the DOM outside
// the <canvas> element it's given — overlay-controller.js wires pointer
// events into it and toolbar.js drives its tool/color/width setters.
(function () {
  if (window.__OSW__?.moduleLoaded?.canvasEngine) return;

  const { TOOLS, DEFAULTS, DARK_BACKDROP_COLOR } = self.OSW_CONSTANTS;

  const FREEHAND_TOOLS = new Set([TOOLS.PEN, TOOLS.HIGHLIGHTER, TOOLS.UNDERLINE]);
  const SHAPE_TOOL_TYPE = {
    [TOOLS.RECT]: "rect",
    [TOOLS.ELLIPSE]: "ellipse",
    [TOOLS.LINE]: "line",
    [TOOLS.ARROW]: "arrow",
  };
  const STROKE_TOOL_TYPE = {
    [TOOLS.PEN]: "stroke",
    [TOOLS.HIGHLIGHTER]: "highlight",
    [TOOLS.UNDERLINE]: "underline",
  };

  function makeId() {
    if (self.crypto?.randomUUID) return self.crypto.randomUUID();
    return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function normalizeRect(a, b) {
    return {
      x1: Math.min(a.x, b.x),
      y1: Math.min(a.y, b.y),
      x2: Math.max(a.x, b.x),
      y2: Math.max(a.y, b.y),
    };
  }

  /** Shortest distance from point p to segment a-b. */
  function pointToSegmentDistance(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return dist(p, a);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
  }

  /** Distance from a point to the outline of an axis-aligned rect. */
  function distanceToRectOutline(p, x1, y1, x2, y2) {
    const dx = Math.max(x1 - p.x, 0, p.x - x2);
    const dy = Math.max(y1 - p.y, 0, p.y - y2);
    if (dx === 0 && dy === 0) {
      // Inside the rect: distance to the nearest edge.
      return Math.min(p.x - x1, x2 - p.x, p.y - y1, y2 - p.y);
    }
    return Math.hypot(dx, dy);
  }

  /** Pull points toward a horizontal baseline for a "straight-ish" underline. */
  function straightenUnderline(points) {
    if (points.length < 2) return;
    const y0 = points[0].y;
    const factor = 0.15; // keep 15% of the original vertical wobble
    for (const p of points) p.y = y0 + (p.y - y0) * factor;
  }

  function wrapText(ctx, text, maxWidth) {
    const lines = [];
    text.split("\n").forEach((paragraph) => {
      const words = paragraph.split(" ");
      let line = "";
      words.forEach((word) => {
        const test = line ? line + " " + word : word;
        if (line && ctx.measureText(test).width > maxWidth) {
          lines.push(line);
          line = word;
        } else {
          line = test;
        }
      });
      lines.push(line);
    });
    return lines;
  }

  function drawPolyline(ctx, points) {
    if (!points.length) return;
    if (points.length === 1) {
      ctx.beginPath();
      ctx.arc(points[0].x, points[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
  }

  function drawArrow(ctx, a, b) {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const headLen = Math.max(10, ctx.lineWidth * 3);
    const spread = (25 * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - headLen * Math.cos(angle - spread), b.y - headLen * Math.sin(angle - spread));
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - headLen * Math.cos(angle + spread), b.y - headLen * Math.sin(angle + spread));
    ctx.stroke();
  }

  function drawText(ctx, obj) {
    ctx.globalAlpha = 1;
    ctx.font = `${obj.fontSize}px system-ui, -apple-system, Segoe UI, sans-serif`;
    ctx.textBaseline = "top";
    const maxWidth = 420;
    const lines = wrapText(ctx, obj.text, maxWidth);
    const lineHeight = obj.fontSize * 1.3;
    lines.forEach((line, i) => ctx.fillText(line, obj.position.x, obj.position.y + i * lineHeight));
    let widest = 0;
    lines.forEach((line) => {
      widest = Math.max(widest, ctx.measureText(line).width);
    });
    obj._measuredWidth = Math.max(widest, 10);
    obj._measuredHeight = lines.length * lineHeight;
  }

  function drawObject(ctx, obj, backgroundMode) {
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = obj.color;
    ctx.fillStyle = obj.color;
    ctx.lineWidth = obj.width;
    ctx.globalAlpha = obj.opacity ?? 1;

    switch (obj.type) {
      case "stroke":
      case "highlight":
      case "underline":
        if (obj.type === "highlight") {
          ctx.globalCompositeOperation = backgroundMode === "dark" ? "source-over" : "multiply";
        }
        drawPolyline(ctx, obj.points);
        break;
      case "rect": {
        const { x1, y1, x2, y2 } = normalizeRect(obj.start, obj.end);
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        break;
      }
      case "ellipse": {
        const { x1, y1, x2, y2 } = normalizeRect(obj.start, obj.end);
        ctx.beginPath();
        ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.max(1, (x2 - x1) / 2), Math.max(1, (y2 - y1) / 2), 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case "line":
        ctx.beginPath();
        ctx.moveTo(obj.start.x, obj.start.y);
        ctx.lineTo(obj.end.x, obj.end.y);
        ctx.stroke();
        break;
      case "arrow":
        drawArrow(ctx, obj.start, obj.end);
        break;
      case "text":
        drawText(ctx, obj);
        break;
    }
    ctx.restore();
  }

  function hitTest(obj, x, y, radius) {
    const p = { x, y };
    switch (obj.type) {
      case "stroke":
      case "highlight":
      case "underline": {
        const pts = obj.points;
        if (pts.length === 1) return dist(pts[0], p) <= radius + obj.width / 2;
        for (let i = 0; i < pts.length - 1; i++) {
          if (pointToSegmentDistance(p, pts[i], pts[i + 1]) <= radius + obj.width / 2) return true;
        }
        return false;
      }
      case "line":
      case "arrow":
        return pointToSegmentDistance(p, obj.start, obj.end) <= radius + obj.width / 2;
      case "rect":
      case "ellipse": {
        const { x1, y1, x2, y2 } = normalizeRect(obj.start, obj.end);
        return distanceToRectOutline(p, x1, y1, x2, y2) <= radius + obj.width / 2;
      }
      case "text": {
        const w = obj._measuredWidth ?? 100;
        const h = obj._measuredHeight ?? obj.fontSize * 1.3;
        return x >= obj.position.x && x <= obj.position.x + w && y >= obj.position.y && y <= obj.position.y + h;
      }
      default:
        return false;
    }
  }

  function createEngine(canvas) {
    const ctx = canvas.getContext("2d");

    const engine = {
      canvas,
      ctx,
      objects: [],
      current: null,
      history: [],
      redoneHistory: [],
      currentTool: DEFAULTS.tool,
      currentColor: DEFAULTS.color,
      currentWidth: DEFAULTS.width,
      backgroundMode: DEFAULTS.background,
      cssWidth: 0,
      cssHeight: 0,
      dpr: 1,
      onTextRequest: null, // (x, y) => void, set by overlay-controller
      _listeners: [], // fn() => void, notified after tool/color/width/bg or object-list changes
      _pendingRender: false,
      _lastErasePoint: null,
    };

    engine.addListener = function (fn) {
      engine._listeners.push(fn);
    };
    engine._notify = function () {
      engine._listeners.forEach((fn) => fn());
    };

    engine.resize = function (cssW, cssH, dpr) {
      engine.cssWidth = cssW;
      engine.cssHeight = cssH;
      engine.dpr = dpr;
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
      canvas.style.width = cssW + "px";
      canvas.style.height = cssH + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      engine.renderNow();
    };

    engine.setActiveTool = function (tool) {
      engine.currentTool = tool;
      engine._lastErasePoint = null;
      canvas.style.pointerEvents = tool ? "auto" : "none";
      engine._notify();
    };

    engine.setColor = function (color) {
      engine.currentColor = color;
      engine._notify();
    };

    engine.setWidth = function (width) {
      engine.currentWidth = width;
      engine._notify();
    };

    engine.setBackgroundMode = function (mode) {
      engine.backgroundMode = mode;
      engine.requestRender();
      engine._notify();
    };

    engine.requestRender = function () {
      if (engine._pendingRender) return;
      engine._pendingRender = true;
      requestAnimationFrame(() => {
        engine._pendingRender = false;
        engine.renderNow();
      });
    };

    engine.renderNow = function () {
      ctx.clearRect(0, 0, engine.cssWidth, engine.cssHeight);
      for (const obj of engine.objects) drawObject(ctx, obj, engine.backgroundMode);
      if (engine.current) drawObject(ctx, engine.current, engine.backgroundMode);
    };
    engine.redrawAll = engine.renderNow;

    function pushAdd(obj) {
      engine.objects.push(obj);
      engine.history.push({ type: "add", object: obj });
      engine.redoneHistory = [];
    }

    function removeObject(obj) {
      const idx = engine.objects.indexOf(obj);
      if (idx !== -1) engine.objects.splice(idx, 1);
    }

    engine.pointerDown = function (x, y) {
      const tool = engine.currentTool;
      if (!tool) return;

      if (tool === TOOLS.TEXT) {
        engine.onTextRequest?.(x, y);
        return;
      }

      if (tool === TOOLS.ERASER) {
        engine._lastErasePoint = { x, y };
        engine.eraseAt(x, y);
        return;
      }

      if (FREEHAND_TOOLS.has(tool)) {
        const isHighlighter = tool === TOOLS.HIGHLIGHTER;
        engine.current = {
          id: makeId(),
          type: STROKE_TOOL_TYPE[tool],
          color: engine.currentColor,
          width: isHighlighter ? engine.currentWidth * 3 : engine.currentWidth,
          opacity: isHighlighter ? 0.35 : 1,
          points: [{ x, y }],
        };
        engine.requestRender();
        return;
      }

      if (SHAPE_TOOL_TYPE[tool]) {
        engine.current = {
          id: makeId(),
          type: SHAPE_TOOL_TYPE[tool],
          color: engine.currentColor,
          width: engine.currentWidth,
          opacity: 1,
          start: { x, y },
          end: { x, y },
        };
        engine.requestRender();
      }
    };

    engine.pointerMove = function (x, y) {
      const tool = engine.currentTool;
      if (!tool) return;

      if (tool === TOOLS.ERASER) {
        if (engine._lastErasePoint) engine._interpolateErase(engine._lastErasePoint, { x, y });
        engine._lastErasePoint = { x, y };
        return;
      }

      if (!engine.current) return;

      if (engine.current.points) {
        const last = engine.current.points[engine.current.points.length - 1];
        if (dist(last, { x, y }) >= 2) {
          engine.current.points.push({ x, y });
          engine.requestRender();
        }
      } else if (engine.current.end) {
        engine.current.end = { x, y };
        engine.requestRender();
      }
    };

    engine.pointerUp = function (x, y) {
      const tool = engine.currentTool;
      const hasPoint = typeof x === "number" && typeof y === "number";

      if (tool === TOOLS.ERASER) {
        if (hasPoint && engine._lastErasePoint) engine._interpolateErase(engine._lastErasePoint, { x, y });
        engine._lastErasePoint = null;
        return;
      }
      if (!engine.current) return;

      // Make sure the release position itself is captured, in case no
      // pointermove fired at exactly this spot (fast drags, touch input).
      if (hasPoint) {
        if (engine.current.points) {
          const last = engine.current.points[engine.current.points.length - 1];
          if (!last || dist(last, { x, y }) > 0) engine.current.points.push({ x, y });
        } else if (engine.current.end) {
          engine.current.end = { x, y };
        }
      }

      const obj = engine.current;
      engine.current = null;

      if (obj.points && obj.points.length < 2) {
        pushAdd(obj); // a single click still leaves a dot, which is fine
        engine.requestRender();
        return;
      }
      if (obj.start && obj.end) {
        const dx = Math.abs(obj.end.x - obj.start.x);
        const dy = Math.abs(obj.end.y - obj.start.y);
        if (dx < 2 && dy < 2) {
          engine.requestRender(); // accidental click-with-no-drag on a shape tool: discard
          return;
        }
      }
      if (obj.type === "underline") straightenUnderline(obj.points);

      pushAdd(obj);
      engine.requestRender();
    };

    engine.commitText = function (x, y, text, color, width) {
      if (!text || !text.trim()) return;
      const obj = {
        id: makeId(),
        type: "text",
        color: color || engine.currentColor,
        width: width || engine.currentWidth,
        opacity: 1,
        text,
        fontSize: 14 + (width || engine.currentWidth),
        position: { x, y },
      };
      pushAdd(obj);
      engine.requestRender();
    };

    engine.eraseAt = function (x, y) {
      const radius = Math.max(6, engine.currentWidth);
      for (let i = engine.objects.length - 1; i >= 0; i--) {
        const obj = engine.objects[i];
        if (hitTest(obj, x, y, radius)) {
          engine.objects.splice(i, 1);
          engine.history.push({ type: "erase", object: obj });
          engine.redoneHistory = [];
          engine.requestRender();
          break; // one object per sampled point, like a real eraser tip
        }
      }
    };

    engine._interpolateErase = function (a, b) {
      const d = dist(a, b);
      const steps = Math.max(1, Math.ceil(d / 4));
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        engine.eraseAt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
      }
    };

    engine.undo = function () {
      if (engine.history.length === 0) return;
      const record = engine.history.pop();
      if (record.type === "add") removeObject(record.object);
      else if (record.type === "erase") engine.objects.push(record.object);
      else if (record.type === "clear") engine.objects.push(...record.objects);
      engine.redoneHistory.push(record);
      engine.requestRender();
      engine._notify();
    };

    engine.redo = function () {
      if (engine.redoneHistory.length === 0) return;
      const record = engine.redoneHistory.pop();
      if (record.type === "add") engine.objects.push(record.object);
      else if (record.type === "erase") removeObject(record.object);
      else if (record.type === "clear") {
        const ids = new Set(record.objects.map((o) => o.id));
        engine.objects = engine.objects.filter((o) => !ids.has(o.id));
      }
      engine.history.push(record);
      engine.requestRender();
      engine._notify();
    };

    engine.clearAll = function () {
      if (engine.objects.length === 0) return;
      const cleared = engine.objects.slice();
      engine.objects = [];
      engine.history.push({ type: "clear", objects: cleared });
      engine.redoneHistory = [];
      engine.requestRender();
      engine._notify();
    };

    engine.exportPNG = function () {
      const temp = document.createElement("canvas");
      temp.width = canvas.width;
      temp.height = canvas.height;
      const tctx = temp.getContext("2d");
      tctx.setTransform(engine.dpr, 0, 0, engine.dpr, 0, 0);
      if (engine.backgroundMode === "dark") {
        tctx.fillStyle = DARK_BACKDROP_COLOR;
        tctx.fillRect(0, 0, engine.cssWidth, engine.cssHeight);
      }
      for (const obj of engine.objects) drawObject(tctx, obj, engine.backgroundMode);

      temp.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const stamp = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        const filename =
          `on-screen-writer-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-` +
          `${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.png`;
        a.href = url;
        a.download = filename;
        document.documentElement.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      }, "image/png");
    };

    return engine;
  }

  window.__OSW__ = window.__OSW__ || {};
  window.__OSW__.moduleLoaded = window.__OSW__.moduleLoaded || {};
  window.__OSW__.moduleLoaded.canvasEngine = true;
  window.__OSW__.createEngine = createEngine;
})();
