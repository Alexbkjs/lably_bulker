// Service worker: opens side panel and persists session data

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

console.log("[Lably BG] Service worker started");

// Auto-sync: listen for POST requests to lably (create/edit/delete)
chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.method === "POST") {
      console.log("[Lably BG] Lably POST detected:", details.url.substring(0, 80));
      // Notify sidepanel
      chrome.runtime.sendMessage({ type: "lably-mutation" }).catch(() => {});
    }
  },
  { urls: ["*://lably.devit.software/*"] }
);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "csrf-token") {
    chrome.storage.local.get("sessionData", ({ sessionData }) => {
      sessionData = sessionData || {};
      sessionData.csrfToken = msg.token;
      chrome.storage.local.set({ sessionData });
      console.log("[Lably BG] CSRF token saved");
    });
  }

  if (msg.type === "session-details") {
    chrome.storage.local.get("sessionData", ({ sessionData }) => {
      sessionData = sessionData || {};
      sessionData.hash = msg.hash;
      sessionData.store = msg.store;
      chrome.storage.local.set({ sessionData });
      console.log("[Lably BG] Session details saved:", msg.store);
    });
  }
});
