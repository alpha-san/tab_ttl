# Manual Tab Protection — Design Spec

**Date:** 2026-04-07  
**Status:** Approved

## Overview

Add a shield button (🛡) to each tab row in the popup that lets the user manually protect a tab from being auto-closed by TabTTL. Protection is session-only and toggled by clicking the same button.

## Behavior

- **Managed tabs** show a 🛡 button alongside the existing +Nm snooze button.
- Clicking 🛡 on a managed tab protects it and moves it to the **Protected** section.
- Protected tabs (manually protected) show a highlighted 🛡 button in the Protected section.
- Clicking the highlighted 🛡 unprotects the tab and moves it back to Managed.
- Protection is **session-only**: cleared automatically when the browser closes (`chrome.storage.session`).
- Native active and pinned tabs remain protected as before, with no shield button (cannot be unprotected from the popup).

## Data Layer

**Storage:** `chrome.storage.session` key `manuallyProtected` — an array of tab IDs.

Two helpers added to `utils/storage.js`:

```js
export async function getManuallyProtected() {
  const { manuallyProtected = [] } = await chrome.storage.session.get('manuallyProtected');
  return new Set(manuallyProtected);
}

export async function saveManuallyProtected(set) {
  await chrome.storage.session.set({ manuallyProtected: [...set] });
}
```

Tab IDs are used (not URLs) — consistent with all other per-tab state in the codebase, and correct since protection is for a specific tab instance.

**Cleanup:** `tabs.onRemoved` removes the tab ID from the set.

## Service Worker (`background/service-worker.js`)

1. **`checkTabTTLs`** — fetch `manuallyProtected` with the other storage reads; skip manually protected tabs:
   ```js
   if (manuallyProtected.has(tab.id)) continue;
   ```

2. **`closeTabAfterGrace`** — extend the last-second guard:
   ```js
   if (tab.active || tab.pinned) return;
   const manuallyProtected = await getManuallyProtected();
   if (manuallyProtected.has(tabId)) return;
   ```

3. **`TOGGLE_PROTECT_TAB` message handler:**
   ```js
   case 'TOGGLE_PROTECT_TAB': {
     const set = await getManuallyProtected();
     const isNowProtected = !set.has(message.tabId);
     isNowProtected ? set.add(message.tabId) : set.delete(message.tabId);
     await saveManuallyProtected(set);
     return { protected: isNowProtected };
   }
   ```

4. **`getTabInfo`** — include `manuallyProtected` flag per tab; update `isProtected`:
   ```js
   const isProtected = tab.pinned || activeTabIds.has(tab.id) || manuallyProtected.has(tab.id);
   ```

## Popup UI (`popup/popup.js` + `popup.css`)

**Action slot logic in `renderTabItem`:**

```js
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

**Event listener in `renderTabs`:**
```js
container.querySelectorAll('[data-protect]').forEach(btn => {
  btn.addEventListener('click', () => onProtect(parseInt(btn.dataset.protect, 10)));
});
```

**Handler:**
```js
async function onProtect(tabId) {
  await sendMessage({ type: 'TOGGLE_PROTECT_TAB', tabId });
  await load();
}
```

**CSS:** Add `.btn-protect.active` style to `popup.css` to visually highlight the shield when protection is active.

## Out of Scope

- Persistent protection across browser sessions
- URL/domain-based protection rules
- Protection visible in the options page
