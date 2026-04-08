# Duplicate Tab Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-close older duplicate tabs (same URL minus fragment, same window) when a new tab opens or navigates to a matching URL.

**Architecture:** All logic lives in `background/service-worker.js`. A `normalizeUrlForDedup(url)` helper strips fragments. Immediate detection fires on `onCreated`/`onUpdated`; periodic sweep runs inside `checkTabTTLs()`. Existing protections (pinned, active, manually protected, snoozed, in grace) are respected.

**Tech Stack:** Chrome Extension (MV3), ES Modules, Vitest for tests

---

### Task 1: Update Chrome tabs.query mock to support windowId filtering

The existing `chrome.tabs.query` mock in `tests/setup.js` only filters by `active`. Duplicate detection needs `windowId` filtering.

**Files:**
- Modify: `tests/setup.js:47-53`

- [ ] **Step 1: Write a test to verify windowId filtering works**

In a temporary check — we'll verify this indirectly through integration tests in Task 4. Skip a standalone test; just update the mock.

- [ ] **Step 2: Update the query mock to support windowId**

In `tests/setup.js`, replace the `query` mock:

```js
query: vi.fn(async (filter) => {
  let result = [...tabs];
  if (filter && filter.active === true) {
    result = result.filter(t => t.active);
  }
  if (filter && filter.windowId != null) {
    result = result.filter(t => t.windowId === filter.windowId);
  }
  return result;
}),
```

- [ ] **Step 3: Run existing tests to verify no regressions**

Run: `npx vitest run`
Expected: All existing tests pass (the new filter only applies when `windowId` is provided).

- [ ] **Step 4: Commit**

```bash
git add tests/setup.js
git commit -m "test: add windowId filtering to chrome.tabs.query mock"
```

---

### Task 2: Add normalizeUrlForDedup helper and closeDuplicateTab function

**Files:**
- Modify: `background/service-worker.js` (add `normalizeUrlForDedup` after the `resolveTabTTL` function ~line 183, add `closeDuplicateTab` after that)

- [ ] **Step 1: Write failing tests for normalizeUrlForDedup and closeDuplicateTab**

Add a new describe block in `tests/unit/service-worker.test.js`. Since `normalizeUrlForDedup` is not exported, we test it indirectly through `closeDuplicateTab` behavior (which is triggered via the `onCreated` listener).

First, extract the `onCreatedHandler` alongside the existing listener extractions at the top of the test file. Replace the listener extraction block:

```js
let messageHandler;
let alarmHandler;
let onRemovedHandler;
let onCreatedHandler;
let onUpdatedHandler;

beforeEach(() => {
  resetAll();
});

const importPromise = import('../../background/service-worker.js').then(() => {
  messageHandler = chrome.runtime.onMessage.addListener.mock.calls[0][0];
  alarmHandler = chrome.alarms.onAlarm.addListener.mock.calls[0][0];
  onRemovedHandler = chrome.tabs.onRemoved.addListener.mock.calls[0][0];
  onCreatedHandler = chrome.tabs.onCreated.addListener.mock.calls[0][0];
  onUpdatedHandler = chrome.tabs.onUpdated.addListener.mock.calls[0][0];
});
```

Then add the import for `getRemovedTabIds`:

```js
import { setTabs, resetAll, getRemovedTabIds } from '../setup.js';
```

Then add the test block after the existing `describe` blocks:

```js
describe('duplicate tab detection', () => {
  it('closes older duplicate in same window on tab create', async () => {
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
      { id: 1, windowId: 10, url: 'https://example.com/page', pinned: false, active: false },
      { id: 2, windowId: 10, url: 'https://example.com/page', pinned: false, active: false },
    ]);

    // Simulate onCreated for tab 2 (the newer tab)
    await onCreatedHandler({ id: 2, windowId: 10, url: 'https://example.com/page' });

    expect(getRemovedTabIds()).toContain(1);
    expect(getRemovedTabIds()).not.toContain(2);
    vi.useRealTimers();
  });

  it('does not close duplicate in a different window', async () => {
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
      { id: 1, windowId: 10, url: 'https://example.com/page', pinned: false, active: false },
      { id: 2, windowId: 20, url: 'https://example.com/page', pinned: false, active: false },
    ]);

    await onCreatedHandler({ id: 2, windowId: 20, url: 'https://example.com/page' });

    expect(getRemovedTabIds()).toEqual([]);
    vi.useRealTimers();
  });

  it('treats URLs with different fragments as duplicates', async () => {
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
      { id: 1, windowId: 10, url: 'https://example.com/page#section1', pinned: false, active: false },
      { id: 2, windowId: 10, url: 'https://example.com/page#section2', pinned: false, active: false },
    ]);

    await onCreatedHandler({ id: 2, windowId: 10, url: 'https://example.com/page#section2' });

    expect(getRemovedTabIds()).toContain(1);
    vi.useRealTimers();
  });

  it('does not treat URLs with different query params as duplicates', async () => {
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
      { id: 1, windowId: 10, url: 'https://example.com/page?tab=stars', pinned: false, active: false },
      { id: 2, windowId: 10, url: 'https://example.com/page?tab=repos', pinned: false, active: false },
    ]);

    await onCreatedHandler({ id: 2, windowId: 10, url: 'https://example.com/page?tab=repos' });

    expect(getRemovedTabIds()).toEqual([]);
    vi.useRealTimers();
  });

  it('skips pinned duplicate tabs', async () => {
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
      { id: 1, windowId: 10, url: 'https://example.com/page', pinned: true, active: false },
      { id: 2, windowId: 10, url: 'https://example.com/page', pinned: false, active: false },
    ]);

    await onCreatedHandler({ id: 2, windowId: 10, url: 'https://example.com/page' });

    expect(getRemovedTabIds()).toEqual([]);
    vi.useRealTimers();
  });

  it('skips active duplicate tabs', async () => {
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
      { id: 1, windowId: 10, url: 'https://example.com/page', pinned: false, active: true },
      { id: 2, windowId: 10, url: 'https://example.com/page', pinned: false, active: false },
    ]);

    await onCreatedHandler({ id: 2, windowId: 10, url: 'https://example.com/page' });

    expect(getRemovedTabIds()).toEqual([]);
    vi.useRealTimers();
  });

  it('skips manually protected duplicate tabs', async () => {
    await importPromise;
    vi.useFakeTimers();
    vi.setSystemTime(2000);

    await chrome.storage.sync.set({
      settings: { enabled: true, ttl: 60000, mode: 'blocklist', idleDetection: false, gracePeriod: 10 },
    });
    await chrome.storage.session.set({ manuallyProtected: [1] });
    await chrome.storage.local.set({
      tabLastAccessed: { 1: 1000, 2: 2000 },
    });

    setTabs([
      { id: 1, windowId: 10, url: 'https://example.com/page', pinned: false, active: false },
      { id: 2, windowId: 10, url: 'https://example.com/page', pinned: false, active: false },
    ]);

    await onCreatedHandler({ id: 2, windowId: 10, url: 'https://example.com/page' });

    expect(getRemovedTabIds()).toEqual([]);
    vi.useRealTimers();
  });

  it('skips non-http URLs', async () => {
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
      { id: 1, windowId: 10, url: 'chrome://extensions', pinned: false, active: false },
      { id: 2, windowId: 10, url: 'chrome://extensions', pinned: false, active: false },
    ]);

    await onCreatedHandler({ id: 2, windowId: 10, url: 'chrome://extensions' });

    expect(getRemovedTabIds()).toEqual([]);
    vi.useRealTimers();
  });

  it('does nothing when disabled', async () => {
    await importPromise;
    await chrome.storage.sync.set({
      settings: { enabled: false },
    });
    await chrome.storage.local.set({
      tabLastAccessed: { 1: 1000, 2: 2000 },
    });

    setTabs([
      { id: 1, windowId: 10, url: 'https://example.com/page', pinned: false, active: false },
      { id: 2, windowId: 10, url: 'https://example.com/page', pinned: false, active: false },
    ]);

    await onCreatedHandler({ id: 2, windowId: 10, url: 'https://example.com/page' });

    expect(getRemovedTabIds()).toEqual([]);
  });

  it('logs closed duplicate to history and analytics', async () => {
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
      { id: 1, windowId: 10, url: 'https://example.com/page', title: 'Example', favIconUrl: 'icon.png', pinned: false, active: false },
      { id: 2, windowId: 10, url: 'https://example.com/page', title: 'Example', pinned: false, active: false },
    ]);

    await onCreatedHandler({ id: 2, windowId: 10, url: 'https://example.com/page' });

    const { closedTabs } = await chrome.storage.local.get('closedTabs');
    expect(closedTabs).toHaveLength(1);
    expect(closedTabs[0].tabId).toBe(1);
    expect(closedTabs[0].url).toBe('https://example.com/page');

    const { analyticsLog } = await chrome.storage.local.get('analyticsLog');
    expect(analyticsLog).toHaveLength(1);
    expect(analyticsLog[0].domain).toBe('example.com');
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/service-worker.test.js`
Expected: The new `duplicate tab detection` tests fail (onCreatedHandler doesn't call closeDuplicateTab yet, and the function doesn't exist).

- [ ] **Step 3: Add normalizeUrlForDedup to service-worker.js**

Add after the `resolveTabTTL` function (after line 183):

```js
/**
 * Strip the fragment from a URL for duplicate comparison.
 * Returns null for non-http(s) URLs.
 */
function normalizeUrlForDedup(url) {
  if (!url || !url.startsWith('http')) return null;
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Add closeDuplicateTab to service-worker.js**

Add after `normalizeUrlForDedup`:

```js
async function closeDuplicateTab(tabId) {
  const settings = await getSettings();
  if (!settings.enabled) return;

  let triggerTab;
  try {
    triggerTab = await chrome.tabs.get(tabId);
  } catch {
    return; // Tab already gone
  }

  const normalizedUrl = normalizeUrlForDedup(triggerTab.url);
  if (!normalizedUrl) return;

  const windowTabs = await chrome.tabs.query({ windowId: triggerTab.windowId });
  const [lastAccessed, snoozed, pendingGrace, manuallyProtected] = await Promise.all([
    getTabLastAccessed(),
    getSnoozed(),
    getPendingGrace(),
    getManuallyProtected(),
  ]);

  const activeTabs = await chrome.tabs.query({ active: true });
  const activeTabIds = new Set(activeTabs.map(t => t.id));
  const now = Date.now();

  const duplicates = windowTabs.filter(t => {
    if (t.id === tabId) return false;
    if (t.pinned) return false;
    if (activeTabIds.has(t.id)) return false;
    if (manuallyProtected.has(t.id)) return false;
    if (snoozed[t.id] && snoozed[t.id] > now) return false;
    if (pendingGrace[t.id]) return false;
    return normalizeUrlForDedup(t.url) === normalizedUrl;
  });

  for (const dup of duplicates) {
    const openedAt = lastAccessed[dup.id] ?? now;

    let domain = '';
    let ttlMs = 0;
    try {
      domain = new URL(dup.url).hostname;
      const perDomainTTL = await getPerDomainTTL();
      ttlMs = resolveTabTTL(dup.url, perDomainTTL, settings.ttl);
    } catch { /* ignore */ }

    await appendAnalyticsEvent({ ts: now, openedAt, domain, ttlMs, ageMs: now - openedAt });
    await addToClosedHistory({
      tabId: dup.id,
      url: dup.url,
      title: dup.title,
      favIconUrl: dup.favIconUrl,
      closedAt: now,
    });

    try {
      await chrome.tabs.remove(dup.id);
    } catch { /* tab already gone */ }
  }
}
```

- [ ] **Step 5: Wire closeDuplicateTab into onCreated listener**

Replace the existing `onCreated` listener (line 68-70):

```js
chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.id != null) {
    await updateLastAccessed(tab.id);
    await closeDuplicateTab(tab.id);
  }
});
```

- [ ] **Step 6: Wire closeDuplicateTab into onUpdated listener**

Replace the existing `onUpdated` listener (line 62-66):

```js
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'loading') {
    await updateLastAccessed(tabId);
  }
  if (changeInfo.url) {
    await closeDuplicateTab(tabId);
  }
});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/unit/service-worker.test.js`
Expected: All tests pass, including the new `duplicate tab detection` tests.

- [ ] **Step 8: Commit**

```bash
git add background/service-worker.js tests/unit/service-worker.test.js
git commit -m "feat: auto-close older duplicate tabs on create and URL change"
```

---

### Task 3: Add duplicate sweep to periodic checkTabTTLs

**Files:**
- Modify: `background/service-worker.js:109-170` (inside `checkTabTTLs`)
- Modify: `tests/unit/service-worker.test.js` (add periodic sweep tests)

- [ ] **Step 1: Write failing tests for periodic duplicate sweep**

Add to the `duplicate tab detection` describe block in `tests/unit/service-worker.test.js`:

```js
describe('periodic sweep via FORCE_CHECK', () => {
  it('closes older duplicate during periodic check', async () => {
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
      { id: 1, windowId: 10, url: 'https://example.com/page', title: 'Old', pinned: false, active: false },
      { id: 2, windowId: 10, url: 'https://example.com/page', title: 'New', pinned: false, active: false },
    ]);

    await sendMessage({ type: 'FORCE_CHECK' });

    expect(getRemovedTabIds()).toContain(1);
    expect(getRemovedTabIds()).not.toContain(2);
    vi.useRealTimers();
  });

  it('keeps both when older duplicate is pinned', async () => {
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
      { id: 1, windowId: 10, url: 'https://example.com/page', pinned: true, active: false },
      { id: 2, windowId: 10, url: 'https://example.com/page', pinned: false, active: false },
    ]);

    await sendMessage({ type: 'FORCE_CHECK' });

    expect(getRemovedTabIds()).toEqual([]);
    vi.useRealTimers();
  });

  it('does not close duplicates across different windows', async () => {
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
      { id: 1, windowId: 10, url: 'https://example.com/page', pinned: false, active: false },
      { id: 2, windowId: 20, url: 'https://example.com/page', pinned: false, active: false },
    ]);

    await sendMessage({ type: 'FORCE_CHECK' });

    expect(getRemovedTabIds()).toEqual([]);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/service-worker.test.js`
Expected: The `periodic sweep via FORCE_CHECK` tests fail.

- [ ] **Step 3: Add duplicate sweep logic to checkTabTTLs**

In `checkTabTTLs()`, add the sweep block after fetching `allTabs` (after line 132 `const allTabs = await chrome.tabs.query({});`) and before the `for (const tab of allTabs)` TTL loop. Insert:

```js
  // ── Duplicate tab sweep ──────────────────────────────────────────────────
  const dupMap = new Map(); // key: "windowId:normalizedUrl" → [tab, ...]
  for (const tab of allTabs) {
    if (tab.id == null) continue;
    const norm = normalizeUrlForDedup(tab.url ?? '');
    if (!norm) continue;
    const key = `${tab.windowId}:${norm}`;
    if (!dupMap.has(key)) dupMap.set(key, []);
    dupMap.get(key).push(tab);
  }

  for (const [, group] of dupMap) {
    if (group.length < 2) continue;
    const eligible = group.filter(t => {
      if (t.pinned) return false;
      if (activeTabIds.has(t.id)) return false;
      if (manuallyProtected.has(t.id)) return false;
      if (snoozed[t.id] && snoozed[t.id] > now) return false;
      if (pendingGrace[t.id]) return false;
      return true;
    });
    if (eligible.length < 2) continue;

    // Sort by lastAccessed descending — keep the most recent
    eligible.sort((a, b) => (lastAccessed[b.id] ?? 0) - (lastAccessed[a.id] ?? 0));
    const toClose = eligible.slice(1); // everything except the most recent

    for (const dup of toClose) {
      const openedAt = lastAccessed[dup.id] ?? now;
      let domain = '';
      let ttlMs = 0;
      try {
        domain = new URL(dup.url).hostname;
        ttlMs = resolveTabTTL(dup.url, perDomainTTL, settings.ttl);
      } catch { /* ignore */ }

      await appendAnalyticsEvent({ ts: now, openedAt, domain, ttlMs, ageMs: now - openedAt });
      await addToClosedHistory({
        tabId: dup.id,
        url: dup.url,
        title: dup.title,
        favIconUrl: dup.favIconUrl,
        closedAt: now,
      });

      try {
        await chrome.tabs.remove(dup.id);
      } catch { /* tab already gone */ }
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: All tests pass, including the new periodic sweep tests.

- [ ] **Step 5: Commit**

```bash
git add background/service-worker.js tests/unit/service-worker.test.js
git commit -m "feat: add periodic duplicate tab sweep to checkTabTTLs"
```

---

### Task 4: Add integration test for duplicate tab lifecycle

**Files:**
- Create: `tests/integration/duplicate-tabs.test.js`

- [ ] **Step 1: Write the integration test**

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setTabs, resetAll, getRemovedTabIds } from '../setup.js';

let messageHandler;
let onCreatedHandler;

beforeEach(() => {
  resetAll();
});

const importPromise = import('../../background/service-worker.js').then(() => {
  messageHandler = chrome.runtime.onMessage.addListener.mock.calls[0][0];
  onCreatedHandler = chrome.tabs.onCreated.addListener.mock.calls[0][0];
});

async function sendMessage(message) {
  await importPromise;
  return new Promise((resolve, reject) => {
    messageHandler(message, {}, (response) => {
      if (response?.error) reject(new Error(response.error));
      else resolve(response);
    });
  });
}

describe('duplicate tab lifecycle', () => {
  it('immediate close on create, then periodic sweep catches restored duplicate', async () => {
    await importPromise;
    vi.useFakeTimers();
    vi.setSystemTime(10000);

    // Setup: enabled, high TTL so no TTL-based closes
    await chrome.storage.sync.set({
      settings: { enabled: true, ttl: 99999999, mode: 'blocklist', idleDetection: false, gracePeriod: 10 },
    });
    await chrome.storage.sync.set({ blocklist: [] });

    // Phase 1: Tab 1 exists, tab 2 created as duplicate → tab 1 should close
    await chrome.storage.local.set({
      tabLastAccessed: { 1: 5000 },
    });
    setTabs([
      { id: 1, windowId: 10, url: 'https://example.com', title: 'Original', favIconUrl: '', pinned: false, active: false },
      { id: 2, windowId: 10, url: 'https://example.com', title: 'Duplicate', favIconUrl: '', pinned: false, active: false },
    ]);

    await onCreatedHandler({ id: 2, windowId: 10, url: 'https://example.com' });

    expect(getRemovedTabIds()).toContain(1);
    expect(getRemovedTabIds()).not.toContain(2);

    // Verify analytics and history logged
    const { closedTabs } = await chrome.storage.local.get('closedTabs');
    expect(closedTabs).toHaveLength(1);
    expect(closedTabs[0].tabId).toBe(1);

    const { analyticsLog } = await chrome.storage.local.get('analyticsLog');
    expect(analyticsLog).toHaveLength(1);

    // Phase 2: Simulate another duplicate appearing (e.g., session restore)
    // Reset removed list for clarity
    getRemovedTabIds().length = 0;
    vi.setSystemTime(20000);

    await chrome.storage.local.set({
      tabLastAccessed: { 2: 10000, 3: 15000 },
    });
    setTabs([
      { id: 2, windowId: 10, url: 'https://example.com', title: 'Kept', pinned: false, active: false },
      { id: 3, windowId: 10, url: 'https://example.com', title: 'Restored', pinned: false, active: false },
    ]);

    await sendMessage({ type: 'FORCE_CHECK' });

    expect(getRemovedTabIds()).toContain(2);
    expect(getRemovedTabIds()).not.toContain(3);

    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run tests/integration/duplicate-tabs.test.js`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/duplicate-tabs.test.js
git commit -m "test: add integration test for duplicate tab lifecycle"
```
