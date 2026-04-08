# Manual Tab Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shield (🛡) button to each tab row in the popup that manually protects a tab from auto-closing for the current browser session.

**Architecture:** Session-scoped protection state is stored in `chrome.storage.session` (auto-cleared on browser close). The service worker skips protected tabs during TTL checks and grace-period closes. The popup renders a toggleable shield button per tab, moving protected tabs to the Protected section.

**Tech Stack:** Chrome Extension MV3, `chrome.storage.session`, vanilla JS ES modules, CSS custom properties.

---

## File Map

| File | Change |
|------|--------|
| `utils/storage.js` | Add `getManuallyProtected` / `saveManuallyProtected` helpers |
| `background/service-worker.js` | Skip manually protected tabs in `checkTabTTLs` and `closeTabAfterGrace`; clean up on `tabs.onRemoved`; add `TOGGLE_PROTECT_TAB` handler; include flag in `getTabInfo` |
| `popup/popup.css` | Add `.btn-protect` and `.btn-protect.active` styles |
| `popup/popup.js` | Render shield button per tab; attach toggle handler; add `onProtect` function |

---

### Task 1: Add storage helpers for manually protected tabs

**Files:**
- Modify: `utils/storage.js`

- [ ] **Step 1: Add the two helpers at the end of `utils/storage.js`**

Append after the `saveAnalyticsState` export:

```js
// ─── Manually protected tabs (session, tab-id set) ────────────────────────────

export async function getManuallyProtected() {
  const { manuallyProtected = [] } = await chrome.storage.session.get('manuallyProtected');
  return new Set(manuallyProtected);
}

export async function saveManuallyProtected(set) {
  await chrome.storage.session.set({ manuallyProtected: [...set] });
}
```

- [ ] **Step 2: Commit**

```bash
git add utils/storage.js
git commit -m "feat: add getManuallyProtected/saveManuallyProtected storage helpers"
```

---

### Task 2: Update service worker — TTL check, grace close, cleanup, toggle handler, getTabInfo

**Files:**
- Modify: `background/service-worker.js`

- [ ] **Step 1: Import the new helpers**

In `background/service-worker.js`, update the import from `../utils/storage.js` to include the two new helpers:

```js
import {
  getSettings,
  getAllowlist,
  getBlocklist,
  getPerDomainTTL,
  getTabLastAccessed, saveTabLastAccessed,
  getSnoozed, saveSnoozed,
  getClosedTabs, saveClosedTabs,
  getPendingGrace, savePendingGrace,
  getAnalyticsLog, saveAnalyticsLog,
  getAnalyticsState, saveAnalyticsState,
  getManuallyProtected, saveManuallyProtected,
} from '../utils/storage.js';
```

- [ ] **Step 2: Skip manually protected tabs in `checkTabTTLs`**

In `checkTabTTLs`, add `getManuallyProtected()` to the `Promise.all` fetch block and add a guard after the pinned check.

Replace this block (lines 113–121):

```js
  const [allowlist, blocklist, perDomainTTL, lastAccessed, snoozed, pendingGrace] =
    await Promise.all([
      getAllowlist(),
      getBlocklist(),
      getPerDomainTTL(),
      getTabLastAccessed(),
      getSnoozed(),
      getPendingGrace(),
    ]);
```

With:

```js
  const [allowlist, blocklist, perDomainTTL, lastAccessed, snoozed, pendingGrace, manuallyProtected] =
    await Promise.all([
      getAllowlist(),
      getBlocklist(),
      getPerDomainTTL(),
      getTabLastAccessed(),
      getSnoozed(),
      getPendingGrace(),
      getManuallyProtected(),
    ]);
```

Then add a guard immediately after the `if (tab.pinned) continue;` line (line 132):

```js
    if (tab.pinned) continue;                    // Never close pinned tabs
    if (manuallyProtected.has(tab.id)) continue; // Never close manually protected tabs
```

- [ ] **Step 3: Guard `closeTabAfterGrace` against manually protected tabs**

In `closeTabAfterGrace`, after the existing last-second guard on line 218:

```js
    if (tab.active || tab.pinned) return; // Last-second protection
```

Add:

```js
    if (tab.active || tab.pinned) return; // Last-second protection
    const manuallyProtected = await getManuallyProtected();
    if (manuallyProtected.has(tabId)) return;
```

- [ ] **Step 4: Clean up manually protected state when a tab is removed**

In `tabs.onRemoved` handler (around line 71), add cleanup after the snoozed cleanup:

```js
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const lastAccessed = await getTabLastAccessed();
  delete lastAccessed[tabId];
  await saveTabLastAccessed(lastAccessed);

  const snoozed = await getSnoozed();
  delete snoozed[tabId];
  await saveSnoozed(snoozed);

  const manuallyProtected = await getManuallyProtected();
  if (manuallyProtected.has(tabId)) {
    manuallyProtected.delete(tabId);
    await saveManuallyProtected(manuallyProtected);
  }

  await cancelGrace(tabId, /* removeFromHistory */ false);
});
```

- [ ] **Step 5: Add `TOGGLE_PROTECT_TAB` message handler**

In `handleMessage`, add a new case before `default`:

```js
    case 'TOGGLE_PROTECT_TAB': {
      const set = await getManuallyProtected();
      const isNowProtected = !set.has(message.tabId);
      isNowProtected ? set.add(message.tabId) : set.delete(message.tabId);
      await saveManuallyProtected(set);
      return { protected: isNowProtected };
    }
```

- [ ] **Step 6: Include `manuallyProtected` flag in `getTabInfo`**

In `getTabInfo`, fetch `manuallyProtected` alongside the other reads:

```js
  const [settings, lastAccessed, snoozed, pendingGrace, manuallyProtected] = await Promise.all([
    getSettings(),
    getTabLastAccessed(),
    getSnoozed(),
    getPendingGrace(),
    getManuallyProtected(),
  ]);
```

Then in the `.map` per tab, update `isProtected` and add `manuallyProtected`:

```js
    const isManuallyProtected = manuallyProtected.has(tab.id);
    const isProtected = tab.pinned || activeTabIds.has(tab.id) || isManuallyProtected;
```

And include both in the returned tab object:

```js
      isProtected,
      manuallyProtected: isManuallyProtected,
```

- [ ] **Step 7: Commit**

```bash
git add background/service-worker.js
git commit -m "feat: skip manually protected tabs in TTL checks; add TOGGLE_PROTECT_TAB handler"
```

---

### Task 3: Add shield button styles to popup CSS

**Files:**
- Modify: `popup/popup.css`

- [ ] **Step 1: Add `.btn-protect` styles**

After the `.btn-small.btn-undo:hover` rule (line 237), add:

```css
.btn-small.btn-protect {
  padding: 3px 6px;
  font-size: 13px;
  line-height: 1;
}
.btn-small.btn-protect.active {
  border-color: var(--success);
  color: var(--success);
  background: rgba(129,201,149,.10);
}
.btn-small.btn-protect.active:hover {
  background: rgba(129,201,149,.20);
}
```

- [ ] **Step 2: Commit**

```bash
git add popup/popup.css
git commit -m "feat: add shield button styles for manual tab protection"
```

---

### Task 4: Wire up shield button in popup JS

**Files:**
- Modify: `popup/popup.js`

- [ ] **Step 1: Update `renderTabItem` action slot**

Replace the existing `actionHtml` block (lines 128–133):

```js
  let actionHtml = '';
  if (tab.inGrace) {
    actionHtml = `<button class="btn-small btn-undo" data-undo="${tab.id}">Undo</button>`;
  } else if (!tab.isProtected) {
    actionHtml = `<button class="btn-small" data-snooze="${tab.id}" title="Snooze for ${settings.snoozeMinutes} min">+${settings.snoozeMinutes}m</button>`;
  }
```

With:

```js
  let actionHtml = '';
  if (tab.inGrace) {
    actionHtml = `<button class="btn-small btn-undo" data-undo="${tab.id}">Undo</button>`;
  } else if (tab.manuallyProtected) {
    actionHtml = `<button class="btn-small btn-protect active" data-protect="${tab.id}" title="Unprotect tab">🛡</button>`;
  } else if (!tab.isProtected) {
    actionHtml = `
      <button class="btn-small btn-protect" data-protect="${tab.id}" title="Protect tab">🛡</button>
      <button class="btn-small" data-snooze="${tab.id}" title="Snooze for ${settings.snoozeMinutes} min">+${settings.snoozeMinutes}m</button>`;
  }
```

- [ ] **Step 2: Attach protect event listeners in `renderTabs`**

After the existing `querySelectorAll('[data-undo]')` block (line 113), add:

```js
  container.querySelectorAll('[data-protect]').forEach(btn => {
    btn.addEventListener('click', () => onProtect(parseInt(btn.dataset.protect, 10)));
  });
```

- [ ] **Step 3: Add `onProtect` handler**

After the `onUndo` function (line 188), add:

```js
async function onProtect(tabId) {
  await sendMessage({ type: 'TOGGLE_PROTECT_TAB', tabId });
  await load();
}
```

- [ ] **Step 4: Commit**

```bash
git add popup/popup.js
git commit -m "feat: add shield toggle button to popup tab rows"
```

---

### Task 5: Manual verification

- [ ] **Step 1: Load / reload the extension**

  1. Go to `chrome://extensions`
  2. Enable Developer Mode
  3. Click "Reload" on TabTTL (or load unpacked if first time)

- [ ] **Step 2: Verify shield button appears**

  Open the popup. Every tab in the Managed section should show a 🛡 button to the left of the +Nm snooze button.

- [ ] **Step 3: Verify protect toggles the tab to Protected section**

  Click 🛡 on any managed tab. The tab should immediately move to the **Protected** section and show a highlighted 🛡 button with a green `Protected` label.

- [ ] **Step 4: Verify unprotect works**

  Click the highlighted 🛡 on a manually protected tab. It should move back to Managed and the snooze button should reappear.

- [ ] **Step 5: Verify protection prevents auto-close**

  Set a very short TTL in Options (e.g. 10s), protect a tab, wait. The protected tab should not receive a grace notification or be closed. Unprotect it — it should then be eligible for closing after the TTL elapses.

- [ ] **Step 6: Verify session-only behavior**

  Protect a tab. Close and reopen Chrome. Open the popup — the tab should no longer show as manually protected.
