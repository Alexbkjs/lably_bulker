# Lably Bulker - Chrome Extension

## What this is
Chrome extension (Manifest V3) with a side panel UI for bulk managing labels and badges in the Lably Shopify app (lably.devit.software). Supports export, import, bulk update, auto-sync, and advanced per-device styling operations.

## Architecture

### Content script pipeline
1. **inject.js** (MAIN world, admin.shopify.com) - Hooks `window.fetch` to capture CSRF token and session details (hash + store name) from `GenerateSessionToken` calls
2. **content.js** (ISOLATED world, admin.shopify.com) - Bridges `postMessage` from inject.js to `chrome.runtime.sendMessage`
3. **background.js** - Service worker that persists session data to `chrome.storage.local`, opens side panel on action click, and listens for lably POST mutations via `chrome.webRequest`
4. **sidepanel.js** - Main logic: UI, token management, API calls via iframe execution

### API call strategy
- **Token fetching**: `chrome.scripting.executeScript` in admin tab MAIN world to call Shopify's `GenerateSessionToken` endpoint (same-origin)
- **Lably API calls**: `chrome.scripting.executeScript` inside the Lably iframe (found via `chrome.webNavigation.getAllFrames`). This is required because the Lably server rejects requests not from its own origin.
- **Lably frame retry**: `getLablyFrame()` retries up to 5 times (1s apart) to allow the iframe to load before erroring
- **Export**: Uses cached `allItems` data, no network requests needed

### Auto-sync
- `chrome.webRequest.onCompleted` in background.js watches for POST requests to `*://lably.devit.software/*`
- background.js sends `lably-mutation` message to sidepanel via `chrome.runtime.sendMessage`
- Sidepanel debounces mutations (min 1s) and throttles resyncs to max once per 2s via `lastSyncTime`
- `busy` flag prevents auto-sync from firing during own operations (import/update/bulk save)
- Store switch (different store name in session-details) also triggers automatic resync

### Key IDs
- Items have both `id` (editor ID like "FL117435") used in URL paths and `_id` (MongoDB ObjectId like "69aaa4285cf2917f7a4141f2") used in POST body `data.id`
- Lably App ID: `gid://shopify/App/59604926465`

### Known patterns
- Remix framework: POST actions to `/editor/{id}` need `_data=routes/_app+/editor+/$id` query param for JSON response. Create endpoint (`/editor/new`) returns HTML, not JSON - don't parse the response.
- `busy` flag prevents feedback loops: `getAdminToken()` triggers inject.js fetch hook which sends session-details back to sidepanel, which could re-trigger `loadItems()`. The `busy` flag blocks this cascade during load/import/update operations.
- Badge custom selector: when setting a custom selector for badge type, must set BOTH `position.isCustom = true` AND `position.badge.isCustom = true` plus `position.badge.default = "custom"`
- Data paths: width/height at `settings.styles.sizes` (not `size`), margin at `settings.position.margin` (not `styles.margin`), padding at `settings.styles.font.padding`
- Visibility pages: stored as full name strings ("Home Page", "Product Pages", etc.), NOT short codes
- 1:N spread toggle: `*Spread` booleans in pendingAdvancedEdits control whether edits apply to current device or all three. In N mode for padding/margin, changing one side also spreads other sides to all devices.

### Card interaction model
- **Card click** toggles advanced mode panel (not selection)
- **Checkbox click** is the only way to select/deselect items
- **Name click** (when 2+ selected) opens rename modal
- **Selector click** enables inline editing with bulk propagation

## File overview
- `manifest.json` - Extension config, permissions: sidePanel, storage, activeTab, scripting, tabs, webNavigation, webRequest
- `inject.js` - Fetch hook in admin.shopify.com MAIN world
- `content.js` - Message bridge (ISOLATED world to chrome.runtime)
- `background.js` - Service worker, session data persistence, webRequest mutation listener
- `sidepanel.html` - UI structure
- `sidepanel.css` - Styling with light/dark theme via CSS variables
- `sidepanel.js` - All sidepanel logic (token, API calls, UI rendering, export/import/update/auto-sync)
- `ignore/` - Reference files (not part of the extension): original Tampermonkey script, selecty_example, task spec

## Reference files
- `ignore/deb_lib/script.js` - Working Tampermonkey userscript (reference implementation using GM.xmlHttpRequest)
- `ignore/deb_lib/selecty_example/` - Another Chrome extension used as architectural reference
- `ignore/deb_lib/task.txt` - Original task specification with API request/response examples
