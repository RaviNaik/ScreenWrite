// Background service worker: routes the two global keyboard commands and the
// popup's "start/stop" button through one shared toggle/inject path. No
// content script runs anywhere until the user explicitly asks for it here.
importScripts("../shared/constants.js");

const { MESSAGE_TYPES, isUnsupportedUrl } = self.OSW_CONSTANTS;

const CONTENT_FILES = [
  "shared/constants.js",
  "content/canvas-engine.js",
  "content/toolbar.js",
  "content/shortcuts.js",
  "content/overlay-controller.js",
];

// No separate CSS file to inject: overlay-controller.js sets #osw-root's and
// the canvas's styles inline, and toolbar.js's styles live inside its own
// Shadow DOM as a template string — both self-contained, so plain
// executeScript (no insertCSS) is all injection needs.

/** Flash a short-lived badge on the action icon to say "can't run here". */
async function flashUnavailableBadge(tabId) {
  try {
    await chrome.action.setBadgeText({ tabId, text: "!" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#e53935" });
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
    }, 1500);
  } catch (_e) {
    // Badge APIs can fail on some tab states; not critical.
  }
}

/** True if the content script is already alive in this tab. */
async function isInjected(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: MESSAGE_TYPES.PING,
    });
    return !!response?.ok;
  } catch (_e) {
    return false;
  }
}

async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: CONTENT_FILES,
  });
}

/** Core entry point: ensure the overlay is injected, then toggle it. */
async function injectOrToggle(tabId, tab) {
  if (tabId == null) return;

  const url = tab?.url;
  if (url && isUnsupportedUrl(url)) {
    flashUnavailableBadge(tabId);
    return;
  }

  const alreadyInjected = await isInjected(tabId);
  if (!alreadyInjected) {
    try {
      await injectContentScript(tabId);
    } catch (_e) {
      // Injection can still fail (e.g. restricted page we didn't catch above).
      flashUnavailableBadge(tabId);
      return;
    }
  }

  try {
    await chrome.tabs.sendMessage(tabId, { type: MESSAGE_TYPES.TOGGLE });
  } catch (_e) {
    // No-op: extremely unlikely right after a successful injection/ping.
  }
}

async function clearActiveDrawing(tabId) {
  if (tabId == null) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: MESSAGE_TYPES.CLEAR });
  } catch (_e) {
    // Overlay isn't mounted in this tab; nothing to clear.
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  return tab;
}

chrome.commands.onCommand.addListener(async (command) => {
  const tab = await getActiveTab();
  if (!tab?.id) return;

  if (command === "toggle-overlay") {
    await injectOrToggle(tab.id, tab);
  } else if (command === "clear-drawing") {
    await clearActiveDrawing(tab.id);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === MESSAGE_TYPES.REQUEST_TOGGLE) {
    (async () => {
      const tab = sender.tab ?? (await getActiveTab());
      if (tab?.id) await injectOrToggle(tab.id, tab);
      sendResponse({ ok: true });
    })();
    return true; // keep the message channel open for the async response
  }

  if (message?.type === MESSAGE_TYPES.GET_STATUS) {
    (async () => {
      const tab = await getActiveTab();
      if (!tab?.id) {
        sendResponse({ supported: false, injected: false });
        return;
      }
      const supported = !isUnsupportedUrl(tab.url);
      const injected = supported ? await isInjected(tab.id) : false;
      sendResponse({ supported, injected });
    })();
    return true;
  }

  return false;
});
