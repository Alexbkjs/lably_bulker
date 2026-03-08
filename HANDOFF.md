# Handoff - Lably Bulker Sessions 2-5

## Session 2: UI Overhaul

### Shape-aware card previews
- Labels/badges render with correct shape (rectangle, circle, parallelogram, tag, ribbon, trapezoid, triangle, chevron) via clip-path/transform
- Trapezoid shapes map to corner triangles matching the app's actual rendering
- Preview shows tooltip with full text value on hover

### Status indicators
- All 4 tags (VoP, WS, DP, DC) display with ok/warning states and hover tooltips
- Logic ported from sel_lably's StatusIndicator.tsx

### Card interaction
- Card click toggles advanced mode panel (not selection)
- Checkbox is the only way to select/deselect items
- No puzzle icon — panel opens/closes directly on card body click

### Inline editing
- Selector: click to edit, changes propagate to all selected items
- Name: clickable when 2+ items selected, opens rename modal (strips all "(copy)" globally, optional append)

### Draft styling
- Draft items show greyed title + "DRAFT" corner badge inside card
- Badge "B" corner tag for badge-type items only; when both exist, DRAFT shifts left

### Advanced mode panel
- Per-device tabs (Desktop/Tablet/Mobile)
- Font-size with px/rem/em unit selector
- Width/Height with shared px/% unit selector (aligned in same header row)
- Padding (T/R/B/L) with px/% unit selector
- Margin (T/R/B/L) with px/% unit selector
- Visibility on Pages checkboxes (HP, PP, SRP, CP, CaP, OP)
- Responsive labels: full names on wide panels, abbreviations on narrow
- All changes propagate to selected items on bulk save

## Session 3: Auto-sync, Fixes & Polish

### Auto-sync (webRequest)
- `chrome.webRequest.onCompleted` in background.js listens for POST to `*://lably.devit.software/*`
- Sends `lably-mutation` to sidepanel which debounces (1s min) and throttles (2s between syncs)
- `lastSyncTime` tracks last sync completion; auto-sync won't fire if less than 2s elapsed
- `busy` flag prevents auto-sync during own operations

### Store switch resync
- session-details handler compares previous store name with new; triggers loadItems() on change

### Lably frame retry
- `getLablyFrame()` retries 5 times (1s apart) before showing error, allowing iframe to load

### Badge custom position
- Setting custom selector for badge now sets both `position.isCustom = true` AND `position.badge.isCustom = true` plus `position.badge.default = "custom"`

### Button styles
- Export/Import: pill shape (border-radius:50px), gradient, shadow drops on hover, opacity on active
- Removed glass overlay for these buttons

### Toast redesign
- Dark card (#2d3748) with colored bottom border per type
- Icon circle (checkmark/X/i) on left, message text, "Close" button on right
- Auto-dismisses after 4s

### Loading state
- Spinner and "Loading items..." text centered horizontally via flexbox row

## Session 5: Advanced Panel — Spread Toggle & Data Path Fixes

### 1:N spread toggle
- Added `buildSpreadToggle()` — renders a `1`/`N` button next to each unit tab group (font-size, width/height, padding, margin)
- Tooltip explains current mode: "Applying to current screen size only" vs "Applying to all screen sizes"
- Switching 1→N copies current device values (with desktop fallback) to all three devices
- In N mode, editing any field writes to all devices simultaneously
- For padding/margin in N mode, changing one side also spreads all other sides from the current device to all devices
- Spread state stored as `fontSizeSpread`, `sizeSpread`, `paddingSpread`, `marginSpread` booleans in `pendingAdvancedEdits`
- Not added to Visibility on Pages (per spec)

### Data path corrections
- Width/Height read from `settings.styles.sizes` (not `size`) with fallback to `settings.styles.size`
- Margin read from `settings.position.margin` (not `styles.margin`) with fallback to `settings.styles.margin`
- Padding remains at `settings.styles.font.padding`

### Desktop fallback for empty devices
- All value getters (font-size, width, height, padding sides, margin sides) chain `?? ...desktop` fallback
- If tablet/mobile have no values, desktop values display instead of empty inputs

### Visibility on Pages overhaul
- Removed `VISIBILITY_SHORT`, `ALL_PAGE_CODES`, `PAGE_NAMES`, `FULL_NAME_TO_CODE` constants
- Now stores and reads full page name strings directly: "Home Page", "Product Pages", "Search Results Pages", "Cart Page", "Collection Pages", "Other Pages"
- Section is collapsible (collapsed by default) with arrow toggle

### Unit switch triggers save
- `hasAdvancedEdits()` now returns `true` when any unit key (`fontSizeUnit`, `sizeUnit`, `paddingUnit`, `marginUnit`) is set
- Previously these were in the skip list, so changing unit alone wouldn't enable Save

### Propagate to selected in N mode
- When editing padding/margin sides in N mode with multiple items selected, other sides are also spread to all devices for each selected item (using each item's own data for fallback values)

## State tracking
- `pendingSelectorEdits` — `{ itemId: newSelectorValue }`
- `pendingAdvancedEdits` — `{ itemId: { fontSize, width, height, padding, margin, visibility, *Unit, *Spread, _device } }`
- `advancedOpenIds` — Set of card IDs with advanced panel open
- `selectedIds` — Set of selected item IDs for bulk operations
- `busy` — prevents feedback loops during async operations
- `lastSyncTime` — timestamp of last loadItems completion, for throttling
- `autoSyncTimer` — debounce timer for mutation auto-sync

## Key files changed
- `manifest.json` — Added `webRequest` permission
- `background.js` — Added webRequest mutation listener
- `inject.js` — Unchanged (mutations caught by webRequest instead)
- `content.js` — Added lably-mutation forwarding (unused now, kept for future)
- `sidepanel.html` — Sync button in header, removed update buttons
- `sidepanel.css` — Full restyle: button pills, toast redesign, advanced panel, visibility grid, size header alignment, draft/badge corners
- `sidepanel.js` — Auto-sync, store switch, frame retry, advanced panel with visibility, badge isCustom fix, throttling, toast redesign
