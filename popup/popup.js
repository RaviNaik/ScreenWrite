(function () {
  const { MESSAGE_TYPES } = self.OSW_CONSTANTS ?? {};

  const statusEl = document.getElementById("status");
  const toggleBtn = document.getElementById("toggleBtn");
  const shortcutsLink = document.getElementById("shortcutsLink");

  function refreshStatus() {
    chrome.runtime.sendMessage({ type: MESSAGE_TYPES.GET_STATUS }, (response) => {
      if (!response || !response.supported) {
        statusEl.textContent = "This page can't be annotated (browser/Web Store pages, PDFs).";
        statusEl.classList.add("unsupported");
        toggleBtn.disabled = true;
        return;
      }
      statusEl.textContent = response.injected ? "Annotator is active on this tab." : "Ready to annotate this tab.";
      toggleBtn.textContent = response.injected ? "Stop Annotating" : "Start Annotating";
    });
  }

  toggleBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: MESSAGE_TYPES.REQUEST_TOGGLE }, () => {
      window.close();
    });
  });

  shortcutsLink.addEventListener("click", () => {
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });

  refreshStatus();
})();
