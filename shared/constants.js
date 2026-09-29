// Shared constants used by the background service worker, popup, and content
// scripts. Loaded as a plain classic script everywhere (no ES modules), so it
// simply attaches a single global, `OSW_CONSTANTS`, via `self` (works in a
// service worker, a popup page, and a content-script `window` alike).
(function () {
  const TOOLS = {
    PEN: "pen",
    HIGHLIGHTER: "highlighter",
    UNDERLINE: "underline",
    ERASER: "eraser",
    RECT: "rect",
    ELLIPSE: "ellipse",
    LINE: "line",
    ARROW: "arrow",
    TEXT: "text",
  };

  const MESSAGE_TYPES = {
    PING: "OSW_PING",
    TOGGLE: "OSW_TOGGLE",
    CLEAR: "OSW_CLEAR",
    REQUEST_TOGGLE: "OSW_REQUEST_TOGGLE",
    GET_STATUS: "OSW_GET_STATUS",
  };

  const DEFAULT_COLORS = [
    "#1a1a1a", // near-black
    "#e53935", // red
    "#1e88e5", // blue
    "#43a047", // green
    "#fdd835", // yellow
    "#fb8c00", // orange
  ];

  const DEFAULTS = {
    color: DEFAULT_COLORS[0],
    width: 4,
    tool: null, // no tool active on mount -> page stays fully interactive
    background: "transparent", // 'transparent' | 'dark'
  };

  const MIN_WIDTH = 1;
  const MAX_WIDTH = 40;

  // The dark "blackboard" backdrop color, shared between the overlay's DOM
  // backdrop element and the PNG-export fill so they always match exactly.
  const DARK_BACKDROP_COLOR = "rgba(15, 15, 20, 0.96)";

  // URL prefixes we can never inject into. Kept here so the background
  // worker and popup both check against the exact same list.
  const UNSUPPORTED_URL_PATTERNS = [
    "chrome://",
    "chrome-extension://",
    "edge://",
    "about:",
    "https://chrome.google.com/webstore",
    "https://chromewebstore.google.com",
  ];

  function isUnsupportedUrl(url) {
    if (!url) return true;
    if (url.endsWith(".pdf")) return true;
    return UNSUPPORTED_URL_PATTERNS.some((prefix) => url.startsWith(prefix));
  }

  self.OSW_CONSTANTS = {
    TOOLS,
    MESSAGE_TYPES,
    DEFAULT_COLORS,
    DEFAULTS,
    MIN_WIDTH,
    MAX_WIDTH,
    DARK_BACKDROP_COLOR,
    UNSUPPORTED_URL_PATTERNS,
    isUnsupportedUrl,
  };
})();
