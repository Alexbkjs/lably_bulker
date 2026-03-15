// --- Constants ---
const LABLY_APP_ID = "gid://shopify/App/59604926465";
const LABLY_DOMAIN = "lably.devit.software";

const SUBTITLES = [
  "Let\u2019s get this show on the road.",
  "I\u2019ve had my coffee. Ready when you are.",
  "Hit me \u2014 what are we accomplishing today?",
  "Tell me what you need. I\u2019m all ears.",
  "Hey superstar, what\u2019s on the list?",
];

// Shape CSS from sel_lably LabelPreview
const SHAPE_STYLES = {
  rectangle: "",
  square: "aspect-ratio:1;",
  circle: "border-radius:50%;aspect-ratio:1;",
  "parallelogram-right": "transform:skewX(-10deg);",
  "parallelogram-left": "transform:skewX(10deg);",
  "tag-right": "clip-path:polygon(0 0, calc(100% - 6px) 0, 100% 50%, calc(100% - 6px) 100%, 0 100%);",
  "tag-left": "clip-path:polygon(6px 0, 100% 0, 100% 100%, 6px 100%, 0 50%);",
  "chev-right": "clip-path:polygon(0 0, calc(100% - 8px) 0, 100% 50%, calc(100% - 8px) 100%, 0 100%, 8px 50%);",
  "chev-left": "clip-path:polygon(8px 0, 100% 0, calc(100% - 8px) 50%, 100% 100%, 8px 100%, 0 50%);",
  "trapezoid-top-left": "clip-path:polygon(0 0, 100% 0, 0 100%);",
  "trapezoid-top-right": "clip-path:polygon(0 0, 100% 0, 100% 100%);",
  "trapezoid-bottom-left": "clip-path:polygon(0 0, 0 100%, 100% 100%);",
  "trapezoid-bottom-right": "clip-path:polygon(100% 0, 0 100%, 100% 100%);",
  "triangle-top-left": "clip-path:polygon(0 0, 100% 0, 0 100%);",
  "triangle-top-right": "clip-path:polygon(0 0, 100% 0, 100% 100%);",
  "triangle-bottom-left": "clip-path:polygon(0 0, 0 100%, 100% 100%);",
  "triangle-bottom-right": "clip-path:polygon(100% 0, 0 100%, 100% 100%);",
};

// --- State ---
let sessionData = null;
let allItems = [];
let filteredItems = [];
let selectedIds = new Set();
let currentFilter = "all";
let busy = false;
let pendingSelectorEdits = {}; // { itemId: newSelectorValue }
let pendingAdvancedEdits = {}; // { itemId: { fontSize: {desktop,tablet,mobile}, width: {...}, height: {...}, padding: {...}, margin: {...} } }
let advancedOpenIds = new Set(); // which cards have the advanced panel open
let autoSyncTimer = null;
let lastSyncTime = 0;

// --- DOM ---
const statusBadge = document.getElementById("status-badge");
const storeRow = document.getElementById("store-row");
const storeNameEl = document.getElementById("store-name");
const btnExport = document.getElementById("btn-export");
const btnImport = document.getElementById("btn-import");
const filterTabs = document.getElementById("filter-tabs");
const itemsList = document.getElementById("items-list");
const showingCount = document.getElementById("showing-count");
const subtitleEl = document.getElementById("subtitle");
const themeToggle = document.getElementById("theme-toggle");
const syncBtn = document.getElementById("sync-btn");
const updateModal = document.getElementById("update-modal");
const modalTitle = document.getElementById("modal-title");
const modalBody = document.getElementById("modal-body");
const modalClose = document.getElementById("modal-close");
const modalCancel = document.getElementById("modal-cancel");
const modalApply = document.getElementById("modal-apply");
const bulkSaveBar = document.getElementById("bulk-save-bar");
const bulkSaveText = document.getElementById("bulk-save-text");
const bulkSaveCancel = document.getElementById("bulk-save-cancel");
const bulkSaveApply = document.getElementById("bulk-save-apply");

console.log("[Lably SP] Sidepanel script loaded");

// ===========================================================================
// INIT
// ===========================================================================
async function init() {
  console.log("[Lably SP] init()");

  const { theme } = await chrome.storage.local.get("theme");
  if (theme === "dark") document.body.classList.add("dark");

  const now = new Date();
  const day = now.getDay();
  if (day >= 1 && day <= 5) {
    const seed = now.toISOString().slice(0, 10);
    let h = 0;
    for (let i = 0; i < seed.length; i++)
      h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
    subtitleEl.textContent = SUBTITLES[Math.abs(h) % SUBTITLES.length];
  }

  const stored = await chrome.storage.local.get("sessionData");
  sessionData = stored.sessionData || null;
  console.log("[Lably SP] sessionData:", JSON.stringify(sessionData));
  updateStatus();

  if (isConnected()) {
    const onLablyPage = await checkAdminTabUrl();
    if (onLablyPage) {
      console.log("[Lably SP] Connected & on Lably page, loading items...");
      await loadItems();
    } else {
      console.log("[Lably SP] Connected but not on Lably app page — disconnecting");
      disconnectStore("Open the Lably app in Shopify admin to connect");
    }
  } else {
    console.log("[Lably SP] Not connected. csrf:", !!sessionData?.csrfToken, "hash:", !!sessionData?.hash, "store:", !!sessionData?.store);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "csrf-token") {
      checkAdminTabUrl().then((onLablyPage) => {
        if (!onLablyPage) return;
        if (!sessionData) sessionData = {};
        sessionData.csrfToken = msg.token;
        chrome.storage.local.set({ sessionData });
        updateStatus();
      });
    }
    if (msg.type === "session-details") {
      if (!sessionData) sessionData = {};
      const prevStore = sessionData.store;
      sessionData.hash = msg.hash;
      sessionData.store = msg.store;
      chrome.storage.local.set({ sessionData });
      // Only auto-load if on the Lably app page
      checkAdminTabUrl().then((onLablyPage) => {
        if (!onLablyPage) {
          console.log("[Lably SP] Session details received but not on Lably page — ignoring");
          sessionData = null;
          chrome.storage.local.remove("sessionData");
          updateStatus();
          return;
        }
        updateStatus();
        if (isConnected() && prevStore && prevStore !== msg.store && !busy) {
          console.log("[Lably SP] Store changed from", prevStore, "to", msg.store, "— resyncing");
          loadItems();
        } else if (isConnected() && allItems.length === 0 && !busy) {
          loadItems();
        }
      });
    }
    // Auto-sync on lably mutations (create/edit/delete), throttled to 2s
    if (msg.type === "lably-mutation") {
      clearTimeout(autoSyncTimer);
      const elapsed = Date.now() - lastSyncTime;
      const delay = Math.max(1000, 2000 - elapsed);
      console.log("[Lably SP] Lably mutation detected, auto-syncing in", delay, "ms...");
      autoSyncTimer = setTimeout(() => {
        if (!busy && isConnected()) {
          lastSyncTime = Date.now();
          const icon = syncBtn.querySelector(".sync-icon");
          icon.classList.add("spinning");
          loadItems().finally(() => icon.classList.remove("spinning"));
        }
      }, delay);
    }
    // Navigation tracking — disconnect when leaving Lably page, connect when arriving
    if (msg.type === "admin-navigation") {
      if (!msg.isLablyPage && isConnected()) {
        console.log("[Lably SP] Navigated away from Lably app:", msg.url.substring(0, 80));
        disconnectStore("Open the Lably app in Shopify admin to connect");
      } else if (msg.isLablyPage && !isConnected() && !busy) {
        console.log("[Lably SP] Navigated to Lably app, waiting for session...");
        // Session details will arrive via inject.js → content.js → here;
        // loadItems will trigger once session-details message sets full sessionData
      }
    }
  });

  chrome.tabs.onActivated.addListener(async () => {
    setTimeout(async () => {
      const onLablyPage = await checkAdminTabUrl();
      if (!onLablyPage && isConnected()) {
        disconnectStore("Open the Lably app in Shopify admin to connect");
      }
      updateStatus();
    }, 300);
  });
}

// ===========================================================================
// THEME
// ===========================================================================
themeToggle.addEventListener("click", async () => {
  document.body.classList.toggle("dark");
  const isDark = document.body.classList.contains("dark");
  await chrome.storage.local.set({ theme: isDark ? "dark" : "light" });
});

// ===========================================================================
// SYNC
// ===========================================================================
syncBtn.addEventListener("click", async () => {
  if (busy || !isConnected()) return;
  const icon = syncBtn.querySelector(".sync-icon");
  icon.classList.add("spinning");
  try {
    await loadItems();
  } finally {
    icon.classList.remove("spinning");
  }
});

// ===========================================================================
// STATUS
// ===========================================================================
function isConnected() {
  return !!(sessionData?.csrfToken && sessionData?.hash && sessionData?.store);
}

function updateStatus() {
  const connected = isConnected();
  statusBadge.textContent = connected ? "Connected" : "Disconnected";
  statusBadge.className = `status-badge ${connected ? "connected" : "disconnected"}`;
  if (connected) {
    storeRow.style.display = "flex";
    storeNameEl.textContent = sessionData.store;
  } else {
    storeRow.style.display = "none";
  }
  updateButtonStates();
}

function updateButtonStates() {
  const connected = isConnected();
  btnExport.disabled = !connected || selectedIds.size === 0;
  btnImport.disabled = !connected;
  syncBtn.disabled = !connected;
}

function disconnectStore(reason) {
  console.log("[Lably SP] Disconnecting:", reason);
  sessionData = null;
  chrome.storage.local.remove("sessionData");
  allItems = [];
  filteredItems = [];
  selectedIds.clear();
  advancedOpenIds.clear();
  pendingSelectorEdits = {};
  pendingAdvancedEdits = {};
  updateStatus();
  itemsList.innerHTML = `<div class="empty-state">${esc(reason)}</div>`;
}

async function checkAdminTabUrl() {
  const adminTabs = await chrome.tabs.query({ url: "*://admin.shopify.com/*" });
  if (!adminTabs.length) return false;
  return adminTabs.some((t) => t.url?.includes(LABLY_APP_PATH));
}

// ===========================================================================
// TOKEN — runs in admin tab MAIN world (same-origin to Shopify API)
// ===========================================================================
async function getAdminToken() {
  console.log("[Lably SP] getAdminToken()");
  const adminTabs = await chrome.tabs.query({ url: "*://admin.shopify.com/*" });
  if (!adminTabs.length) throw new Error("Open Shopify admin first");

  const results = await chrome.scripting.executeScript({
    target: { tabId: adminTabs[0].id },
    world: "MAIN",
    func: async (hash, store, csrfToken, appId) => {
      try {
        const url = `https://admin.shopify.com/api/operations/${hash}/GenerateSessionToken/shopify/${store}`;
        const r = await fetch(url, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "x-csrf-token": csrfToken,
          },
          body: JSON.stringify({
            operationName: "GenerateSessionToken",
            variables: { appId },
          }),
        });
        if (!r.ok) return { error: `HTTP ${r.status}` };
        const data = await r.json();
        const token = data?.data?.adminGenerateSession?.session;
        return token ? { idToken: token } : { error: "No session in response" };
      } catch (e) {
        return { error: e.message };
      }
    },
    args: [sessionData.hash, sessionData.store, sessionData.csrfToken, LABLY_APP_ID],
  });

  const res = results?.[0]?.result;
  if (!res || res.error) throw new Error(res?.error || "Token fetch failed");
  console.log("[Lably SP] Got token:", res.idToken.substring(0, 30) + "...");
  return res.idToken;
}

// ===========================================================================
// LABLY API — direct fetch from sidepanel (host_permissions grant CORS access)
// ===========================================================================
const LABLY_APP_PATH = "/apps/product-labels-and-badges";
const LABLY_BASE = "https://" + LABLY_DOMAIN;

async function lablyFetch(path, options = {}) {
  const url = LABLY_BASE + path;
  console.log("[Lably SP] lablyFetch:", options.method || "GET", path.substring(0, 80));
  const r = await fetch(url, options);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r;
}

// ===========================================================================
// API CALLS — all run inside the lably iframe (same-origin to lably)
// ===========================================================================
async function fetchAllItemsViaIframe(idToken, store) {
  console.log("[Lably SP] fetchAllItems()");
  const params = new URLSearchParams({
    embedded: "1",
    id_token: idToken,
    locale: "en",
    shop: store + ".myshopify.com",
    _data: "routes/_app+/_index",
  });
  const r = await lablyFetch("/?" + params, {
    headers: {
      Accept: "*/*",
      Authorization: "Bearer " + idToken,
      "X-Requested-With": "XMLHttpRequest",
    },
  });
  const data = await r.json();
  return { items: data.allItems || data.items || [] };
}

async function fetchItemDataViaIframe(editorId, idToken) {
  console.log("[Lably SP] fetchItemData:", editorId);
  const r = await lablyFetch(
    "/editor/" + editorId + "?_data=routes%2F_app%2B%2Feditor%2B%2F%24id",
    {
      headers: {
        Accept: "*/*",
        Authorization: "Bearer " + idToken,
        "X-Requested-With": "XMLHttpRequest",
      },
    }
  );
  const data = await r.json();
  console.log("[Lably SP] fetchItem response keys:", JSON.stringify(Object.keys(data)));
  // Handle Remix DataWithResponseInit wrapper
  const actual = data.data !== undefined ? data.data : data;
  const item = actual?.item || actual;
  return { item: item };
}

async function updateItemViaIframe(editorId, mongoId, idToken, fullSettings, store) {
  console.log("[Lably SP] updateItem:", editorId, "mongoId:", mongoId);
  const params = new URLSearchParams({
    embedded: "1",
    fullscreen: "1",
    id_token: idToken,
    shop: store + ".myshopify.com",
    _data: "routes/_app+/editor+/$id",
  });
  const r = await lablyFetch("/editor/" + editorId + "?" + params, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "*/*",
      Authorization: "Bearer " + idToken,
      "X-Requested-With": "XMLHttpRequest",
    },
    body: JSON.stringify({
      _action: "update",
      data: { settings: fullSettings, id: mongoId, isStatusToggle: false },
    }),
  });
  return { ok: true, status: r.status };
}

async function createItemViaIframe(idToken, itemData, store) {
  console.log("[Lably SP] createItem:", itemData.name);
  const r = await lablyFetch("/editor/new", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "*/*",
      Authorization: "Bearer " + idToken,
      "X-Requested-With": "XMLHttpRequest",
    },
    body: JSON.stringify({
      _action: "create",
      data: { settings: itemData, isStatusToggle: false },
    }),
  });
  return { ok: true, status: r.status };
}

// ===========================================================================
// LOAD ITEMS
// ===========================================================================
async function loadItems() {
  if (busy) return;
  busy = true;
  console.log("[Lably SP] loadItems()");
  itemsList.innerHTML =
    '<div class="empty-state"><div style="display:flex;align-items:center;justify-content:center;gap:8px"><div class="spinner" style="border-color:var(--border);border-top-color:var(--selected-border);width:16px;height:16px"></div><span>Loading items...</span></div></div>';

  try {
    const idToken = await getAdminToken();
    const result = await fetchAllItemsViaIframe(idToken, sessionData.store);
    allItems = result.items;
    console.log("[Lably SP] Loaded", allItems.length, "items");
    selectedIds.clear();
    applyFilter();
    updateButtonStates();
    showToast(`Loaded ${allItems.length} items`, "success");
  } catch (err) {
    console.error("[Lably SP] loadItems error:", err);
    itemsList.innerHTML = `<div class="empty-state">Failed to load: ${esc(err.message)}</div>`;
    showToast("Failed to load items: " + err.message, "error");
  } finally {
    busy = false;
    lastSyncTime = Date.now();
  }
}

// ===========================================================================
// FILTER
// ===========================================================================
filterTabs.addEventListener("click", (e) => {
  const tab = e.target.closest(".filter-tab");
  if (!tab) return;
  currentFilter = tab.dataset.filter;
  filterTabs.querySelectorAll(".filter-tab").forEach((t) => t.classList.remove("active"));
  tab.classList.add("active");
  applyFilter();
});

function applyFilter() {
  const labelCount = allItems.filter((i) => i.type === "label").length;
  const badgeCount = allItems.filter((i) => i.type === "badge").length;

  document.getElementById("count-all").textContent = allItems.length;
  document.getElementById("count-labels").textContent = labelCount;
  document.getElementById("count-badges").textContent = badgeCount;

  filteredItems = currentFilter === "all"
    ? [...allItems]
    : allItems.filter((i) => i.type === currentFilter);

  showingCount.textContent = `Showing ${filteredItems.length} of ${allItems.length} items`;
  renderItems();
}

// ===========================================================================
// RENDER HELPERS
// ===========================================================================
function getVoPStatus(item) {
  const vis = item.settings?.visibility;
  const pages = Array.isArray(vis) ? vis.filter((v) => typeof v === "string") : [];
  const full = pages.length >= 6;
  return {
    status: full ? "ok" : "warning",
    tooltip: full ? "Visible on all pages" : "Visible on: " + (pages.length ? pages.join(", ") : "none"),
  };
}

function getWSStatus(item) {
  const ws = item.settings?.weekSchedule;
  if (!ws) return { status: "ok", tooltip: "No week schedule restrictions" };
  const allNull = ws.every((d) => d === null);
  return allNull
    ? { status: "ok", tooltip: "No week schedule restrictions" }
    : { status: "warning", tooltip: "Custom week schedule active" };
}

function getDPStatus(item) {
  const dp = item.settings?.displayPeriod;
  if (!dp || dp.allTime === true) return { status: "ok", tooltip: "Displayed all time" };
  const fmt = (d) => d ? new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : null;
  const s = fmt(dp.start || dp.startDate);
  const e = fmt(dp.end || dp.endDate);
  let tip = "Custom display period";
  if (s && e) tip = `${s} \u2192 ${e}`;
  else if (s) tip = `From ${s}`;
  else if (e) tip = `Until ${e}`;
  return { status: "warning", tooltip: tip };
}

function getDCStatus(item) {
  const dc = item.settings?.displayCondition;
  if (!dc) return { status: "ok", tooltip: "No display conditions" };
  if (dc.type && dc.variants && dc.variants.length > 0) {
    const names = dc.variants.map((v) => v.id || "condition");
    const unique = [...new Set(names)];
    return { status: "warning", tooltip: unique.slice(0, 3).join(", ") + (unique.length > 3 ? `, +${unique.length - 3} more` : "") };
  }
  if (dc.type && dc.type !== "any") return { status: "warning", tooltip: "Display condition: " + dc.type };
  return { status: "ok", tooltip: "No display conditions" };
}

function getPreviewHtml(item) {
  const styles = item.settings?.styles ?? item.style;
  const font = styles?.font;
  const bgColor = font?.color?.background || styles?.backgroundColor || "#E23737";
  const textColor = font?.color?.text || styles?.textColor || "#ffffff";
  const shape = styles?.shape || "rectangle";
  const shapeStyle = SHAPE_STYLES[shape] || "";

  const textValue = item.textValue?.original || (item.type === "badge" ? "Sale" : "Label");
  const tooltipAttr = `title="${esc(textValue)}"`;

  const isImage = item.subtype === "image" && item.previewLink;
  if (isImage) {
    return `<div class="item-preview-wrap" ${tooltipAttr}><img src="${esc(item.previewLink)}" style="width:38px;height:24px;object-fit:contain;border-radius:2px"></div>`;
  }

  const truncated = textValue.length > 6 ? textValue.substring(0, 5) + ".." : textValue;

  // Counter-transform for parallelogram text
  let textStyle = "";
  if (shape === "parallelogram-right") textStyle = "transform:skewX(10deg);";
  else if (shape === "parallelogram-left") textStyle = "transform:skewX(-10deg);";

  return `<div class="item-preview-wrap" ${tooltipAttr}><div class="item-preview-shape" style="background:${esc(bgColor)};color:${esc(textColor)};${shapeStyle}"><span style="padding:0 2px;${textStyle}">${esc(truncated)}</span></div></div>`;
}

function buildUnitTabs(units, activeUnit, dataAttr) {
  return `<span class="adv-unit-tabs" data-unit-for="${dataAttr}">${
    units.map((u) => `<button class="adv-unit-tab${u === activeUnit ? " active" : ""}" data-unit-val="${u}">${u}</button>`).join("")
  }</span>`;
}

function buildSpreadToggle(isSpread, dataAttr) {
  const tip = isSpread
    ? "Applying to all screen sizes"
    : "Applying to current screen size only";
  return `<button class="adv-spread-toggle${isSpread ? " active" : ""}" data-spread-for="${dataAttr}" title="${tip}">${isSpread ? "N" : "1"}</button>`;
}

function respLabel(full, short) {
  return `<span class="label-full">${full}</span><span class="label-short">${short}</span>`;
}

function buildAdvancedPanel(item) {
  const id = item.id;
  const adv = pendingAdvancedEdits[id] || {};
  const device = adv._device || "desktop";
  const s = item.settings || {};
  const font = s.styles?.font || {};
  const sizeObj = s.styles?.sizes || s.styles?.size || {};
  const marginObj = s.position?.margin || s.styles?.margin || {};
  const paddingObj = font.padding || {};

  // Visibility on pages — use full names as stored in the API
  const VIS_PAGES = ["Home Page", "Product Pages", "Search Results Pages", "Cart Page", "Collection Pages", "Other Pages"];
  const rawVis = adv.visibility || s.visibility || VIS_PAGES;
  const currentVisibility = Array.isArray(rawVis) ? rawVis : VIS_PAGES;
  const visHtml = VIS_PAGES.map((page) => {
    const checked = currentVisibility.includes(page) ? "checked" : "";
    return `<label class="adv-vis-label"><input type="checkbox" data-vis-page="${esc(page)}" ${checked}> ${esc(page)}</label>`;
  }).join("");

  // Unit helpers: read from pending edits first, then from item data
  const fsUnit = adv.fontSizeUnit || font.size?.[device]?.unit || font.size?.desktop?.unit || "px";
  const sizeUnit = adv.sizeUnit || sizeObj[device]?.unit || sizeObj.desktop?.unit || "px";
  const padUnit = adv.paddingUnit || paddingObj[device]?.unit || paddingObj.desktop?.unit || "px";
  const marUnit = adv.marginUnit || marginObj[device]?.unit || marginObj.desktop?.unit || "px";

  // Spread toggles (1 = current device only, N = all devices)
  const fsSpread = !!adv.fontSizeSpread;
  const sizeSpread = !!adv.sizeSpread;
  const padSpread = !!adv.paddingSpread;
  const marSpread = !!adv.marginSpread;

  // Value getters - fall back to desktop if current device has no value
  const val = (v) => (v === null || v === undefined || v === "") ? "" : v;
  const getFontSize = () => val(adv.fontSize?.[device] ?? font.size?.[device]?.value ?? font.size?.desktop?.value);
  const getWidth = () => val(adv.width?.[device] ?? sizeObj[device]?.width ?? sizeObj.desktop?.width);
  const getHeight = () => val(adv.height?.[device] ?? sizeObj[device]?.height ?? sizeObj.desktop?.height);
  const getPad = (side) => val(adv.padding?.[device]?.[side] ?? paddingObj[device]?.[side] ?? paddingObj.desktop?.[side]);
  const getMar = (side) => val(adv.margin?.[device]?.[side] ?? marginObj[device]?.[side] ?? marginObj.desktop?.[side]);

  return `
    <div class="item-advanced-panel" data-adv-id="${esc(id)}">
      <div class="adv-device-tabs">
        <button class="adv-device-tab${device === "desktop" ? " active" : ""}" data-device="desktop">Desktop</button>
        <button class="adv-device-tab${device === "tablet" ? " active" : ""}" data-device="tablet">Tablet</button>
        <button class="adv-device-tab${device === "mobile" ? " active" : ""}" data-device="mobile">Mobile</button>
      </div>
      <div class="adv-group">
        <div class="adv-grid">
          <div class="adv-field adv-field-full">
            <label>Font Size ${buildUnitTabs(["px", "rem", "em"], fsUnit, "fontSizeUnit")} ${buildSpreadToggle(fsSpread, "fontSizeSpread")}</label>
            <input type="number" step="any" data-field="fontSize" value="${esc(getFontSize())}" placeholder="-">
          </div>
          <div class="adv-field-full adv-size-header">
            <span>Width / Height</span>${buildUnitTabs(["px", "%"], sizeUnit, "sizeUnit")} ${buildSpreadToggle(sizeSpread, "sizeSpread")}
          </div>
          <div class="adv-field">
            <input type="number" step="any" data-field="width" value="${esc(getWidth())}" placeholder="W">
          </div>
          <div class="adv-field">
            <input type="number" step="any" data-field="height" value="${esc(getHeight())}" placeholder="H">
          </div>
        </div>
      </div>
      <div class="adv-group">
        <div class="adv-group-title">Padding ${buildUnitTabs(["px", "%"], padUnit, "paddingUnit")} ${buildSpreadToggle(padSpread, "paddingSpread")}</div>
        <div class="adv-4col">
          <div class="adv-field"><label>${respLabel("Top", "T")}</label><input type="number" step="any" data-field="padding-top" value="${esc(getPad("top"))}" placeholder="-"></div>
          <div class="adv-field"><label>${respLabel("Right", "R")}</label><input type="number" step="any" data-field="padding-right" value="${esc(getPad("right"))}" placeholder="-"></div>
          <div class="adv-field"><label>${respLabel("Bottom", "B")}</label><input type="number" step="any" data-field="padding-bottom" value="${esc(getPad("bottom"))}" placeholder="-"></div>
          <div class="adv-field"><label>${respLabel("Left", "L")}</label><input type="number" step="any" data-field="padding-left" value="${esc(getPad("left"))}" placeholder="-"></div>
        </div>
      </div>
      <div class="adv-group">
        <div class="adv-group-title">Margin ${buildUnitTabs(["px", "%"], marUnit, "marginUnit")} ${buildSpreadToggle(marSpread, "marginSpread")}</div>
        <div class="adv-4col">
          <div class="adv-field"><label>${respLabel("Top", "T")}</label><input type="number" step="any" data-field="margin-top" value="${esc(getMar("top"))}" placeholder="-"></div>
          <div class="adv-field"><label>${respLabel("Right", "R")}</label><input type="number" step="any" data-field="margin-right" value="${esc(getMar("right"))}" placeholder="-"></div>
          <div class="adv-field"><label>${respLabel("Bottom", "B")}</label><input type="number" step="any" data-field="margin-bottom" value="${esc(getMar("bottom"))}" placeholder="-"></div>
          <div class="adv-field"><label>${respLabel("Left", "L")}</label><input type="number" step="any" data-field="margin-left" value="${esc(getMar("left"))}" placeholder="-"></div>
        </div>
      </div>
      <div class="adv-group adv-collapsible">
        <div class="adv-group-title adv-collapse-toggle" data-collapse="vis-${esc(id)}">
          <span class="adv-collapse-arrow">&#9654;</span> Visibility on Pages
        </div>
        <div class="adv-vis-grid adv-collapse-body" id="vis-${esc(id)}" style="display:none">${visHtml}</div>
      </div>
    </div>
  `;
}

// ===========================================================================
// RENDER ITEMS
// ===========================================================================
function renderItems() {
  if (!filteredItems.length) {
    itemsList.innerHTML = '<div class="empty-state">No items to display.</div>';
    return;
  }

  let html = `
    <div class="select-all-row">
      <input type="checkbox" id="select-all" ${selectedIds.size === filteredItems.length && filteredItems.length > 0 ? "checked" : ""}>
      <label for="select-all">Select all</label>
      <span class="selected-count">${selectedIds.size > 0 ? selectedIds.size + " selected" : ""}</span>
    </div>
  `;

  for (const item of filteredItems) {
    const isSelected = selectedIds.has(item.id);
    const timeAgo = getTimeAgo(item.updatedAt || item.createdAt);
    const selector = pendingSelectorEdits[item.id] ?? item.settings?.position?.selector ?? "";
    const isBadge = item.type === "badge";
    const isDraft = item.status !== "published";
    const isAdvOpen = advancedOpenIds.has(item.id);

    // Status indicators
    const vop = getVoPStatus(item);
    const ws = getWSStatus(item);
    const dp = getDPStatus(item);
    const dc = getDCStatus(item);

    const tagHtml = (code, info) =>
      `<span class="item-tag ${info.status}"><span class="item-tag-tooltip">${esc(info.tooltip)}</span>${code}</span>`;

    const tagsHtml = tagHtml("VoP", vop) + tagHtml("WS", ws) + tagHtml("DP", dp) + tagHtml("DC", dc);

    const selectorHtml = `
      <div class="item-selector editable${pendingSelectorEdits[item.id] !== undefined ? " edited" : ""}" data-selector-id="${esc(item.id)}" title="Click to edit selector">
        <span class="item-selector-text">${selector ? esc(selector.length > 25 ? selector.slice(0, 25) + "..." : selector) : '<span style="opacity:0.4">no selector</span>'}</span>
        <button class="item-selector-copy" data-copy="${esc(selector || "")}" title="Copy selector">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
      </div>`;

    const cardClasses = [
      "item-card",
      isSelected ? "selected" : "",
      isDraft ? "draft" : "",
    ].filter(Boolean).join(" ");

    html += `
      <div class="${cardClasses}" data-id="${esc(item.id)}">
        <div class="item-card-top">
          <input type="checkbox" class="item-checkbox" data-id="${esc(item.id)}" ${isSelected ? "checked" : ""}>
          ${getPreviewHtml(item)}
          <div class="item-details">
            <div class="item-header">
              <span class="item-name${isDraft ? " draft-name" : ""}${selectedIds.size >= 2 && isSelected ? " item-name-editable" : ""}" ${selectedIds.size >= 2 && isSelected ? 'data-rename="1"' : ""}>${esc(item.name)}</span>
              <span class="item-time">${esc(timeAgo)}</span>
            </div>
            <div class="item-id-row">
              <span class="item-id">#${esc(item.id)}</span>
              <span class="item-id-divider"></span>
              <div class="item-tags">${tagsHtml}</div>
            </div>
            ${selectorHtml}
          </div>
        </div>
        ${isAdvOpen ? buildAdvancedPanel(item) : ""}
        ${isBadge ? '<div class="item-badge-corner">B</div>' : ""}
        ${isDraft ? '<div class="item-draft-corner">Draft</div>' : ""}
      </div>
    `;
  }

  itemsList.innerHTML = html;

  // Select all
  document.getElementById("select-all")?.addEventListener("change", (e) => {
    if (e.target.checked) filteredItems.forEach((i) => selectedIds.add(i.id));
    else filteredItems.forEach((i) => selectedIds.delete(i.id));
    renderItems();
    updateButtonStates();
  });

  // Name click → open rename modal when 2+ selected
  itemsList.querySelectorAll(".item-name-editable").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      openRenameModal();
    });
  });

  // Individual checkboxes
  itemsList.querySelectorAll(".item-checkbox").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      e.stopPropagation();
      if (cb.checked) selectedIds.add(cb.dataset.id);
      else selectedIds.delete(cb.dataset.id);
      renderItems();
      updateButtonStates();
    });
  });

  // Card click → toggle advanced mode (not selection)
  itemsList.querySelectorAll(".item-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest(".item-checkbox") || e.target.closest(".item-selector-copy") ||
          e.target.closest(".item-selector.editable") || e.target.closest(".item-advanced-panel") ||
          e.target.closest(".item-name-editable")) return;
      const id = card.dataset.id;
      if (advancedOpenIds.has(id)) advancedOpenIds.delete(id);
      else advancedOpenIds.add(id);
      renderItems();
    });
  });

  // Copy selector
  itemsList.querySelectorAll(".item-selector-copy").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(btn.dataset.copy);
      showToast("Selector copied", "info");
    });
  });

  // Inline selector editing
  itemsList.querySelectorAll(".item-selector.editable").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".item-selector-copy")) return;
      e.stopPropagation();
      const itemId = el.dataset.selectorId;
      const item = allItems.find((i) => i.id === itemId);
      const currentVal = pendingSelectorEdits[itemId] ?? item?.settings?.position?.selector ?? "";

      const input = document.createElement("input");
      input.type = "text";
      input.className = "item-selector-input";
      input.value = currentVal;
      input.placeholder = "e.g., .product-title";
      el.replaceWith(input);
      input.focus();
      input.select();

      const commitEdit = () => {
        const newVal = input.value.trim();
        const origVal = item?.settings?.position?.selector ?? "";
        if (newVal !== origVal) {
          pendingSelectorEdits[itemId] = newVal;
          if (selectedIds.has(itemId) && selectedIds.size > 1) {
            selectedIds.forEach((sid) => {
              if (sid !== itemId) pendingSelectorEdits[sid] = newVal;
            });
          }
        } else {
          delete pendingSelectorEdits[itemId];
          if (selectedIds.has(itemId)) {
            selectedIds.forEach((sid) => {
              const sItem = allItems.find((i) => i.id === sid);
              const sOrig = sItem?.settings?.position?.selector ?? "";
              if (pendingSelectorEdits[sid] === sOrig) delete pendingSelectorEdits[sid];
            });
          }
        }
        updateBulkSaveBar();
        renderItems();
      };

      input.addEventListener("blur", commitEdit);
      input.addEventListener("keydown", (ke) => {
        if (ke.key === "Enter") { ke.preventDefault(); input.blur(); }
        if (ke.key === "Escape") {
          delete pendingSelectorEdits[itemId];
          updateBulkSaveBar();
          renderItems();
        }
      });
    });
  });

  // Advanced panel: device tabs, unit tabs & field inputs
  itemsList.querySelectorAll(".item-advanced-panel").forEach((panel) => {
    const itemId = panel.dataset.advId;

    panel.querySelectorAll(".adv-device-tab").forEach((tab) => {
      tab.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!pendingAdvancedEdits[itemId]) pendingAdvancedEdits[itemId] = {};
        pendingAdvancedEdits[itemId]._device = tab.dataset.device;
        renderItems();
      });
    });

    // Unit tabs
    panel.querySelectorAll(".adv-unit-tabs").forEach((group) => {
      group.querySelectorAll(".adv-unit-tab").forEach((tab) => {
        tab.addEventListener("click", (e) => {
          e.stopPropagation();
          const unitFor = group.dataset.unitFor;
          const unitVal = tab.dataset.unitVal;
          if (!pendingAdvancedEdits[itemId]) pendingAdvancedEdits[itemId] = {};
          pendingAdvancedEdits[itemId][unitFor] = unitVal;
          // Propagate to selected
          if (selectedIds.has(itemId) && selectedIds.size > 1) {
            selectedIds.forEach((sid) => {
              if (sid === itemId) return;
              if (!pendingAdvancedEdits[sid]) pendingAdvancedEdits[sid] = {};
              pendingAdvancedEdits[sid][unitFor] = unitVal;
            });
          }
          updateBulkSaveBar();
          renderItems();
        });
      });
    });

    // Spread toggles (1:N) — switching to N copies current device values to all devices
    panel.querySelectorAll(".adv-spread-toggle").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const spreadFor = btn.dataset.spreadFor;
        if (!pendingAdvancedEdits[itemId]) pendingAdvancedEdits[itemId] = {};
        const adv = pendingAdvancedEdits[itemId];
        const wasOff = !adv[spreadFor];
        adv[spreadFor] = wasOff;

        // When switching to N, copy current device values to all devices
        if (wasOff) {
          const item = allItems.find((i) => i.id === itemId);
          const s = item?.settings || {};
          const device = adv._device || "desktop";
          const allDevs = ["desktop", "tablet", "mobile"];
          const font = s.styles?.font || {};
          const sizeObj = s.styles?.sizes || s.styles?.size || {};
          const paddingObj = font.padding || {};
          const marginObj = s.position?.margin || s.styles?.margin || {};

          if (spreadFor === "fontSizeSpread") {
            const cur = adv.fontSize?.[device] ?? font.size?.[device]?.value ?? font.size?.desktop?.value;
            if (cur !== undefined && cur !== null) {
              if (!adv.fontSize) adv.fontSize = {};
              for (const d of allDevs) adv.fontSize[d] = cur;
            }
          } else if (spreadFor === "sizeSpread") {
            const curW = adv.width?.[device] ?? sizeObj[device]?.width ?? sizeObj.desktop?.width;
            const curH = adv.height?.[device] ?? sizeObj[device]?.height ?? sizeObj.desktop?.height;
            if (curW !== undefined && curW !== null) {
              if (!adv.width) adv.width = {};
              for (const d of allDevs) adv.width[d] = curW;
            }
            if (curH !== undefined && curH !== null) {
              if (!adv.height) adv.height = {};
              for (const d of allDevs) adv.height[d] = curH;
            }
          } else if (spreadFor === "paddingSpread") {
            if (!adv.padding) adv.padding = {};
            for (const side of ["top", "right", "bottom", "left"]) {
              const cur = adv.padding?.[device]?.[side] ?? paddingObj[device]?.[side] ?? paddingObj.desktop?.[side];
              if (cur !== undefined && cur !== null) {
                for (const d of allDevs) {
                  if (!adv.padding[d]) adv.padding[d] = {};
                  adv.padding[d][side] = cur;
                }
              }
            }
          } else if (spreadFor === "marginSpread") {
            if (!adv.margin) adv.margin = {};
            for (const side of ["top", "right", "bottom", "left"]) {
              const cur = adv.margin?.[device]?.[side] ?? marginObj[device]?.[side] ?? marginObj.desktop?.[side];
              if (cur !== undefined && cur !== null) {
                for (const d of allDevs) {
                  if (!adv.margin[d]) adv.margin[d] = {};
                  adv.margin[d][side] = cur;
                }
              }
            }
          }
          updateBulkSaveBar();
        }
        renderItems();
      });
    });

    panel.querySelectorAll("input[data-field]").forEach((inp) => {
      inp.addEventListener("click", (e) => e.stopPropagation());
      inp.addEventListener("change", (e) => {
        e.stopPropagation();
        const field = inp.dataset.field;
        if (!pendingAdvancedEdits[itemId]) pendingAdvancedEdits[itemId] = {};
        const adv = pendingAdvancedEdits[itemId];
        const device = adv._device || "desktop";
        const val = inp.value.trim() === "" ? null : Number(inp.value);

        // Determine which devices to write to (1 or N)
        const allDevs = ["desktop", "tablet", "mobile"];
        const getDevices = (spreadKey) => adv[spreadKey] ? allDevs : [device];

        // Read item data for spread fallback
        const item = allItems.find((i) => i.id === itemId);
        const _s = item?.settings || {};
        const _font = _s.styles?.font || {};
        const _sizeObj = _s.styles?.sizes || _s.styles?.size || {};
        const _paddingObj = _font.padding || {};
        const _marginObj = _s.position?.margin || _s.styles?.margin || {};

        if (field === "fontSize") {
          if (!adv.fontSize) adv.fontSize = {};
          for (const d of getDevices("fontSizeSpread")) adv.fontSize[d] = val;
        } else if (field === "width") {
          if (!adv.width) adv.width = {};
          for (const d of getDevices("sizeSpread")) adv.width[d] = val;
        } else if (field === "height") {
          if (!adv.height) adv.height = {};
          for (const d of getDevices("sizeSpread")) adv.height[d] = val;
        } else if (field.startsWith("padding-")) {
          const side = field.replace("padding-", "");
          if (!adv.padding) adv.padding = {};
          const targets = getDevices("paddingSpread");
          for (const d of targets) {
            if (!adv.padding[d]) adv.padding[d] = {};
            adv.padding[d][side] = val;
          }
          // In N mode, also spread all other sides from current device
          if (adv.paddingSpread) {
            for (const otherSide of ["top", "right", "bottom", "left"]) {
              if (otherSide === side) continue;
              const cur = adv.padding[device]?.[otherSide] ?? _paddingObj[device]?.[otherSide] ?? _paddingObj.desktop?.[otherSide];
              if (cur !== undefined && cur !== null) {
                for (const d of allDevs) {
                  if (!adv.padding[d]) adv.padding[d] = {};
                  if (adv.padding[d][otherSide] === undefined) adv.padding[d][otherSide] = cur;
                }
              }
            }
          }
        } else if (field.startsWith("margin-")) {
          const side = field.replace("margin-", "");
          if (!adv.margin) adv.margin = {};
          const targets = getDevices("marginSpread");
          for (const d of targets) {
            if (!adv.margin[d]) adv.margin[d] = {};
            adv.margin[d][side] = val;
          }
          // In N mode, also spread all other sides from current device
          if (adv.marginSpread) {
            for (const otherSide of ["top", "right", "bottom", "left"]) {
              if (otherSide === side) continue;
              const cur = adv.margin[device]?.[otherSide] ?? _marginObj[device]?.[otherSide] ?? _marginObj.desktop?.[otherSide];
              if (cur !== undefined && cur !== null) {
                for (const d of allDevs) {
                  if (!adv.margin[d]) adv.margin[d] = {};
                  if (adv.margin[d][otherSide] === undefined) adv.margin[d][otherSide] = cur;
                }
              }
            }
          }
        }

        // Propagate to all selected
        if (selectedIds.has(itemId) && selectedIds.size > 1) {
          selectedIds.forEach((sid) => {
            if (sid === itemId) return;
            if (!pendingAdvancedEdits[sid]) pendingAdvancedEdits[sid] = {};
            const sadv = pendingAdvancedEdits[sid];
            sadv._device = device;
            if (field === "fontSize") {
              if (!sadv.fontSize) sadv.fontSize = {};
              for (const d of getDevices("fontSizeSpread")) sadv.fontSize[d] = val;
            } else if (field === "width") {
              if (!sadv.width) sadv.width = {};
              for (const d of getDevices("sizeSpread")) sadv.width[d] = val;
            } else if (field === "height") {
              if (!sadv.height) sadv.height = {};
              for (const d of getDevices("sizeSpread")) sadv.height[d] = val;
            } else if (field.startsWith("padding-")) {
              const s = field.replace("padding-", "");
              if (!sadv.padding) sadv.padding = {};
              for (const d of getDevices("paddingSpread")) {
                if (!sadv.padding[d]) sadv.padding[d] = {};
                sadv.padding[d][s] = val;
              }
              if (adv.paddingSpread) {
                const sItem = allItems.find((i) => i.id === sid);
                const sPadObj = sItem?.settings?.styles?.font?.padding || {};
                for (const otherSide of ["top", "right", "bottom", "left"]) {
                  if (otherSide === s) continue;
                  const cur = sadv.padding[device]?.[otherSide] ?? sPadObj[device]?.[otherSide] ?? sPadObj.desktop?.[otherSide];
                  if (cur !== undefined && cur !== null) {
                    for (const d of allDevs) {
                      if (!sadv.padding[d]) sadv.padding[d] = {};
                      if (sadv.padding[d][otherSide] === undefined) sadv.padding[d][otherSide] = cur;
                    }
                  }
                }
              }
            } else if (field.startsWith("margin-")) {
              const s = field.replace("margin-", "");
              if (!sadv.margin) sadv.margin = {};
              for (const d of getDevices("marginSpread")) {
                if (!sadv.margin[d]) sadv.margin[d] = {};
                sadv.margin[d][s] = val;
              }
              if (adv.marginSpread) {
                const sItem = allItems.find((i) => i.id === sid);
                const sMarObj = sItem?.settings?.position?.margin || sItem?.settings?.styles?.margin || {};
                for (const otherSide of ["top", "right", "bottom", "left"]) {
                  if (otherSide === s) continue;
                  const cur = sadv.margin[device]?.[otherSide] ?? sMarObj[device]?.[otherSide] ?? sMarObj.desktop?.[otherSide];
                  if (cur !== undefined && cur !== null) {
                    for (const d of allDevs) {
                      if (!sadv.margin[d]) sadv.margin[d] = {};
                      if (sadv.margin[d][otherSide] === undefined) sadv.margin[d][otherSide] = cur;
                    }
                  }
                }
              }
            }
          });
        }

        updateBulkSaveBar();
      });
    });

    // Visibility checkboxes
    panel.querySelectorAll("input[data-vis-page]").forEach((cb) => {
      cb.addEventListener("click", (e) => e.stopPropagation());
      cb.addEventListener("change", (e) => {
        e.stopPropagation();
        if (!pendingAdvancedEdits[itemId]) pendingAdvancedEdits[itemId] = {};
        const adv = pendingAdvancedEdits[itemId];
        const pages = [];
        panel.querySelectorAll("input[data-vis-page]").forEach((c) => {
          if (c.checked) pages.push(c.dataset.visPage);
        });
        adv.visibility = pages;
        if (selectedIds.has(itemId) && selectedIds.size > 1) {
          selectedIds.forEach((sid) => {
            if (sid === itemId) return;
            if (!pendingAdvancedEdits[sid]) pendingAdvancedEdits[sid] = {};
            pendingAdvancedEdits[sid].visibility = [...pages];
          });
        }
        updateBulkSaveBar();
      });
    });

    // Collapsible sections
    panel.querySelectorAll(".adv-collapse-toggle").forEach((toggle) => {
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        const targetId = toggle.dataset.collapse;
        const body = document.getElementById(targetId);
        if (!body) return;
        const open = body.style.display !== "none";
        body.style.display = open ? "none" : "";
        toggle.querySelector(".adv-collapse-arrow").textContent = open ? "\u25B6" : "\u25BC";
      });
    });
  });
}

// ===========================================================================
// BULK SAVE BAR — inline selector edits
// ===========================================================================
function hasAdvancedEdits(adv) {
  if (!adv) return false;
  if (adv.visibility) return true;
  // Unit changes count as edits
  if (adv.fontSizeUnit || adv.sizeUnit || adv.paddingUnit || adv.marginUnit) return true;
  const skipKeys = new Set(["_device", "fontSizeUnit", "sizeUnit", "paddingUnit", "marginUnit", "visibility", "fontSizeSpread", "sizeSpread", "paddingSpread", "marginSpread"]);
  let hasValues = false;
  for (const key of Object.keys(adv)) {
    if (skipKeys.has(key)) continue;
    const val = adv[key];
    if (val && typeof val === "object") {
      for (const dk of Object.keys(val)) {
        const dv = val[dk];
        if (dv !== null && dv !== undefined && dv !== "") {
          if (typeof dv === "object") {
            if (Object.values(dv).some((v) => v !== null && v !== undefined && v !== "")) hasValues = true;
          } else hasValues = true;
        }
      }
    }
  }
  return hasValues;
}

function updateBulkSaveBar() {
  const selectorIds = Object.keys(pendingSelectorEdits);
  const advIds = Object.keys(pendingAdvancedEdits).filter((id) => hasAdvancedEdits(pendingAdvancedEdits[id]));
  const allEditIds = new Set([...selectorIds, ...advIds]);
  const editCount = allEditIds.size;

  if (editCount > 0) {
    bulkSaveText.textContent = `Update ${editCount} item${editCount > 1 ? "s" : ""}`;
    bulkSaveBar.style.display = "flex";
  } else {
    bulkSaveBar.style.display = "none";
  }
}

bulkSaveCancel.addEventListener("click", () => {
  pendingSelectorEdits = {};
  pendingAdvancedEdits = {};
  updateBulkSaveBar();
  renderItems();
});

bulkSaveApply.addEventListener("click", async () => {
  const selectorEdits = { ...pendingSelectorEdits };
  const advEdits = JSON.parse(JSON.stringify(pendingAdvancedEdits));
  const selectorIds = Object.keys(selectorEdits);
  const advIds = Object.keys(advEdits).filter((id) => hasAdvancedEdits(advEdits[id]));
  const allEditIds = [...new Set([...selectorIds, ...advIds])];
  if (allEditIds.length === 0) return;

  bulkSaveApply.disabled = true;
  bulkSaveCancel.disabled = true;
  busy = true;

  let successCount = 0;
  let failCount = 0;

  try {
    const idToken = await getAdminToken();

    for (const itemId of allEditIds) {
      const item = allItems.find((i) => i.id === itemId);
      if (!item) { failCount++; continue; }

      try {
        const full = JSON.parse(JSON.stringify(item));
        if (!full.settings) full.settings = {};

        // Apply selector edit
        if (selectorEdits[itemId] !== undefined) {
          if (!full.settings.position) full.settings.position = {};
          full.settings.position.selector = selectorEdits[itemId];
          // For badges, set both isCustom flags
          if (full.type === "badge") {
            full.settings.position.isCustom = true;
            if (!full.settings.position.badge) full.settings.position.badge = {};
            full.settings.position.badge.default = "custom";
            full.settings.position.badge.isCustom = true;
          }
        }

        // Apply advanced edits
        const adv = advEdits[itemId];
        if (adv && hasAdvancedEdits(adv)) {
          if (!full.settings.styles) full.settings.styles = {};
          const st = full.settings.styles;

          const fsUnit = adv.fontSizeUnit || "px";
          const szUnit = adv.sizeUnit || "px";
          const padUnitVal = adv.paddingUnit || "px";
          const marUnitVal = adv.marginUnit || "px";

          // Font size
          if (adv.fontSize) {
            if (!st.font) st.font = {};
            if (!st.font.size) st.font.size = {};
            for (const dev of ["desktop", "tablet", "mobile"]) {
              if (adv.fontSize[dev] !== undefined && adv.fontSize[dev] !== null) {
                if (!st.font.size[dev]) st.font.size[dev] = {};
                st.font.size[dev].value = adv.fontSize[dev];
                st.font.size[dev].unit = fsUnit;
              }
            }
          }

          // Width/Height — stored under settings.styles.sizes
          if (adv.width || adv.height) {
            if (!st.sizes) st.sizes = {};
            for (const dev of ["desktop", "tablet", "mobile"]) {
              if ((adv.width?.[dev] !== undefined && adv.width[dev] !== null) ||
                  (adv.height?.[dev] !== undefined && adv.height[dev] !== null)) {
                if (!st.sizes[dev]) st.sizes[dev] = {};
                st.sizes[dev].unit = szUnit;
                if (adv.width?.[dev] !== undefined && adv.width[dev] !== null) st.sizes[dev].width = adv.width[dev];
                if (adv.height?.[dev] !== undefined && adv.height[dev] !== null) st.sizes[dev].height = adv.height[dev];
              }
            }
          }

          // Padding
          if (adv.padding) {
            if (!st.font) st.font = {};
            if (!st.font.padding) st.font.padding = {};
            for (const dev of ["desktop", "tablet", "mobile"]) {
              if (adv.padding[dev]) {
                if (!st.font.padding[dev]) st.font.padding[dev] = {};
                st.font.padding[dev].unit = padUnitVal;
                for (const side of ["top", "right", "bottom", "left"]) {
                  if (adv.padding[dev][side] !== undefined && adv.padding[dev][side] !== null) {
                    st.font.padding[dev][side] = adv.padding[dev][side];
                  }
                }
              }
            }
          }

          // Visibility
          if (adv.visibility) {
            full.settings.visibility = adv.visibility;
          }

          // Margin — stored under settings.position.margin
          if (adv.margin) {
            if (!full.settings.position) full.settings.position = {};
            if (!full.settings.position.margin) full.settings.position.margin = {};
            const posMargin = full.settings.position.margin;
            for (const dev of ["desktop", "tablet", "mobile"]) {
              if (adv.margin[dev]) {
                if (!posMargin[dev]) posMargin[dev] = {};
                posMargin[dev].unit = marUnitVal;
                for (const side of ["top", "right", "bottom", "left"]) {
                  if (adv.margin[dev][side] !== undefined && adv.margin[dev][side] !== null) {
                    posMargin[dev][side] = adv.margin[dev][side];
                  }
                }
              }
            }
          }
        }

        await updateItemViaIframe(item.id, item._id, idToken, full, sessionData.store);
        successCount++;
        console.log("[Lably SP] Bulk save updated:", item.id);
      } catch (err) {
        console.error("[Lably SP] Bulk save failed:", item.id, err);
        failCount++;
      }
    }

    showToast(
      `Saved: ${successCount} updated${failCount > 0 ? `, ${failCount} failed` : ""}`,
      failCount > 0 ? "error" : "success"
    );

    pendingSelectorEdits = {};
    pendingAdvancedEdits = {};
    updateBulkSaveBar();
    busy = false;
    await loadItems();
  } catch (err) {
    showToast("Save failed: " + err.message, "error");
  } finally {
    busy = false;
    bulkSaveApply.disabled = false;
    bulkSaveCancel.disabled = false;
  }
});

// ===========================================================================
// EXPORT — uses already-loaded allItems data, NO extra network requests
// ===========================================================================
btnExport.addEventListener("click", async () => {
  console.log("[Lably SP] Export clicked, selected:", selectedIds.size);
  const selectedItems = allItems.filter((i) => selectedIds.has(i.id));
  if (selectedItems.length === 0) {
    showToast("Select at least one item to export.", "error");
    return;
  }

  const exportData = {
    version: "2.0",
    exportDate: new Date().toISOString(),
    sourceStore: sessionData.store,
    labels: [],
  };

  for (const item of selectedItems) {
    // Clone and remove store-specific fields
    const cleaned = JSON.parse(JSON.stringify(item));
    delete cleaned._id;
    delete cleaned.id;
    delete cleaned.storeId;
    delete cleaned.metafieldId;
    delete cleaned.createdAt;
    delete cleaned.updatedAt;
    delete cleaned.__v;
    exportData.labels.push(cleaned);
  }

  const jsonStr = JSON.stringify(exportData, null, 2);
  const blob = new Blob([jsonStr], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `lably-export-${sessionData.store}-${new Date().toISOString().split("T")[0]}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast(`Exported ${selectedItems.length} items`, "success");
  console.log("[Lably SP] Export complete:", selectedItems.length, "items");
});

// ===========================================================================
// IMPORT — creates items via lably iframe
// ===========================================================================
btnImport.addEventListener("click", async () => {
  console.log("[Lably SP] Import clicked");
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.multiple = true;

  input.onchange = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;

    btnImport.disabled = true;
    busy = true;
    const origSpan = btnImport.querySelector("span");
    const origText = origSpan.textContent;
    origSpan.textContent = "Importing...";

    let totalSuccess = 0;
    let totalFail = 0;

    try {
      const idToken = await getAdminToken();

      for (const file of files) {
        try {
          const text = await file.text();
          const importData = JSON.parse(text);
          const labels = importData.labels || importData.items;
          if (!labels || !Array.isArray(labels)) {
            showToast(`Skipped ${file.name}: no "labels" array.`, "error");
            continue;
          }

          console.log("[Lably SP] Importing", labels.length, "items from", file.name);

          for (const labelData of labels) {
            try {
              if (!labelData.name) labelData.name = "Imported Label";
              if (!labelData.type) labelData.type = "label";
              labelData.status = "draft";
              await createItemViaIframe(idToken, labelData, sessionData.store);
              totalSuccess++;
              // Small delay between creates to avoid overwhelming the server
              await new Promise((r) => setTimeout(r, 500));
            } catch (err) {
              console.error("[Lably SP] Import item failed:", labelData.name, err);
              totalFail++;
            }
          }
        } catch (err) {
          showToast(`Failed to parse ${file.name}: ${err.message}`, "error");
        }
      }

      showToast(
        `Import: ${totalSuccess} created${totalFail > 0 ? `, ${totalFail} failed` : ""}`,
        totalFail > 0 ? "error" : "success"
      );
      busy = false;
      await loadItems();
    } catch (err) {
      console.error("[Lably SP] Import error:", err);
      showToast("Import failed: " + err.message, "error");
    } finally {
      busy = false;
      origSpan.textContent = origText;
      updateButtonStates();
    }
  };

  input.click();
});

// ===========================================================================
// RENAME MODAL — name transformation for selected items
// ===========================================================================
function openRenameModal() {
  const targetItems = allItems.filter((i) => selectedIds.has(i.id));
  if (targetItems.length < 2) return;

  modalTitle.textContent = "Rename Items";
  modalBody.innerHTML = `
    <p style="font-size:12px;color:var(--text-secondary);margin-bottom:16px">
      Renaming <strong>${targetItems.length}</strong> selected items.
    </p>
    <div class="form-section">
      <div class="form-section-title">Name Transformation</div>
      <p class="form-help" style="margin-bottom:8px">Removes " (copy)" from names and appends your text.</p>
      <div class="form-group">
        <label class="form-label">Text to Append</label>
        <input type="text" class="form-input" id="field-name-append" placeholder='e.g., v2'>
        <p class="form-help">Leave empty to only strip " (copy)".</p>
      </div>
    </div>
    <div id="update-progress" style="display:none">
      <div class="progress-bar"><div class="progress-fill" id="progress-fill"></div></div>
      <p style="font-size:11px;color:var(--text-muted);margin-top:4px" id="progress-text">Processing...</p>
    </div>
  `;

  updateModal.style.display = "flex";
}

modalClose.addEventListener("click", () => (updateModal.style.display = "none"));
modalCancel.addEventListener("click", () => (updateModal.style.display = "none"));

modalApply.addEventListener("click", async () => {
  const nameAppend = document.getElementById("field-name-append")?.value.trim() || "";

  const targetItems = allItems.filter((i) => selectedIds.has(i.id));
  if (targetItems.length === 0) {
    showToast("No items selected.", "error");
    return;
  }

  modalApply.disabled = true;
  modalCancel.disabled = true;
  modalClose.disabled = true;
  busy = true;

  const progressDiv = document.getElementById("update-progress");
  const progressFill = document.getElementById("progress-fill");
  const progressText = document.getElementById("progress-text");
  progressDiv.style.display = "block";

  let successCount = 0;
  let failCount = 0;

  try {
    const idToken = await getAdminToken();

    for (let i = 0; i < targetItems.length; i++) {
      const item = targetItems[i];
      const pct = Math.round(((i + 1) / targetItems.length) * 100);
      progressFill.style.width = pct + "%";
      progressText.textContent = `Processing ${i + 1}/${targetItems.length}: ${item.name}`;

      try {
        const full = JSON.parse(JSON.stringify(item));
        let baseName = full.name.replace(/\s*\(copy\)/gi, "").trim();
        full.name = nameAppend ? `${baseName} ${nameAppend}` : baseName;

        await updateItemViaIframe(item.id, item._id, idToken, full, sessionData.store);
        successCount++;
      } catch (err) {
        console.error("[Lably SP] Rename failed:", item.id, err);
        failCount++;
      }
    }

    showToast(
      `Renamed: ${successCount} success${failCount > 0 ? `, ${failCount} failed` : ""}`,
      failCount > 0 ? "error" : "success"
    );
    busy = false;
    await loadItems();
  } catch (err) {
    showToast("Rename failed: " + err.message, "error");
  } finally {
    busy = false;
    modalApply.disabled = false;
    modalCancel.disabled = false;
    modalClose.disabled = false;
    updateModal.style.display = "none";
  }
});

// ===========================================================================
// UTILITIES
// ===========================================================================
function deepMerge(target, source) {
  const output = { ...target };
  for (const key in source) {
    if (source[key] !== null && source[key] !== undefined) {
      if (typeof source[key] === "object" && !Array.isArray(source[key])) {
        output[key] = deepMerge(target[key] || {}, source[key]);
      } else {
        output[key] = source[key];
      }
    }
  }
  return output;
}

function getTimeAgo(dateStr) {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function esc(s) {
  if (s == null) return "";
  const d = document.createElement("div");
  d.textContent = String(s);
  return d.innerHTML;
}

function showToast(message, type = "info") {
  console.log("[Lably SP] Toast:", type, message);
  document.querySelector(".toast")?.remove();
  const icons = { success: "\u2713", error: "\u2717", info: "i" };
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.innerHTML = `<span class="toast-icon">${icons[type] || "i"}</span><span class="toast-msg"></span><button class="toast-close">Close</button>`;
  t.querySelector(".toast-msg").textContent = message;
  t.querySelector(".toast-close").addEventListener("click", () => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 200);
  });
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => {
    if (t.parentNode) {
      t.classList.remove("show");
      setTimeout(() => t.remove(), 200);
    }
  }, 4000);
}

// ===========================================================================
// START
// ===========================================================================
init();
