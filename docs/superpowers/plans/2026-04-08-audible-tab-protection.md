# Audible Tab Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent TabTTL from closing tabs that are actively playing unmuted audio, treating them as immune like pinned tabs.

**Architecture:** Add `tab.audible && !tab.mutedInfo?.muted` checks to all tab-closing code paths in the service worker. Listen for `audible` changes in `onUpdated` to proactively cancel grace periods. Pass audible state through `getTabInfo()` to the popup for a speaker badge.

**Tech Stack:** Chrome Extensions MV3, Vitest

---

### Task 1: Add audible protection to TTL check loop

**Files:**
- Modify: `background/service-worker.js:197-227` (main TTL loop in `checkTabTTLs`)
- Test: `tests/unit/service-worker.test.js`

- [ ] **Step 1: Write the failing test — audible unmuted tab is skipped**

In `tests/unit/service-worker.test.js`, inside the `checkTabTTLs skip conditions (via FORCE_CHECK)` describe block, add:

```js
it('skips audible unmuted tabs', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000000);
  await chrome.storage.sync.set({
    settings: { enabled: true, ttl: 1000, mode: 'blocklist', idleDetection: false, gracePeriod: 10 },
  });
  await chrome.storage.sync.set({ blocklist: ['a.com'] });
  setTabs([
    { id: 1, url: 'https://a.com', pinned: false, active: false, audible: true, mutedInfo: { muted: false } },
  ]);
  await chrome.storage.local.set({ tabLastAccessed: { 1: 0 } });

  await sendMessage({ type: 'FORCE_CHECK' });
  expect(chrome.notifications.create).not.toHaveBeenCalled();
  vi.useRealTimers();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/service-worker.test.js --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — the tab is not yet skipped, so a grace notification is created.

- [ ] **Step 3: Write the failing test — audible muted tab is NOT skipped**

```js
it('does not skip audible but muted tabs', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000000);
  await chrome.storage.sync.set({
    settings: { enabled: true, ttl: 1000, mode: 'blocklist', idleDetection: false, gracePeriod: 10 },
  });
  await chrome.storage.sync.set({ blocklist: ['a.com'] });
  setTabs([
    { id: 1, url: 'https://a.com', pinned: false, active: false, audible: true, mutedInfo: { muted: true } },
  ]);
  await chrome.storage.local.set({ tabLastAccessed: { 1: 0 } });

  await sendMessage({ type: 'FORCE_CHECK' });
  expect(chrome.notifications.create).toHaveBeenCalled();
  vi.useRealTimers();
});
```

- [ ] **Step 4: Run test to verify it passes (this one should already pass since no code change yet)**

Run: `npx vitest run tests/unit/service-worker.test.js --reporter=verbose 2>&1 | tail -20`
Expected: The muted test passes (existing behavior), the unmuted test fails.

- [ ] **Step 5: Implement — add audible check to TTL loop**

In `background/service-worker.js`, in the `checkTabTTLs` function's main TTL loop (around line 200), add after the `if (manuallyProtected.has(tab.id)) continue;` line:

```js
if (tab.audible && !tab.mutedInfo?.muted) continue; // Never close audible unmuted tabs
```

- [ ] **Step 6: Run tests to verify both pass**

Run: `npx vitest run tests/unit/service-worker.test.js --reporter=verbose 2>&1 | tail -20`
Expected: Both new tests pass, all existing tests pass.

- [ ] **Step 7: Commit**

```bash
git add background/service-worker.js tests/unit/service-worker.test.js
git commit -m "feat: skip audible unmuted tabs in TTL check loop"
```

---

### Task 2: Add audible protection to dedup sweep in `checkTabTTLs`

**Files:**
- Modify: `background/service-worker.js:156-165` (dedup eligible filter in `checkTabTTLs`)
- Test: `tests/unit/service-worker.test.js`

- [ ] **Step 1: Write the failing test**

In `tests/unit/service-worker.test.js`, inside the `duplicate tab detection > periodic sweep via FORCE_CHECK` describe block, add:

```js
it('keeps audible unmuted duplicate during periodic check', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000000);

  await chrome.storage.sync.set({
    settings: { enabled: true, ttl: 99999999, mode: 'blocklist', idleDetection: false, gracePeriod: 10 },
  });
  await chrome.storage.sync.set({ blocklist: [] });
  await chrome.storage.local.set({
    tabLastAccessed: { 1: 500000, 2: 900000 },
  });

  setTabs([
    { id: 1, windowId: 10, url: 'https://example.com/page', title: 'Old', pinned: false, active: false, audible: true, mutedInfo: { muted: false } },
    { id: 2, windowId: 10, url: 'https://example.com/page', title: 'New', pinned: false, active: false },
  ]);

  await sendMessage({ type: 'FORCE_CHECK' });

  expect(getRemovedTabIds()).toEqual([]);
  vi.useRealTimers();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/service-worker.test.js --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — tab 1 is closed as a duplicate.

- [ ] **Step 3: Implement — add audible check to dedup eligible filter**

In `background/service-worker.js`, in the dedup `eligible` filter (around line 158-165), add after `if (pendingGrace[t.id]) return false;`:

```js
if (t.audible && !t.mutedInfo?.muted) return false;
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/unit/service-worker.test.js --reporter=verbose 2>&1 | tail -20`
Expected: New test passes, all existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add background/service-worker.js tests/unit/service-worker.test.js
git commit -m "feat: protect audible unmuted tabs from dedup sweep"
```

---

### Task 3: Add audible protection to `closeDuplicateTab`

**Files:**
- Modify: `background/service-worker.js:287-295` (duplicate filter in `closeDuplicateTab`)
- Test: `tests/unit/service-worker.test.js`

- [ ] **Step 1: Write the failing test**

In `tests/unit/service-worker.test.js`, inside the `duplicate tab detection` describe block (not the periodic sweep sub-describe), add:

```js
it('skips audible unmuted duplicate tabs on create', async () => {
  await importPromise;
  vi.useFakeTimers();
  vi.setSystemTime(2000);

  await chrome.storage.sync.set({
    settings: { enabled: true, ttl: 60000, mode: 'blocklist', idleDetection: false, gracePeriod: 10 },
  });
  await chrome.storage.local.set({
    tabLastAccessed: { 1: 1000, 2: 2000 },
  });

  setTabs([
    { id: 1, windowId: 10, url: 'https://example.com/page', pinned: false, active: false, audible: true, mutedInfo: { muted: false } },
    { id: 2, windowId: 10, url: 'https://example.com/page', pinned: false, active: false },
  ]);

  await onCreatedHandler({ id: 2, windowId: 10, url: 'https://example.com/page' });

  expect(getRemovedTabIds()).toEqual([]);
  vi.useRealTimers();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/service-worker.test.js --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — tab 1 is closed as a duplicate.

- [ ] **Step 3: Implement — add audible check to closeDuplicateTab filter**

In `background/service-worker.js`, in the `duplicates` filter inside `closeDuplicateTab` (around line 287-295), add after `if (pendingGrace[t.id]) return false;`:

```js
if (t.audible && !t.mutedInfo?.muted) return false;
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/unit/service-worker.test.js --reporter=verbose 2>&1 | tail -20`
Expected: New test passes, all existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add background/service-worker.js tests/unit/service-worker.test.js
git commit -m "feat: protect audible unmuted tabs from closeDuplicateTab"
```

---

### Task 4: Add audible protection to `closeTabAfterGrace`

**Files:**
- Modify: `background/service-worker.js:354-394` (`closeTabAfterGrace` function)
- Test: `tests/unit/service-worker.test.js`

- [ ] **Step 1: Write the failing test**

Add a new describe block in `tests/unit/service-worker.test.js`:

```js
describe('closeTabAfterGrace audible protection', () => {
  it('cancels grace close if tab became audible', async () => {
    await importPromise;
    vi.useFakeTimers();
    vi.setSystemTime(5000);

    await chrome.storage.sync.set({
      settings: { enabled: true, ttl: 1000, mode: 'blocklist', idleDetection: false, gracePeriod: 10 },
    });
    await chrome.storage.local.set({
      tabLastAccessed: { 1: 0 },
      pendingGrace: { 1: { tabId: 1, url: 'https://a.com', title: 'Test', closeAt: 5000 } },
    });

    setTabs([
      { id: 1, url: 'https://a.com', pinned: false, active: false, audible: true, mutedInfo: { muted: false } },
    ]);

    // Fire the grace alarm
    await alarmHandler({ name: 'tabTTL-grace-1' });

    // Tab should NOT have been removed
    expect(getRemovedTabIds()).toEqual([]);

    // Grace state should be cleared
    const { pendingGrace } = await chrome.storage.local.get('pendingGrace');
    expect(pendingGrace[1]).toBeUndefined();

    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/service-worker.test.js --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — tab is removed because `closeTabAfterGrace` doesn't check audible state.

- [ ] **Step 3: Implement — add audible check to closeTabAfterGrace**

In `background/service-worker.js`, in `closeTabAfterGrace`, after the existing `if (tab.active || tab.pinned) return;` check (around line 365), add:

```js
if (tab.audible && !tab.mutedInfo?.muted) return; // Tab started playing — don't close
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/unit/service-worker.test.js --reporter=verbose 2>&1 | tail -20`
Expected: New test passes, all existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add background/service-worker.js tests/unit/service-worker.test.js
git commit -m "feat: cancel grace close if tab became audible"
```

---

### Task 5: Proactive grace cancellation via `onUpdated`

**Files:**
- Modify: `background/service-worker.js:62-69` (`onUpdated` listener)
- Test: `tests/unit/service-worker.test.js`

- [ ] **Step 1: Write the failing test**

Add a new describe block in `tests/unit/service-worker.test.js`:

```js
describe('onUpdated audible grace cancellation', () => {
  it('cancels grace and resets TTL when tab becomes audible', async () => {
    await importPromise;
    vi.useFakeTimers();
    vi.setSystemTime(5000);

    await chrome.storage.local.set({
      tabLastAccessed: { 1: 0 },
      pendingGrace: { 1: { tabId: 1, url: 'https://a.com', title: 'Test', closeAt: 6000 } },
    });

    setTabs([
      { id: 1, url: 'https://a.com', pinned: false, active: false, audible: true, mutedInfo: { muted: false } },
    ]);

    // Simulate the onUpdated event with audible change
    await onUpdatedHandler(1, { audible: true });

    // Grace should be cancelled
    const { pendingGrace } = await chrome.storage.local.get('pendingGrace');
    expect(pendingGrace[1]).toBeUndefined();

    // lastAccessed should be reset
    const { tabLastAccessed } = await chrome.storage.local.get('tabLastAccessed');
    expect(tabLastAccessed[1]).toBe(5000);

    vi.useRealTimers();
  });

  it('does not cancel grace when muted tab becomes audible', async () => {
    await importPromise;
    vi.useFakeTimers();
    vi.setSystemTime(5000);

    await chrome.storage.local.set({
      tabLastAccessed: { 1: 0 },
      pendingGrace: { 1: { tabId: 1, url: 'https://a.com', title: 'Test', closeAt: 6000 } },
    });

    setTabs([
      { id: 1, url: 'https://a.com', pinned: false, active: false, audible: true, mutedInfo: { muted: true } },
    ]);

    await onUpdatedHandler(1, { audible: true });

    // Grace should still be pending (tab is muted)
    const { pendingGrace } = await chrome.storage.local.get('pendingGrace');
    expect(pendingGrace[1]).toBeDefined();

    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/service-worker.test.js --reporter=verbose 2>&1 | tail -20`
Expected: Both tests fail — no `audible` handling in `onUpdated` yet.

- [ ] **Step 3: Implement — add audible handler to onUpdated**

In `background/service-worker.js`, in the `chrome.tabs.onUpdated.addListener` callback (around line 62-69), add a new branch:

```js
if (changeInfo.audible) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.audible && !tab.mutedInfo?.muted) {
      await cancelGrace(tabId);
      await updateLastAccessed(tabId);
    }
  } catch { /* tab gone */ }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/unit/service-worker.test.js --reporter=verbose 2>&1 | tail -20`
Expected: Both new tests pass, all existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add background/service-worker.js tests/unit/service-worker.test.js
git commit -m "feat: proactively cancel grace when tab starts playing audio"
```

---

### Task 6: Expose audible state in `getTabInfo` and popup UI

**Files:**
- Modify: `background/service-worker.js:539-585` (`getTabInfo` function)
- Modify: `popup/popup.js:120-157` (`renderTabItem` function)
- Modify: `popup/popup.css` (add badge style)
- Test: `tests/unit/service-worker.test.js`

- [ ] **Step 1: Write the failing test**

In `tests/unit/service-worker.test.js`, inside the `handleMessage` describe block, add:

```js
it('GET_TAB_INFO marks audible unmuted tab as protected', async () => {
  setTabs([
    { id: 1, windowId: 1, index: 0, title: 'Music', url: 'https://spotify.com', pinned: false, active: false, audible: true, mutedInfo: { muted: false } },
  ]);
  const result = await sendMessage({ type: 'GET_TAB_INFO' });
  expect(result.tabs[0].audible).toBe(true);
  expect(result.tabs[0].isProtected).toBe(true);
});

it('GET_TAB_INFO does not mark audible muted tab as protected', async () => {
  setTabs([
    { id: 1, windowId: 1, index: 0, title: 'Music', url: 'https://spotify.com', pinned: false, active: false, audible: true, mutedInfo: { muted: true } },
  ]);
  const result = await sendMessage({ type: 'GET_TAB_INFO' });
  expect(result.tabs[0].audible).toBe(false);
  expect(result.tabs[0].isProtected).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/service-worker.test.js --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `audible` property not returned, `isProtected` does not account for audible.

- [ ] **Step 3: Implement — update getTabInfo**

In `background/service-worker.js`, in the `getTabInfo` function, update the tab mapping (around line 554-582):

After `const isManuallyProtected = manuallyProtected.has(tab.id);`, add:

```js
const isAudible = tab.audible && !tab.mutedInfo?.muted;
```

Update the `isProtected` line to include `isAudible`:

```js
const isProtected = tab.pinned || activeTabIds.has(tab.id) || isManuallyProtected || isAudible;
```

Add `audible: isAudible,` to the returned object (after `manuallyProtected: isManuallyProtected,`).

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/unit/service-worker.test.js --reporter=verbose 2>&1 | tail -20`
Expected: Both new tests pass, all existing tests pass.

- [ ] **Step 5: Add audible badge to popup**

In `popup/popup.js`, in the `renderTabItem` function, add after the `if (tab.inGrace)` badge line (around line 129):

```js
if (tab.audible)   badges.push('<span class="badge badge-audible">Playing</span>');
```

- [ ] **Step 6: Add badge style to popup CSS**

In `popup/popup.css`, after the existing `.badge-grace` line (around line 204), add:

```css
.badge-audible { background: rgba(187,134,252,.15); color: #bb86fc; }
```

- [ ] **Step 7: Run all tests to verify nothing is broken**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -30`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add background/service-worker.js popup/popup.js popup/popup.css tests/unit/service-worker.test.js
git commit -m "feat: show audible badge in popup and mark audible tabs as protected"
```
