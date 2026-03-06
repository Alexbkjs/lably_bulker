// Runs in ISOLATED world on admin.shopify.com
// Bridges postMessage from inject.js (MAIN world) to chrome.runtime

console.log("[Lably content] Content script loaded on", window.location.hostname);

window.addEventListener("message", (e) => {
  if (e.source !== window) return;

  if (e.data?.type === "lably-csrf-token") {
    console.log("[Lably content] Forwarding CSRF token to background");
    chrome.runtime.sendMessage({ type: "csrf-token", token: e.data.token });
  }

  if (e.data?.type === "lably-session-details") {
    console.log("[Lably content] Forwarding session details:", e.data.store);
    chrome.runtime.sendMessage({
      type: "session-details",
      hash: e.data.hash,
      store: e.data.store,
    });
  }
});
