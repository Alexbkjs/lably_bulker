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

const VISIBILITY_SHORT = {
  "Home Page": "HP",
  "Product Pages": "PP",
  "Search Results Pages": "SR",
  "Cart Page": "CP",
  "Collection Pages": "CL",
  "Other Pages": "OP",
};

// --- State ---
let sessionData = null;
let allItems = [];
let filteredItems = [];
let selectedIds = new Set();
let currentFilter = "all";
let currentUpdateMode = null;
let busy = false;

// --- DOM ---
const statusBadge = document.getElementById("status-badge");
const storeRow = document.getElementById("store-row");
const storeNameEl = document.getElementById("store-name");
const btnUpdateLabels = document.getElementById("btn-update-labels");
const btnUpdateBadges = document.getElementById("btn-update-badges");
const btnExport = document.getElementById("btn-export");
const btnImport = document.getElementById("btn-import");
const filterTabs = document.getElementById("filter-tabs");
const itemsList = document.getElementById("items-list");
const showingCount = document.getElementById("showing-count");
const subtitleEl = document.getElementById("subtitle");
const themeToggle = document.getElementById("theme-toggle");
const updateModal = document.getElementById("update-modal");
const modalTitle = document.getElementById("modal-title");
const modalBody = document.getElementById("modal-body");
const modalClose = document.getElementById("modal-close");
const modalCancel = document.getElementById("modal-cancel");
const modalApply = document.getElementById("modal-apply");

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
    console.log("[Lably SP] Connected, loading items...");
    await loadItems();
  } else {
    console.log("[Lably SP] Not connected. csrf:", !!sessionData?.csrfToken, "hash:", !!sessionData?.hash, "store:", !!sessionData?.store);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "csrf-token") {
      if (!sessionData) sessionData = {};
      sessionData.csrfToken = msg.token;
      chrome.storage.local.set({ sessionData });
      updateStatus();
    }
    if (msg.type === "session-details") {
      if (!sessionData) sessionData = {};
      sessionData.hash = msg.hash;
      sessionData.store = msg.store;
      chrome.storage.local.set({ sessionData });
      updateStatus();
      if (isConnected() && allItems.length === 0 && !busy) {
        loadItems();
      }
    }
  });

  chrome.tabs.onActivated.addListener(() =>
    setTimeout(() => updateStatus(), 300)
  );
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
  btnUpdateLabels.disabled = !connected;
  btnUpdateBadges.disabled = !connected;
  btnExport.disabled = !connected || selectedIds.size === 0;
  btnImport.disabled = !connected;
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
// LABLY IFRAME — find the iframe and execute API calls inside it (same-origin)
// ===========================================================================
async function getLablyFrame() {
  const adminTabs = await chrome.tabs.query({ url: "*://admin.shopify.com/*" });
  if (!adminTabs.length) throw new Error("Open Shopify admin first");
  const tabId = adminTabs[0].id;

  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const lablyFrame = frames.find((f) => f.url.includes(LABLY_DOMAIN));
  if (!lablyFrame) throw new Error("Lably app not open in admin — open the Lably app page first");

  console.log("[Lably SP] Found lably frame:", lablyFrame.frameId, lablyFrame.url.substring(0, 60));
  return { tabId, frameId: lablyFrame.frameId };
}

// Generic helper: run a function inside the lably iframe
async function runInLablyFrame(func, args = []) {
  const { tabId, frameId } = await getLablyFrame();

  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: "MAIN",
    func,
    args,
  });

  const res = results?.[0]?.result;
  if (res?.error) throw new Error(res.error);
  return res;
}

// ===========================================================================
// API CALLS — all run inside the lably iframe (same-origin to lably)
// ===========================================================================
async function fetchAllItemsViaIframe(idToken, store) {
  console.log("[Lably SP] fetchAllItemsViaIframe()");
  return runInLablyFrame(
    async (idToken, store) => {
      try {
        const params = new URLSearchParams({
          embedded: "1",
          id_token: idToken,
          locale: "en",
          shop: store + ".myshopify.com",
          _data: "routes/_app+/_index",
        });
        const r = await fetch("/?" + params, {
          headers: {
            Accept: "*/*",
            Authorization: "Bearer " + idToken,
            "X-Requested-With": "XMLHttpRequest",
          },
        });
        if (!r.ok) return { error: "HTTP " + r.status };
        const data = await r.json();
        return { items: data.allItems || data.items || [] };
      } catch (e) {
        return { error: e.message };
      }
    },
    [idToken, sessionData.store]
  );
}

async function fetchItemDataViaIframe(editorId, idToken) {
  console.log("[Lably SP] fetchItemDataViaIframe:", editorId);
  return runInLablyFrame(
    async (editorId, idToken) => {
      try {
        const r = await fetch(
          "/editor/" + editorId + "?_data=routes%2F_app%2B%2Feditor%2B%2F%24id",
          {
            headers: {
              Accept: "*/*",
              Authorization: "Bearer " + idToken,
              "X-Requested-With": "XMLHttpRequest",
            },
          }
        );
        if (!r.ok) return { error: "HTTP " + r.status };
        const data = await r.json();
        console.log("[Lably iframe] fetchItem response keys:", JSON.stringify(Object.keys(data)));
        // Handle Remix DataWithResponseInit wrapper
        const actual = data.data !== undefined ? data.data : data;
        const item = actual?.item || actual;
        return { item: item };
      } catch (e) {
        return { error: e.message };
      }
    },
    [editorId, idToken]
  );
}

async function updateItemViaIframe(editorId, mongoId, idToken, fullSettings, store) {
  console.log("[Lably SP] updateItemViaIframe:", editorId, "mongoId:", mongoId);
  return runInLablyFrame(
    async (editorId, mongoId, idToken, fullSettings, store) => {
      try {
        const params = new URLSearchParams({
          embedded: "1",
          fullscreen: "1",
          id_token: idToken,
          shop: store + ".myshopify.com",
          _data: "routes/_app+/editor+/$id",
        });
        const r = await fetch("/editor/" + editorId + "?" + params, {
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
        if (!r.ok) return { error: "HTTP " + r.status };
        return { ok: true, status: r.status };
      } catch (e) {
        return { error: e.message };
      }
    },
    [editorId, mongoId, idToken, fullSettings, sessionData.store]
  );
}

async function createItemViaIframe(idToken, itemData, store) {
  console.log("[Lably SP] createItemViaIframe:", itemData.name);
  return runInLablyFrame(
    async (idToken, itemData, store) => {
      try {
        const r = await fetch("/editor/new", {
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
        if (!r.ok) return { error: "HTTP " + r.status };
        return { ok: true, status: r.status };
      } catch (e) {
        return { error: e.message };
      }
    },
    [idToken, itemData, sessionData.store]
  );
}

// ===========================================================================
// LOAD ITEMS
// ===========================================================================
async function loadItems() {
  if (busy) return;
  busy = true;
  console.log("[Lably SP] loadItems()");
  itemsList.innerHTML =
    '<div class="empty-state"><div class="spinner" style="border-color:var(--border);border-top-color:var(--selected-border);width:20px;height:20px;margin:0 auto 8px"></div>Loading items...</div>';

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
    const selector = item.settings?.position?.selector;
    const visibility = item.settings?.visibility || [];

    const bgColor = item.settings?.styles?.font?.color?.background || "#E23737";
    const textColor = item.settings?.styles?.font?.color?.text || "#ffffff";
    const textValue = item.textValue?.original || (item.type === "badge" ? "Sale" : "Label");

    const hasWeekSchedule = (item.settings?.weekSchedule || []).some((s) => s !== null);
    const hasDisplayPeriod = item.settings?.displayPeriod?.allTime === false;
    const displayConditionType = item.settings?.displayCondition?.type || "any";

    const featureTags = [];
    if (visibility.length > 0) featureTags.push("VOP");
    if (hasWeekSchedule) featureTags.push("WS");
    if (hasDisplayPeriod) featureTags.push("DP");
    if (displayConditionType !== "any") featureTags.push("DC");

    const featureTagsHtml = featureTags.map((t) => `<span class="item-tag">${t}</span>`).join("");

    html += `
      <div class="item-card ${isSelected ? "selected" : ""}" data-id="${esc(item.id)}">
        <div class="item-card-top">
          <input type="checkbox" class="item-checkbox" data-id="${esc(item.id)}" ${isSelected ? "checked" : ""}>
          <div class="item-preview" style="background:${esc(bgColor)};color:${esc(textColor)}">
            ${esc(textValue.length > 6 ? textValue.substring(0, 5) + ".." : textValue)}
          </div>
          <div class="item-details">
            <div class="item-header">
              <span class="item-name">${esc(item.name)}</span>
              <span class="item-time">${esc(timeAgo)}</span>
            </div>
            <div class="item-id">
              #${esc(item.id)}
              <span class="item-status ${item.status}">${esc(item.status)}</span>
            </div>
            <div class="item-tags">${featureTagsHtml}</div>
            ${selector ? `<div class="item-selector">
                <span class="item-selector-text">${esc(selector)}</span>
                <button class="item-selector-copy" data-copy="${esc(selector)}" title="Copy selector">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>
              </div>` : ""}
          </div>
        </div>
        <div class="item-type-badge type-${esc(item.type)}">${item.type === "badge" ? "B" : "L"}</div>
      </div>
    `;
  }

  itemsList.innerHTML = html;

  // Select all
  document.getElementById("select-all")?.addEventListener("change", (e) => {
    if (e.target.checked) {
      filteredItems.forEach((i) => selectedIds.add(i.id));
    } else {
      filteredItems.forEach((i) => selectedIds.delete(i.id));
    }
    renderItems();
    updateButtonStates();
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

  // Card click
  itemsList.querySelectorAll(".item-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest(".item-checkbox") || e.target.closest(".item-selector-copy")) return;
      const id = card.dataset.id;
      if (selectedIds.has(id)) selectedIds.delete(id);
      else selectedIds.add(id);
      renderItems();
      updateButtonStates();
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
}

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
// UPDATE — fetches full item data & updates via lably iframe
// ===========================================================================
btnUpdateLabels.addEventListener("click", () => openUpdateModal("label"));
btnUpdateBadges.addEventListener("click", () => openUpdateModal("badge"));

function openUpdateModal(mode) {
  currentUpdateMode = mode;
  const typeLabel = mode === "label" ? "Labels" : "Badges";
  modalTitle.textContent = `Update ${typeLabel}`;

  const targetItems = allItems.filter((i) => {
    if (i.type !== mode) return false;
    return selectedIds.size === 0 || selectedIds.has(i.id);
  });

  if (targetItems.length === 0) {
    showToast(`No ${typeLabel.toLowerCase()} ${selectedIds.size > 0 ? "selected" : "found"}.`, "error");
    return;
  }

  modalBody.innerHTML = `
    <p style="font-size:12px;color:var(--text-secondary);margin-bottom:16px">
      Updating <strong>${targetItems.length}</strong> ${typeLabel.toLowerCase()}${selectedIds.size > 0 ? " (from selection)" : ""}.
      Only filled fields will be changed.
    </p>
    <div class="form-section">
      <div class="form-section-title">Position</div>
      <div class="form-group">
        <label class="form-label">Selector</label>
        <input type="text" class="form-input" id="field-selector" placeholder="e.g., .product-title, #price-block">
      </div>
      ${mode === "badge" ? `
      <div class="form-checkbox-row">
        <input type="checkbox" id="field-isCustom">
        <label for="field-isCustom">Use custom position</label>
      </div>` : ""}
    </div>
    <div class="form-section muted">
      <div class="form-section-title">Name Transformation</div>
      <p class="form-help" style="margin-bottom:8px">Removes " (copy)" from names and appends your text.</p>
      <div class="form-group">
        <label class="form-label">Text to Append</label>
        <input type="text" class="form-input" id="field-name-append" placeholder='e.g., v2'>
        <p class="form-help">Leave empty to skip name transformation.</p>
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
  const selectorVal = document.getElementById("field-selector")?.value.trim();
  const isCustomEl = document.getElementById("field-isCustom");
  const nameAppend = document.getElementById("field-name-append")?.value.trim();

  const hasSelector = !!selectorVal;
  const hasIsCustom = isCustomEl ? isCustomEl.checked : false;
  const hasNameTransform = !!nameAppend;

  if (!hasSelector && !hasNameTransform && !hasIsCustom) {
    showToast("No changes to apply.", "error");
    return;
  }

  const targetItems = allItems.filter((i) => {
    if (i.type !== currentUpdateMode) return false;
    return selectedIds.size === 0 || selectedIds.has(i.id);
  });

  if (targetItems.length === 0) {
    showToast("No items to update.", "error");
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
        // Use already-loaded item data as the base (no re-fetch needed)
        const backendSettings = JSON.parse(JSON.stringify(item));

        const changes = {};

        if (hasSelector) {
          if (!changes.settings) changes.settings = {};
          if (!changes.settings.position) changes.settings.position = {};
          changes.settings.position.selector = selectorVal;
        }

        if (hasIsCustom) {
          if (!changes.settings) changes.settings = {};
          if (!changes.settings.position) changes.settings.position = {};
          if (!changes.settings.position.badge) changes.settings.position.badge = {};
          changes.settings.position.badge.isCustom = true;
          changes.settings.position.badge.default = "custom";
        }

        if (hasNameTransform) {
          let baseName = backendSettings.name.replace(/\s*\(copy\)\s*$/i, "");
          changes.name = `${baseName} ${nameAppend}`;
        }

        const merged = deepMerge(backendSettings, changes);

        console.log('FFFFFFFF', merged)

        await updateItemViaIframe(item.id, item._id, idToken, merged, sessionData.store);
        successCount++;
        console.log("[Lably SP] Updated:", item.id, item.name);
      } catch (err) {
        console.error("[Lably SP] Update failed:", item.id, err);
        failCount++;
      }
    }

    showToast(
      `Update: ${successCount} success, ${failCount} failed`,
      failCount > 0 ? "error" : "success"
    );
    busy = false;
    await loadItems();
  } catch (err) {
    showToast("Update failed: " + err.message, "error");
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
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.textContent = message;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 200);
  }, 3000);
}

// ===========================================================================
// START
// ===========================================================================
init();
