// Runs in MAIN world on admin.shopify.com
// Hooks window.fetch to capture CSRF token, operation hash, and store name
(function () {
  const origFetch = window.fetch;

  function extractFromUrl(url) {
    const re =
      /\/api\/operations\/([^\/]+)\/GenerateSessionToken\/shopify\/([^\/]+)/;
    const match = url.match(re);
    if (!match) return null;
    return { hash: match[1], store: match[2] };
  }

  window.fetch = async function (resource, config = {}) {
    try {
      const url = typeof resource === "string" ? resource : resource.url;

      // Capture CSRF token
      const token =
        config?.headers?.["X-CSRF-Token"] ||
        config?.headers?.["x-csrf-token"];
      if (token) {
        console.log("[Lably inject] CSRF token found");
        window.postMessage({ type: "lably-csrf-token", token }, "*");
      }

      // Capture hash + store name from GenerateSessionToken calls
      const details = extractFromUrl(url);
      if (details) {
        console.log("[Lably inject] Session details found:", details.store);
        window.postMessage(
          {
            type: "lably-session-details",
            hash: details.hash,
            store: details.store,
          },
          "*"
        );
      }
    } catch (e) {
      console.warn("[Lably inject] hook error:", e);
    }

    return origFetch.apply(this, arguments);
  };

  console.log("[Lably inject] Fetch hook installed on", window.location.hostname);
})();
