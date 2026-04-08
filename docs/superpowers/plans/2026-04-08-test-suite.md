# Test Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add unit and integration tests for the TabTTL Chrome extension using Vitest.

**Architecture:** Vitest runs in Node with a shared Chrome API mock (`tests/setup.js`) that stubs `chrome.storage`, `chrome.tabs`, `chrome.alarms`, `chrome.notifications`, `chrome.idle`, and `chrome.runtime`. Pure utility modules are tested directly. The service worker (which registers listeners at module load) is tested by dynamically importing it per test suite and extracting listener callbacks from the mocks.

**Tech Stack:** Vitest 3.x, Node ESM

---

## File Map

| File | Change |
|------|--------|
| `package.json` | Add vitest devDependency, test scripts |
| `vitest.config.js` | Create: Vitest config with setup file |
| `tests/setup.js` | Create: Chrome API mock + `resetChromeStorage` helper |
| `tests/unit/analytics.test.js` | Create: Tests for all 5 analytics functions |
| `tests/unit/domain-matcher.test.js` | Create: Tests for getHostname, matchesPattern, matchesAny |
| `tests/unit/storage.test.js` | Create: Tests for getSettings defaults and getManuallyProtected Set round-trip |
| `tests/unit/service-worker.test.js` | Create: Tests for handleMessage cases, checkTabTTLs skip logic |
| `tests/integration/ttl-lifecycle.test.js` | Create: Full TTL expiry → grace → close → history + analytics |
| `tests/integration/manual-protect.test.js` | Create: Protect toggle → skip in TTL → unprotect → eligible |

---

### Task 1: Project setup — Vitest config, Chrome mock, and package.json

**Files:**
- Modify: `package.json`
- Create: `vitest.config.js`
- Create: `tests/setup.js`

- [ ] **Step 1: Install vitest**

```bash
npm install --save-dev vitest
```

- [ ] **Step 2: Add test scripts to `package.json`**

Add to the `"scripts"` section:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Create `vitest.config.js`**

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup.js'],
    environment: 'node',
  },
});
```

- [ ] **Step 4: Create `tests/setup.js`**

```js
import { vi, beforeEach } from 'vitest';

function makeStorage() {
  let store = {};
  return {
    _store: store,
    get: vi.fn(async (key) => {
      if (typeof key === 'string') {
        return key in store ? { [key]: structuredClone(store[key]) } : {};
      }
      if (Array.isArray(key)) {
        const result = {};
        for (const k of key) {
          if (k in store) result[k] = structuredClone(store[k]);
        }
        return result;
      }
      return { ...store };
    }),
    set: vi.fn(async (items) => {
      Object.assign(store, structuredClone(items));
    }),
    clear: vi.fn(async () => { store = {}; }),
    _reset() {
      for (const k of Object.keys(store)) delete store[k];
    },
  };
}

const syncStorage = makeStorage();
const localStorage = makeStorage();
const sessionStorage = makeStorage();

const alarms = new Map();
const tabs = [];
const removedTabIds = [];
const createdTabs = [];

globalThis.chrome = {
  storage: {
    sync: syncStorage,
    local: localStorage,
    session: sessionStorage,
  },
  tabs: {
    query: vi.fn(async (filter) => {
      let result = [...tabs];
      if (filter && filter.active === true) {
        result = result.filter(t => t.active);
      }
      return result;
    }),
    get: vi.fn(async (id) => {
      const tab = tabs.find(t => t.id === id);
      if (!tab) throw new Error(`No tab with id ${id}`);
      return tab;
    }),
    remove: vi.fn(async (id) => { removedTabIds.push(id); }),
    create: vi.fn(async (opts) => { createdTabs.push(opts); return { id: 999, ...opts }; }),
    onActivated: { addListener: vi.fn() },
    onUpdated: { addListener: vi.fn() },
    onCreated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
  },
  alarms: {
    create: vi.fn((name, opts) => { alarms.set(name, opts); }),
    clear: vi.fn(async (name) => { alarms.delete(name); }),
    onAlarm: { addListener: vi.fn() },
  },
  notifications: {
    create: vi.fn(async () => {}),
    clear: vi.fn(() => {}),
    onButtonClicked: { addListener: vi.fn() },
  },
  idle: {
    queryState: vi.fn(async () => 'active'),
  },
  runtime: {
    getURL: vi.fn((path) => path),
    onInstalled: { addListener: vi.fn() },
    onStartup: { addListener: vi.fn() },
    onMessage: { addListener: vi.fn() },
  },
};

export function resetChromeStorage() {
  syncStorage._reset();
  localStorage._reset();
  sessionStorage._reset();
}

export function setTabs(newTabs) {
  tabs.length = 0;
  tabs.push(...newTabs);
}

export function getRemovedTabIds() {
  return removedTabIds;
}

export function getCreatedTabs() {
  return createdTabs;
}

export function getAlarms() {
  return alarms;
}

export function resetAll() {
  resetChromeStorage();
  tabs.length = 0;
  removedTabIds.length = 0;
  createdTabs.length = 0;
  alarms.clear();

  chrome.tabs.query.mockClear();
  chrome.tabs.get.mockClear();
  chrome.tabs.remove.mockClear();
  chrome.tabs.create.mockClear();
  chrome.alarms.create.mockClear();
  chrome.alarms.clear.mockClear();
  chrome.notifications.create.mockClear();
  chrome.notifications.clear.mockClear();
  chrome.idle.queryState.mockReturnValue(Promise.resolve('active'));
}

beforeEach(() => {
  resetAll();
});
```

- [ ] **Step 5: Verify setup works**

Run: `npx vitest run --passWithNoTests`
Expected: exits 0 with no failures

- [ ] **Step 6: Commit**

```bash
git add package.json vitest.config.js tests/setup.js package-lock.json
git commit -m "test: add vitest config and Chrome API mock setup"
```

---

### Task 2: Unit tests for `utils/analytics.js`

**Files:**
- Create: `tests/unit/analytics.test.js`

**Context:** `utils/analytics.js` exports 5 pure functions. `filterByRange` uses `Date.now()` internally, so use `vi.useFakeTimers()` for it. `MEMORY_PER_TAB_MB` is `75` (from `utils/constants.js`).

- [ ] **Step 1: Write the tests**

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  filterByRange,
  computeReport,
  computeTopDomains,
  computeHourlyDistribution,
  formatDuration,
} from '../../utils/analytics.js';

describe('filterByRange', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns entries within the time window', () => {
    vi.setSystemTime(10000);
    const log = [
      { ts: 5000, domain: 'a.com' },
      { ts: 8000, domain: 'b.com' },
      { ts: 2000, domain: 'c.com' },
    ];
    const result = filterByRange(log, 6000); // cutoff = 4000
    expect(result).toHaveLength(2);
    expect(result.map(e => e.domain)).toEqual(['a.com', 'b.com']);
  });

  it('returns empty array for empty log', () => {
    vi.setSystemTime(10000);
    expect(filterByRange([], 5000)).toEqual([]);
  });

  it('includes entries exactly on the boundary', () => {
    vi.setSystemTime(10000);
    const log = [{ ts: 4000, domain: 'edge.com' }];
    const result = filterByRange(log, 6000); // cutoff = 4000
    expect(result).toHaveLength(1);
  });
});

describe('computeReport', () => {
  it('computes correct stats from log entries', () => {
    const log = [
      { ts: 1000, domain: 'a.com', ttlMs: 60000 },
      { ts: 2000, domain: 'b.com', ttlMs: 30000 },
      { ts: 3000, domain: 'a.com', ttlMs: 60000 },
    ];
    const report = computeReport(log);
    expect(report.tabsClosed).toBe(3);
    expect(report.timeSavedMs).toBe(150000);
    expect(report.memoryMB).toBe(3 * 75);
    expect(report.topDomains[0]).toEqual({ domain: 'a.com', count: 2 });
  });

  it('returns zeros for empty log', () => {
    const report = computeReport([]);
    expect(report.tabsClosed).toBe(0);
    expect(report.timeSavedMs).toBe(0);
    expect(report.memoryMB).toBe(0);
    expect(report.topDomains).toEqual([]);
  });

  it('handles entries with missing ttlMs', () => {
    const log = [{ ts: 1000, domain: 'x.com' }];
    const report = computeReport(log);
    expect(report.timeSavedMs).toBe(0);
  });
});

describe('computeTopDomains', () => {
  it('ranks domains by count descending', () => {
    const log = [
      { domain: 'b.com' }, { domain: 'a.com' },
      { domain: 'a.com' }, { domain: 'b.com' },
      { domain: 'a.com' },
    ];
    const result = computeTopDomains(log);
    expect(result[0]).toEqual({ domain: 'a.com', count: 3 });
    expect(result[1]).toEqual({ domain: 'b.com', count: 2 });
  });

  it('respects topN limit', () => {
    const log = [
      { domain: 'a.com' }, { domain: 'b.com' }, { domain: 'c.com' },
    ];
    const result = computeTopDomains(log, 2);
    expect(result).toHaveLength(2);
  });

  it('groups missing domain as (unknown)', () => {
    const log = [{ domain: '' }, { domain: undefined }];
    const result = computeTopDomains(log);
    expect(result[0]).toEqual({ domain: '(unknown)', count: 2 });
  });
});

describe('computeHourlyDistribution', () => {
  it('buckets events by hour', () => {
    const noon = new Date('2026-01-15T12:30:00').getTime();
    const oneAm = new Date('2026-01-15T01:00:00').getTime();
    const log = [{ ts: noon }, { ts: noon }, { ts: oneAm }];
    const hours = computeHourlyDistribution(log);
    expect(hours).toHaveLength(24);
    expect(hours[12]).toBe(2);
    expect(hours[1]).toBe(1);
    expect(hours[0]).toBe(0);
  });

  it('returns all zeros for empty log', () => {
    const hours = computeHourlyDistribution([]);
    expect(hours).toHaveLength(24);
    expect(hours.every(h => h === 0)).toBe(true);
  });
});

describe('formatDuration', () => {
  it('formats zero', () => expect(formatDuration(0)).toBe('0s'));
  it('formats negative as 0s', () => expect(formatDuration(-1000)).toBe('0s'));
  it('formats seconds', () => expect(formatDuration(45000)).toBe('45s'));
  it('formats minutes and seconds', () => expect(formatDuration(125000)).toBe('2m 5s'));
  it('formats hours and minutes', () => expect(formatDuration(3720000)).toBe('1h 2m'));
  it('formats days and hours', () => expect(formatDuration(90000000)).toBe('1d 1h'));
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/unit/analytics.test.js`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add tests/unit/analytics.test.js
git commit -m "test: add unit tests for utils/analytics.js"
```

---

### Task 3: Unit tests for `utils/domain-matcher.js`

**Files:**
- Create: `tests/unit/domain-matcher.test.js`

**Context:** `utils/domain-matcher.js` exports `getHostname`, `matchesPattern`, `matchesAny`. All pure functions that work with URL parsing.

- [ ] **Step 1: Write the tests**

```js
import { describe, it, expect } from 'vitest';
import { getHostname, matchesPattern, matchesAny } from '../../utils/domain-matcher.js';

describe('getHostname', () => {
  it('extracts hostname from https URL', () => {
    expect(getHostname('https://github.com/user/repo')).toBe('github.com');
  });

  it('extracts hostname from http URL', () => {
    expect(getHostname('http://example.com')).toBe('example.com');
  });

  it('returns empty for chrome:// URL', () => {
    expect(getHostname('chrome://extensions')).toBe('');
  });

  it('returns empty for about: URL', () => {
    expect(getHostname('about:blank')).toBe('');
  });

  it('returns empty for ftp URL', () => {
    expect(getHostname('ftp://files.example.com')).toBe('');
  });

  it('returns empty for malformed URL', () => {
    expect(getHostname('not a url')).toBe('');
  });

  it('returns empty for empty string', () => {
    expect(getHostname('')).toBe('');
  });
});

describe('matchesPattern', () => {
  it('matches exact domain', () => {
    expect(matchesPattern('https://github.com/page', 'github.com')).toBe(true);
  });

  it('matches subdomain', () => {
    expect(matchesPattern('https://api.github.com/v1', 'github.com')).toBe(true);
  });

  it('does not match partial hostname', () => {
    expect(matchesPattern('https://notgithub.com', 'github.com')).toBe(false);
  });

  it('matches exact path', () => {
    expect(matchesPattern('https://github.com/myorg', 'github.com/myorg')).toBe(true);
  });

  it('does not match different path (exact mode)', () => {
    expect(matchesPattern('https://github.com/other', 'github.com/myorg')).toBe(false);
  });

  it('matches wildcard path prefix', () => {
    expect(matchesPattern('https://github.com/myorg/repo', 'github.com/myorg/*')).toBe(true);
  });

  it('does not match wildcard path for different prefix', () => {
    expect(matchesPattern('https://github.com/other/repo', 'github.com/myorg/*')).toBe(false);
  });

  it('returns false for non-http URL', () => {
    expect(matchesPattern('chrome://extensions', 'extensions')).toBe(false);
  });

  it('returns false for malformed URL', () => {
    expect(matchesPattern('not-a-url', 'example.com')).toBe(false);
  });
});

describe('matchesAny', () => {
  it('returns true if any pattern matches', () => {
    expect(matchesAny('https://github.com', ['gitlab.com', 'github.com'])).toBe(true);
  });

  it('returns false if none match', () => {
    expect(matchesAny('https://github.com', ['gitlab.com', 'bitbucket.org'])).toBe(false);
  });

  it('returns false for empty pattern list', () => {
    expect(matchesAny('https://github.com', [])).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/unit/domain-matcher.test.js`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add tests/unit/domain-matcher.test.js
git commit -m "test: add unit tests for utils/domain-matcher.js"
```

---

### Task 4: Unit tests for `utils/storage.js`

**Files:**
- Create: `tests/unit/storage.test.js`

**Context:** `utils/storage.js` wraps `chrome.storage.sync/local/session`. The Chrome mock from `tests/setup.js` is available. We test `getSettings` (default merging logic) and `getManuallyProtected`/`saveManuallyProtected` (Set round-trip). Trivial pass-throughs are skipped.

- [ ] **Step 1: Write the tests**

```js
import { describe, it, expect } from 'vitest';
import { getSettings, getManuallyProtected, saveManuallyProtected } from '../../utils/storage.js';

describe('getSettings', () => {
  it('returns all defaults when storage is empty', async () => {
    const settings = await getSettings();
    expect(settings.enabled).toBe(true);
    expect(settings.ttl).toBe(5 * 60 * 1000);
    expect(settings.mode).toBe('blocklist');
    expect(settings.gracePeriod).toBe(15);
    expect(settings.idleDetection).toBe(true);
    expect(settings.idleThreshold).toBe(60);
    expect(settings.snoozeMinutes).toBe(10);
    expect(settings.streakTabLimit).toBe(20);
  });

  it('merges stored overrides with defaults', async () => {
    await chrome.storage.sync.set({ settings: { ttl: 999, enabled: false } });
    const settings = await getSettings();
    expect(settings.enabled).toBe(false);
    expect(settings.ttl).toBe(999);
    // Defaults still present for unset keys
    expect(settings.gracePeriod).toBe(15);
    expect(settings.mode).toBe('blocklist');
  });
});

describe('getManuallyProtected / saveManuallyProtected', () => {
  it('returns empty Set when storage is empty', async () => {
    const set = await getManuallyProtected();
    expect(set).toBeInstanceOf(Set);
    expect(set.size).toBe(0);
  });

  it('round-trips through save and get', async () => {
    const original = new Set([1, 2, 3]);
    await saveManuallyProtected(original);
    const loaded = await getManuallyProtected();
    expect(loaded).toBeInstanceOf(Set);
    expect([...loaded].sort()).toEqual([1, 2, 3]);
  });

  it('preserves Set semantics (no duplicates)', async () => {
    const set = new Set([5, 5, 5]);
    await saveManuallyProtected(set);
    const loaded = await getManuallyProtected();
    expect(loaded.size).toBe(1);
    expect(loaded.has(5)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/unit/storage.test.js`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add tests/unit/storage.test.js
git commit -m "test: add unit tests for utils/storage.js"
```

---

### Task 5: Unit tests for `background/service-worker.js`

**Files:**
- Create: `tests/unit/service-worker.test.js`

**Context:** The service worker registers Chrome event listeners at module load. We dynamically import it once, then extract listener callbacks from `chrome.runtime.onMessage.addListener.mock.calls[0][0]` and `chrome.alarms.onAlarm.addListener.mock.calls[0][0]`. The message listener wraps `handleMessage` — we call it with a mock `sendResponse` to test each message type.

Key details:
- `chrome.runtime.onMessage.addListener` receives `(message, sender, sendResponse) => { handleMessage(message).then(sendResponse)... }`
- We need to call `sendResponse` callback style and await the result
- `chrome.tabs.onRemoved.addListener` callback handles cleanup
- `setTabs` from setup.js configures what `chrome.tabs.query` returns

- [ ] **Step 1: Write the tests**

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setTabs, getRemovedTabIds, getAlarms, resetAll } from '../setup.js';

// Dynamic import so Chrome mock is in place when module loads
let messageHandler;
let alarmHandler;
let onRemovedHandler;

beforeEach(() => {
  resetAll();
});

// Import once — extract listeners
const importPromise = import('../../background/service-worker.js').then(() => {
  messageHandler = chrome.runtime.onMessage.addListener.mock.calls[0][0];
  alarmHandler = chrome.alarms.onAlarm.addListener.mock.calls[0][0];
  onRemovedHandler = chrome.tabs.onRemoved.addListener.mock.calls[0][0];
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

describe('handleMessage', () => {
  it('TOGGLE_PROTECT_TAB toggles on', async () => {
    const result = await sendMessage({ type: 'TOGGLE_PROTECT_TAB', tabId: 42 });
    expect(result.protected).toBe(true);

    // Verify it persisted
    const { manuallyProtected } = await chrome.storage.session.get('manuallyProtected');
    expect(manuallyProtected).toContain(42);
  });

  it('TOGGLE_PROTECT_TAB toggles off', async () => {
    await chrome.storage.session.set({ manuallyProtected: [42] });
    const result = await sendMessage({ type: 'TOGGLE_PROTECT_TAB', tabId: 42 });
    expect(result.protected).toBe(false);
  });

  it('SNOOZE_TAB sets snooze and cancels grace', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    await chrome.storage.local.set({
      pendingGrace: { 10: { tabId: 10, closeAt: 110000 } },
    });

    const result = await sendMessage({ type: 'SNOOZE_TAB', tabId: 10, minutes: 5 });
    expect(result.ok).toBe(true);

    const { snoozed } = await chrome.storage.local.get('snoozed');
    expect(snoozed[10]).toBe(100000 + 5 * 60 * 1000);

    const { pendingGrace } = await chrome.storage.local.get('pendingGrace');
    expect(pendingGrace[10]).toBeUndefined();
    vi.useRealTimers();
  });

  it('CANCEL_GRACE removes grace and resets lastAccessed', async () => {
    await chrome.storage.local.set({
      pendingGrace: { 10: { tabId: 10, closeAt: 999 } },
    });
    const result = await sendMessage({ type: 'CANCEL_GRACE', tabId: 10 });
    expect(result.ok).toBe(true);

    const { pendingGrace } = await chrome.storage.local.get('pendingGrace');
    expect(pendingGrace[10]).toBeUndefined();
  });

  it('RESTORE_TAB creates a new tab', async () => {
    const result = await sendMessage({ type: 'RESTORE_TAB', url: 'https://example.com' });
    expect(result.ok).toBe(true);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://example.com', active: false });
  });

  it('CLEAR_HISTORY empties closed tabs', async () => {
    await chrome.storage.local.set({ closedTabs: [{ url: 'https://x.com' }] });
    await sendMessage({ type: 'CLEAR_HISTORY' });
    const { closedTabs } = await chrome.storage.local.get('closedTabs');
    expect(closedTabs).toEqual([]);
  });

  it('GET_CLOSED_TABS returns stored history', async () => {
    const entry = { url: 'https://example.com', closedAt: 1000 };
    await chrome.storage.local.set({ closedTabs: [entry] });
    const result = await sendMessage({ type: 'GET_CLOSED_TABS' });
    expect(result.tabs).toEqual([entry]);
  });

  it('GET_TAB_INFO returns tab data', async () => {
    setTabs([
      { id: 1, windowId: 1, index: 0, title: 'Tab 1', url: 'https://a.com', pinned: false, active: true },
    ]);
    const result = await sendMessage({ type: 'GET_TAB_INFO' });
    expect(result.tabs).toHaveLength(1);
    expect(result.tabs[0].id).toBe(1);
    expect(result.tabs[0].active).toBe(true);
    expect(result.tabs[0].isProtected).toBe(true); // active = protected
    expect(result.settings).toBeDefined();
  });

  it('GET_ANALYTICS_DATA returns log and state', async () => {
    await chrome.storage.local.set({
      analyticsLog: [{ ts: 1000 }],
      analyticsState: { streakData: { currentStreak: 3 } },
    });
    const result = await sendMessage({ type: 'GET_ANALYTICS_DATA' });
    expect(result.log).toHaveLength(1);
    expect(result.state.streakData.currentStreak).toBe(3);
  });

  it('CLEAR_ANALYTICS empties analytics log', async () => {
    await chrome.storage.local.set({ analyticsLog: [{ ts: 1 }] });
    await sendMessage({ type: 'CLEAR_ANALYTICS' });
    const { analyticsLog } = await chrome.storage.local.get('analyticsLog');
    expect(analyticsLog).toEqual([]);
  });

  it('unknown type throws error', async () => {
    await expect(sendMessage({ type: 'BOGUS' })).rejects.toThrow('Unknown message type');
  });
});

describe('checkTabTTLs skip conditions (via FORCE_CHECK)', () => {
  it('skips when disabled', async () => {
    await chrome.storage.sync.set({ settings: { enabled: false } });
    setTabs([
      { id: 1, url: 'https://a.com', pinned: false, active: false },
    ]);
    await chrome.storage.local.set({ tabLastAccessed: { 1: 0 } });

    await sendMessage({ type: 'FORCE_CHECK' });
    expect(chrome.notifications.create).not.toHaveBeenCalled();
  });

  it('skips when user is idle', async () => {
    chrome.idle.queryState.mockResolvedValue('idle');
    await chrome.storage.sync.set({
      settings: { enabled: true, idleDetection: true, idleThreshold: 60 },
    });
    setTabs([
      { id: 1, url: 'https://a.com', pinned: false, active: false },
    ]);
    await chrome.storage.local.set({ tabLastAccessed: { 1: 0 } });

    await sendMessage({ type: 'FORCE_CHECK' });
    expect(chrome.notifications.create).not.toHaveBeenCalled();
  });

  it('skips pinned tabs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000000);
    await chrome.storage.sync.set({
      settings: { enabled: true, ttl: 1000, mode: 'blocklist', idleDetection: false, gracePeriod: 10 },
    });
    await chrome.storage.sync.set({ blocklist: ['a.com'] });
    setTabs([
      { id: 1, url: 'https://a.com', pinned: true, active: false },
    ]);
    await chrome.storage.local.set({ tabLastAccessed: { 1: 0 } });

    await sendMessage({ type: 'FORCE_CHECK' });
    expect(chrome.notifications.create).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('skips manually protected tabs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000000);
    await chrome.storage.sync.set({
      settings: { enabled: true, ttl: 1000, mode: 'blocklist', idleDetection: false, gracePeriod: 10 },
    });
    await chrome.storage.sync.set({ blocklist: ['a.com'] });
    await chrome.storage.session.set({ manuallyProtected: [1] });
    setTabs([
      { id: 1, url: 'https://a.com', pinned: false, active: false },
    ]);
    await chrome.storage.local.set({ tabLastAccessed: { 1: 0 } });

    await sendMessage({ type: 'FORCE_CHECK' });
    expect(chrome.notifications.create).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('skips active tabs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000000);
    await chrome.storage.sync.set({
      settings: { enabled: true, ttl: 1000, mode: 'blocklist', idleDetection: false, gracePeriod: 10 },
    });
    await chrome.storage.sync.set({ blocklist: ['a.com'] });
    setTabs([
      { id: 1, url: 'https://a.com', pinned: false, active: true },
    ]);
    await chrome.storage.local.set({ tabLastAccessed: { 1: 0 } });

    await sendMessage({ type: 'FORCE_CHECK' });
    expect(chrome.notifications.create).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('skips snoozed tabs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000000);
    await chrome.storage.sync.set({
      settings: { enabled: true, ttl: 1000, mode: 'blocklist', idleDetection: false, gracePeriod: 10 },
    });
    await chrome.storage.sync.set({ blocklist: ['a.com'] });
    setTabs([
      { id: 1, url: 'https://a.com', pinned: false, active: false },
    ]);
    await chrome.storage.local.set({
      tabLastAccessed: { 1: 0 },
      snoozed: { 1: 9999999 },
    });

    await sendMessage({ type: 'FORCE_CHECK' });
    expect(chrome.notifications.create).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('skips non-http tabs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000000);
    await chrome.storage.sync.set({
      settings: { enabled: true, ttl: 1000, mode: 'blocklist', idleDetection: false, gracePeriod: 10 },
    });
    await chrome.storage.sync.set({ blocklist: ['extensions'] });
    setTabs([
      { id: 1, url: 'chrome://extensions', pinned: false, active: false },
    ]);
    await chrome.storage.local.set({ tabLastAccessed: { 1: 0 } });

    await sendMessage({ type: 'FORCE_CHECK' });
    expect(chrome.notifications.create).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('initiates grace for expired tab in blocklist mode', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000000);
    await chrome.storage.sync.set({
      settings: { enabled: true, ttl: 1000, mode: 'blocklist', idleDetection: false, gracePeriod: 15 },
    });
    await chrome.storage.sync.set({ blocklist: ['a.com'] });
    setTabs([
      { id: 1, url: 'https://a.com', pinned: false, active: false, title: 'Test Tab' },
    ]);
    await chrome.storage.local.set({ tabLastAccessed: { 1: 0 } });

    await sendMessage({ type: 'FORCE_CHECK' });
    expect(chrome.alarms.create).toHaveBeenCalledWith(
      'tabTTL-grace-1',
      expect.objectContaining({ when: expect.any(Number) }),
    );
    expect(chrome.notifications.create).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('allowlist mode skips tabs matching the allowlist', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000000);
    await chrome.storage.sync.set({
      settings: { enabled: true, ttl: 1000, mode: 'allowlist', idleDetection: false, gracePeriod: 10 },
    });
    await chrome.storage.sync.set({ allowlist: ['a.com'] });
    setTabs([
      { id: 1, url: 'https://a.com', pinned: false, active: false },
    ]);
    await chrome.storage.local.set({ tabLastAccessed: { 1: 0 } });

    await sendMessage({ type: 'FORCE_CHECK' });
    expect(chrome.notifications.create).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('tabs.onRemoved cleanup', () => {
  it('cleans up manually protected state when tab is removed', async () => {
    await importPromise;
    await chrome.storage.session.set({ manuallyProtected: [99] });
    await chrome.storage.local.set({ tabLastAccessed: { 99: 1000 }, snoozed: {} });

    await onRemovedHandler(99);

    const { manuallyProtected } = await chrome.storage.session.get('manuallyProtected');
    expect(manuallyProtected).not.toContain(99);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/unit/service-worker.test.js`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add tests/unit/service-worker.test.js
git commit -m "test: add unit tests for background/service-worker.js"
```

---

### Task 6: Integration test — TTL lifecycle

**Files:**
- Create: `tests/integration/ttl-lifecycle.test.js`

**Context:** Tests the full flow: tab ages past TTL → grace initiated → grace alarm fires → tab closed → history recorded → analytics logged. Reuses the same service worker module import and message/alarm handlers from the test infrastructure.

- [ ] **Step 1: Write the tests**

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setTabs, getRemovedTabIds, resetAll } from '../setup.js';

let messageHandler;
let alarmHandler;

const importPromise = import('../../background/service-worker.js').then(() => {
  messageHandler = chrome.runtime.onMessage.addListener.mock.calls[0][0];
  alarmHandler = chrome.alarms.onAlarm.addListener.mock.calls[0][0];
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

beforeEach(() => {
  resetAll();
});

describe('TTL lifecycle: expire → grace → close → history + analytics', () => {
  it('completes full lifecycle for an expired tab', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000000);

    // Setup: a tab that expired 500s ago, blocklist mode matching its domain
    await chrome.storage.sync.set({
      settings: {
        enabled: true,
        ttl: 60000,
        mode: 'blocklist',
        idleDetection: false,
        gracePeriod: 10,
      },
    });
    await chrome.storage.sync.set({ blocklist: ['example.com'] });
    setTabs([
      {
        id: 50, windowId: 1, index: 0,
        title: 'Example Page', url: 'https://example.com/page',
        favIconUrl: 'https://example.com/favicon.ico',
        pinned: false, active: false,
      },
    ]);
    await chrome.storage.local.set({
      tabLastAccessed: { 50: 500000 }, // 500s ago, well past 60s TTL
    });

    // Step 1: Trigger TTL check — should initiate grace
    await sendMessage({ type: 'FORCE_CHECK' });

    // Verify grace alarm was created
    expect(chrome.alarms.create).toHaveBeenCalledWith(
      'tabTTL-grace-50',
      { when: 1000000 + 10 * 1000 },
    );
    expect(chrome.notifications.create).toHaveBeenCalledWith(
      'grace-50',
      expect.objectContaining({
        title: 'TabTTL — Closing Tab',
      }),
    );

    // Verify pendingGrace was set
    const { pendingGrace } = await chrome.storage.local.get('pendingGrace');
    expect(pendingGrace[50]).toBeDefined();
    expect(pendingGrace[50].closeAt).toBe(1010000);

    // Step 2: Fire the grace alarm — should close the tab
    vi.setSystemTime(1010000);
    await alarmHandler({ name: 'tabTTL-grace-50' });

    // Verify tab was removed
    expect(chrome.tabs.remove).toHaveBeenCalledWith(50);

    // Verify closed tab history
    const { closedTabs } = await chrome.storage.local.get('closedTabs');
    expect(closedTabs).toHaveLength(1);
    expect(closedTabs[0].tabId).toBe(50);
    expect(closedTabs[0].url).toBe('https://example.com/page');
    expect(closedTabs[0].title).toBe('Example Page');

    // Verify analytics event
    const { analyticsLog } = await chrome.storage.local.get('analyticsLog');
    expect(analyticsLog).toHaveLength(1);
    expect(analyticsLog[0].domain).toBe('example.com');
    expect(analyticsLog[0].ageMs).toBeGreaterThan(0);

    // Verify pendingGrace was cleared
    const { pendingGrace: pg2 } = await chrome.storage.local.get('pendingGrace');
    expect(pg2[50]).toBeUndefined();

    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/integration/ttl-lifecycle.test.js`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add tests/integration/ttl-lifecycle.test.js
git commit -m "test: add integration test for TTL lifecycle"
```

---

### Task 7: Integration test — Manual protection

**Files:**
- Create: `tests/integration/manual-protect.test.js`

**Context:** Tests the full manual protection flow: toggle on → tab skipped in TTL check → toggle off → tab eligible for grace.

- [ ] **Step 1: Write the tests**

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setTabs, resetAll } from '../setup.js';

let messageHandler;
let onRemovedHandler;

const importPromise = import('../../background/service-worker.js').then(() => {
  messageHandler = chrome.runtime.onMessage.addListener.mock.calls[0][0];
  onRemovedHandler = chrome.tabs.onRemoved.addListener.mock.calls[0][0];
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

beforeEach(() => {
  resetAll();
});

describe('Manual protection lifecycle', () => {
  const TAB_ID = 77;

  async function setupExpiredTab() {
    vi.useFakeTimers();
    vi.setSystemTime(1000000);
    await chrome.storage.sync.set({
      settings: {
        enabled: true,
        ttl: 60000,
        mode: 'blocklist',
        idleDetection: false,
        gracePeriod: 10,
      },
    });
    await chrome.storage.sync.set({ blocklist: ['test.com'] });
    setTabs([
      {
        id: TAB_ID, windowId: 1, index: 0,
        title: 'Test', url: 'https://test.com',
        pinned: false, active: false,
      },
    ]);
    await chrome.storage.local.set({
      tabLastAccessed: { [TAB_ID]: 0 }, // well past TTL
    });
  }

  it('protected tab is skipped during TTL check', async () => {
    await setupExpiredTab();

    // Protect the tab
    const result = await sendMessage({ type: 'TOGGLE_PROTECT_TAB', tabId: TAB_ID });
    expect(result.protected).toBe(true);

    // Force check — should NOT initiate grace
    await sendMessage({ type: 'FORCE_CHECK' });
    expect(chrome.notifications.create).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('unprotected tab becomes eligible again', async () => {
    await setupExpiredTab();

    // Protect, then unprotect
    await sendMessage({ type: 'TOGGLE_PROTECT_TAB', tabId: TAB_ID });
    const result = await sendMessage({ type: 'TOGGLE_PROTECT_TAB', tabId: TAB_ID });
    expect(result.protected).toBe(false);

    // Force check — should initiate grace now
    await sendMessage({ type: 'FORCE_CHECK' });
    expect(chrome.alarms.create).toHaveBeenCalledWith(
      `tabTTL-grace-${TAB_ID}`,
      expect.objectContaining({ when: expect.any(Number) }),
    );

    vi.useRealTimers();
  });

  it('cleanup on tab removal removes protection', async () => {
    await importPromise;
    await chrome.storage.session.set({ manuallyProtected: [TAB_ID] });
    await chrome.storage.local.set({
      tabLastAccessed: { [TAB_ID]: 1000 },
      snoozed: {},
    });

    // Simulate tab close
    await onRemovedHandler(TAB_ID);

    const { manuallyProtected } = await chrome.storage.session.get('manuallyProtected');
    expect(manuallyProtected).not.toContain(TAB_ID);
  });

  it('GET_TAB_INFO reflects manual protection status', async () => {
    await setupExpiredTab();

    // Protect the tab
    await sendMessage({ type: 'TOGGLE_PROTECT_TAB', tabId: TAB_ID });

    const info = await sendMessage({ type: 'GET_TAB_INFO' });
    const tab = info.tabs.find(t => t.id === TAB_ID);
    expect(tab.manuallyProtected).toBe(true);
    expect(tab.isProtected).toBe(true);

    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/integration/manual-protect.test.js`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add tests/integration/manual-protect.test.js
git commit -m "test: add integration test for manual tab protection"
```

---

### Task 8: Run full test suite and verify

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`
Expected: All test files pass (analytics, domain-matcher, storage, service-worker, ttl-lifecycle, manual-protect)

- [ ] **Step 2: Commit any fixes if needed**

If any tests fail, fix and re-run before committing.
