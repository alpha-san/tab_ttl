# Test Suite Design Spec

**Date:** 2026-04-08
**Status:** Approved

## Overview

Add unit and integration tests for the TabTTL Chrome extension using Vitest. Pragmatic coverage: focus on logic-heavy functions, skip trivial getters/setters and DOM-heavy UI code.

## Framework

- **Vitest** — ESM-native, no transform config needed
- Chrome API mocked via a shared `tests/setup.js` registered in `vitest.config.js`

## Chrome API Mock (`tests/setup.js`)

A global mock object assigned to `globalThis.chrome` that stubs:

- `chrome.storage.sync` / `chrome.storage.local` / `chrome.storage.session` — backed by plain JS objects; supports `get(key)` and `set(obj)` with Promise return
- `chrome.tabs.query(filter)` — returns a configurable array of tab objects
- `chrome.tabs.get(id)` — returns a tab by ID from the same array
- `chrome.tabs.remove(id)` — records removal
- `chrome.tabs.create(opts)` — records creation
- `chrome.alarms.create(name, opts)` / `chrome.alarms.clear(name)` — backed by a Map
- `chrome.notifications.create(id, opts)` / `chrome.notifications.clear(id)` — no-op stubs
- `chrome.idle.queryState(threshold)` — returns configurable state (default: `'active'`)
- `chrome.runtime.getURL(path)` — returns path as-is
- `chrome.runtime.onInstalled` / `chrome.runtime.onStartup` / `chrome.runtime.onMessage` — `{ addListener: vi.fn() }`
- `chrome.tabs.onActivated` / `chrome.tabs.onUpdated` / `chrome.tabs.onCreated` / `chrome.tabs.onRemoved` — `{ addListener: vi.fn() }`
- `chrome.notifications.onButtonClicked` — `{ addListener: vi.fn() }`
- `chrome.alarms.onAlarm` — `{ addListener: vi.fn() }`

A `resetChromeStorage()` helper clears all storage state between tests.

## Test Files

### `tests/unit/analytics.test.js`

Tests for `utils/analytics.js` — all pure functions, no mocking needed:

- **`filterByRange`** — filters entries within time window; empty log returns empty; entries on boundary
- **`computeReport`** — correct tabsClosed count, timeSavedMs sum, memoryMB calculation, topDomains included; empty log returns zeros
- **`computeTopDomains`** — correct ranking and count; ties sorted; respects topN limit; unknown domain grouped as `(unknown)`
- **`computeHourlyDistribution`** — correct hour bucketing; returns 24-element array; empty log returns all zeros
- **`formatDuration`** — 0ms, seconds only, minutes+seconds, hours+minutes, days+hours; negative input returns '0s'

### `tests/unit/domain-matcher.test.js`

Tests for `utils/domain-matcher.js` — pure functions:

- **`getHostname`** — extracts hostname from http/https URLs; returns empty for `chrome://`, `about:`, `ftp://`; returns empty for malformed URLs
- **`matchesPattern`** — exact domain match; subdomain match (`sub.github.com` matches `github.com`); path pattern without wildcard (exact path); path pattern with wildcard (`github.com/myorg/*`); non-http URL returns false; malformed URL returns false
- **`matchesAny`** — returns true if any pattern matches; returns false if none match; empty pattern list returns false

### `tests/unit/storage.test.js`

Tests for `utils/storage.js` — against mocked `chrome.storage`:

- **`getSettings`** — returns defaults when storage is empty; merges stored overrides with defaults; stored keys win over defaults
- **`getManuallyProtected`** — returns empty Set when storage is empty; round-trips through save/get; Set semantics preserved (no duplicates)

### `tests/unit/service-worker.test.js`

Tests for `background/service-worker.js` — requires full Chrome mock. Since the service worker registers listeners at module load, we need to dynamically import it per test group and extract the listener callbacks.

**`resolveTabTTL`** (not exported — tested indirectly through `handleMessage('GET_TAB_INFO')`):
- Returns per-domain TTL when hostname matches
- Returns per-domain TTL for subdomain match
- Falls back to global TTL when no match

**`handleMessage`** — test each case:
- `GET_TAB_INFO` — returns tabs array with correct fields
- `SNOOZE_TAB` — sets snooze timestamp, cancels grace
- `CANCEL_GRACE` — removes grace entry, resets lastAccessed
- `RESTORE_TAB` — calls chrome.tabs.create with correct URL
- `CLEAR_HISTORY` — empties closed tabs
- `GET_CLOSED_TABS` — returns stored history
- `FORCE_CHECK` — runs checkTabTTLs without error
- `GET_ANALYTICS_DATA` — returns log and state
- `CLEAR_ANALYTICS` — empties analytics log
- `TOGGLE_PROTECT_TAB` — toggles on, toggles off, returns correct `protected` boolean
- Unknown type — throws error

**`checkTabTTLs` skip conditions** (tested via `FORCE_CHECK` with seeded state):
- Skips when `settings.enabled` is false
- Skips when idle state is not `'active'`
- Skips pinned tabs
- Skips manually protected tabs
- Skips active tabs
- Skips tabs already in grace
- Skips snoozed tabs
- Skips non-http tabs
- Respects allowlist mode (skips matching tabs)
- Respects blocklist mode (skips non-matching tabs)
- Initiates grace for expired tab (creates alarm + notification)

### `tests/integration/ttl-lifecycle.test.js`

End-to-end TTL flow with mocked Chrome APIs:

1. Seed a tab with `lastAccessed` older than TTL
2. Configure blocklist mode with matching domain
3. Trigger `checkTabTTLs` via `FORCE_CHECK`
4. Verify grace alarm created and notification sent
5. Fire the grace alarm callback
6. Verify tab removed, added to closed history, analytics event logged

### `tests/integration/manual-protect.test.js`

Manual protection lifecycle:

1. Toggle protect on a tab via `TOGGLE_PROTECT_TAB`
2. Verify tab skipped during `checkTabTTLs` (even if expired)
3. Toggle protect off
4. Verify tab eligible for grace close
5. Verify cleanup: simulate `tabs.onRemoved` → manuallyProtected set no longer contains tab ID

## Configuration

**`vitest.config.js`:**
- `test.setupFiles: ['./tests/setup.js']`
- `test.environment: 'node'`
- No transform needed (pure ESM)

**`package.json` additions:**
- `devDependencies: { "vitest": "^3.1" }`
- `scripts: { "test": "vitest run", "test:watch": "vitest" }`

## Out of Scope

- Popup JS tests (DOM-heavy, low logic)
- Options page JS tests (same)
- Trivial storage pass-through pairs (e.g., `getAllowlist`/`saveAllowlist`)
- Visual/screenshot testing
