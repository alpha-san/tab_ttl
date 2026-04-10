# Allowlist Consistency & Port-Aware Patterns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two related bugs: (1) the popup and duplicate-tab cleanup ignore the allowlist, causing inconsistent UI and incorrect closes; (2) patterns containing a port (e.g. `localhost:3000`) never match because `URL.hostname` strips ports.

**Architecture:** Introduce a single `isTabProtected(tab, ctx)` helper in `background/service-worker.js` that all three close-decision sites (`checkTabTTLs` TTL loop, `checkTabTTLs` duplicate sweep, `closeDuplicateTab`, and `getTabInfo`) consult. Update `matchesPattern` to compare against `URL.host` instead of `URL.hostname` when the pattern contains a port.

**Tech Stack:** Vanilla JS (ES modules), Chrome Extension APIs, Vitest.

**Spec:** `docs/superpowers/specs/2026-04-10-allowlist-consistency-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `utils/domain-matcher.js` | Modify | Port-aware host comparison in `matchesPattern` |
| `background/service-worker.js` | Modify | New `isTabProtected` helper; refactor 4 call sites to use it |
| `tests/unit/domain-matcher.test.js` | Modify | New cases for port-bearing patterns + regression guards |
| `tests/unit/service-worker.test.js` | Modify | New cases for allowlist in `GET_TAB_INFO` and dedup |

---

## Task 1: Port-aware `matchesPattern`

**Files:**
- Modify: `utils/domain-matcher.js:21-44`
- Test: `tests/unit/domain-matcher.test.js`

- [ ] **Step 1: Write failing tests for port-bearing patterns**

Append these test cases to `tests/unit/domain-matcher.test.js`, inside the existing `describe('matchesPattern', ...)` block (or create the block if missing — check the file first):

```js
describe('matchesPattern with ports', () => {
  it('matches localhost:3000 against http://localhost:3000/foo', () => {
    expect(matchesPattern('http://localhost:3000/foo', 'localhost:3000')).toBe(true);
  });

  it('does not match localhost:3000 against http://localhost:8080/foo', () => {
    expect(matchesPattern('http://localhost:8080/foo', 'localhost:3000')).toBe(false);
  });

  it('does not match localhost:3000 against http://localhost/', () => {
    expect(matchesPattern('http://localhost/', 'localhost:3000')).toBe(false);
  });

  it('bare localhost still matches http://localhost:3000/ (regression guard)', () => {
    expect(matchesPattern('http://localhost:3000/', 'localhost')).toBe(true);
  });

  it('bare localhost still matches http://localhost/ (regression guard)', () => {
    expect(matchesPattern('http://localhost/', 'localhost')).toBe(true);
  });

  it('app.clickup.com still matches https://app.clickup.com/t/123 (regression guard)', () => {
    expect(matchesPattern('https://app.clickup.com/t/123', 'app.clickup.com')).toBe(true);
  });

  it('app.clickup.com/ only matches the root path (documents existing behavior)', () => {
    expect(matchesPattern('https://app.clickup.com/', 'app.clickup.com/')).toBe(true);
    expect(matchesPattern('https://app.clickup.com/t/123', 'app.clickup.com/')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/domain-matcher.test.js`
Expected: The first three new tests fail (localhost:3000 cases). The regression guards pass.

- [ ] **Step 3: Update `matchesPattern` to be port-aware**

Replace the body of `matchesPattern` in `utils/domain-matcher.js` with:

```js
export function matchesPattern(url, pattern) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;

    const slashIdx = pattern.indexOf('/');
    const patternHost = slashIdx === -1 ? pattern : pattern.slice(0, slashIdx);
    const patternPath = slashIdx === -1 ? null : pattern.slice(slashIdx);

    const target = patternHost.includes(':') ? u.host : u.hostname;
    const hostMatches =
      target === patternHost ||
      target.endsWith('.' + patternHost);

    if (!hostMatches) return false;
    if (patternPath === null) return true;

    if (patternPath.endsWith('*')) {
      return u.pathname.startsWith(patternPath.slice(0, -1));
    }
    return u.pathname === patternPath;
  } catch {
    return false;
  }
}
```

The only change is the new `target` line and using `target` in place of `u.hostname` in the host-matches expression.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/domain-matcher.test.js`
Expected: All tests pass (new + existing).

- [ ] **Step 5: Commit**

```bash
git add utils/domain-matcher.js tests/unit/domain-matcher.test.js
git commit -m "fix: support ports in domain patterns (e.g. localhost:3000)"
```

---

## Task 2: Add `isTabProtected` helper and adopt in `checkTabTTLs`

This task is a pure refactor — no new behavior, no new tests. The existing test suite must remain green after the change.

**Files:**
- Modify: `background/service-worker.js` (add helper near top of file; refactor `checkTabTTLs` lines ~158-243)

- [ ] **Step 1: Add the `isTabProtected` helper**

Add this function in `background/service-worker.js` immediately above `checkTabTTLs`:

```js
/**
 * Single source of truth for "this tab should never be closed."
 *
 * Excludes snooze and pending-grace on purpose: those are in-flight states
 * that each call site handles with its own branch (snooze can expire mid-sweep,
 * pending-grace shouldn't re-trigger).
 */
function isTabProtected(tab, ctx) {
  const { activeTabIds, manuallyProtected, settings, allowlist } = ctx;
  if (tab.pinned) return true;
  if (activeTabIds.has(tab.id)) return true;
  if (manuallyProtected.has(tab.id)) return true;
  if (isTabAudible(tab)) return true;
  if (settings.mode === 'allowlist' && matchesAny(tab.url ?? '', allowlist)) return true;
  return false;
}
```

- [ ] **Step 2: Refactor `checkTabTTLs` to use the helper**

In `background/service-worker.js`, inside `checkTabTTLs`, build a `protectionCtx` once after the storage reads, then use it in both the duplicate sweep and the TTL loop.

After the existing `const activeTabIds = new Set(...)` line (around line 156), add:

```js
const protectionCtx = { activeTabIds, manuallyProtected, settings, allowlist };
```

In the duplicate sweep's `eligible` filter (around lines 172-180), replace the inline checks:

```js
const eligible = group.filter(t => {
  if (isTabProtected(t, protectionCtx)) return false;
  if (snoozed[t.id] && snoozed[t.id] > now) return false;
  if (pendingGrace[t.id]) return false;
  return true;
});
```

In the TTL loop (around lines 212-229), replace the inline `pinned/manuallyProtected/audible/active/allowlist` checks with the helper. The loop body becomes:

```js
for (const tab of allTabs) {
  if (tab.id == null) continue;
  if (closedByDedup.has(tab.id)) continue;     // Already closed as duplicate
  if (pendingGrace[tab.id]) continue;          // Already queued for grace close

  const url = tab.url ?? '';
  if (!url.startsWith('http')) continue;       // Skip chrome://, about:, etc.

  if (isTabProtected(tab, protectionCtx)) continue;

  // Blocklist mode: only consider tabs that match the blocklist.
  if (settings.mode !== 'allowlist' && !matchesAny(url, blocklist)) continue;

  // Determine effective TTL for this tab.
  const ttl = resolveTabTTL(url, perDomainTTL, settings.ttl);

  // Respect snooze.
  const snoozeUntil = snoozed[tab.id];
  if (snoozeUntil && snoozeUntil > now) continue;

  // Check if the tab has aged past its TTL.
  const accessed = lastAccessed[tab.id] ?? now;
  if (now - accessed >= ttl) {
    await initiateGraceClose(tab, settings.gracePeriod);
  }
}
```

Note: the allowlist check now lives inside `isTabProtected`. The blocklist check stays inline because it's mode-specific and only relevant in blocklist mode.

- [ ] **Step 3: Run all tests to confirm no regressions**

Run: `npx vitest run`
Expected: All existing tests pass. No behavior change.

- [ ] **Step 4: Commit**

```bash
git add background/service-worker.js
git commit -m "refactor: extract isTabProtected helper for checkTabTTLs"
```

---

## Task 3: Use `isTabProtected` in `closeDuplicateTab` (adds allowlist check)

This task changes behavior: `closeDuplicateTab` will now respect the allowlist.

**Files:**
- Modify: `background/service-worker.js` (`closeDuplicateTab`, lines ~276-337)
- Test: `tests/unit/service-worker.test.js`

- [ ] **Step 1: Write the failing test**

Find an existing `closeDuplicateTab` test in `tests/unit/service-worker.test.js` to mirror its setup. Add this new test in the same `describe` block:

```js
it('does not close an allowlisted duplicate when mode is allowlist', async () => {
  await importPromise;
  await chrome.storage.sync.set({
    settings: { enabled: true, mode: 'allowlist', ttl: 60000, gracePeriod: 30, idleDetection: false },
    allowlist: ['app.clickup.com'],
  });
  setTabs([
    { id: 1, windowId: 1, index: 0, title: 'CU 1', url: 'https://app.clickup.com/t/abc', pinned: false, active: false },
    { id: 2, windowId: 1, index: 1, title: 'CU 2', url: 'https://app.clickup.com/t/abc', pinned: false, active: true },
  ]);

  // Trigger dedup via the onCreated handler for tab 1
  await onCreatedHandler({ id: 1, windowId: 1, url: 'https://app.clickup.com/t/abc', pinned: false });

  expect(getRemovedTabIds()).not.toContain(1);
  expect(getRemovedTabIds()).not.toContain(2);
});
```

If the existing test setup uses different storage helpers (e.g. a `setSettings` helper from `tests/setup.js`), use that pattern instead. Read the file first to confirm.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/service-worker.test.js -t "allowlisted duplicate"`
Expected: FAIL — one of the duplicate tabs is removed.

- [ ] **Step 3: Update `closeDuplicateTab` to use the helper**

In `background/service-worker.js`, inside `closeDuplicateTab`, after the existing storage reads add `getAllowlist` to the `Promise.all` and build a `protectionCtx`:

```js
const [allowlist, lastAccessed, snoozed, pendingGrace, manuallyProtected, perDomainTTL] = await Promise.all([
  getAllowlist(),
  getTabLastAccessed(),
  getSnoozed(),
  getPendingGrace(),
  getManuallyProtected(),
  getPerDomainTTL(),
]);
```

Add the import to the existing storage import at the top of the file if `getAllowlist` is not already imported (it is — already used by `checkTabTTLs`).

After the `const activeTabIds = new Set(...)` line, build the context:

```js
const protectionCtx = { activeTabIds, manuallyProtected, settings, allowlist };
```

Replace the `duplicates` filter with:

```js
const duplicates = windowTabs.filter(t => {
  if (t.id === tabId) return false;
  if (isTabProtected(t, protectionCtx)) return false;
  if (snoozed[t.id] && snoozed[t.id] > now) return false;
  if (pendingGrace[t.id]) return false;
  return normalizeUrlForDedup(t.url) === normalizedUrl;
});
```

Note: we also need to skip dedup entirely if the *trigger* tab is protected — otherwise we'd close every other duplicate to "preserve" a protected tab, which is fine, but we should be consistent. Actually, since the trigger tab is the most-recent one and we filter `t.id === tabId` out, and the other duplicates are checked with `isTabProtected`, the existing semantics are preserved: protected duplicates survive, unprotected duplicates of an unprotected trigger are still closed. No additional change needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/service-worker.test.js -t "allowlisted duplicate"`
Expected: PASS.

- [ ] **Step 5: Run full suite to confirm no regressions**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add background/service-worker.js tests/unit/service-worker.test.js
git commit -m "fix: closeDuplicateTab respects allowlist via isTabProtected"
```

---

## Task 4: Use `isTabProtected` in `getTabInfo` (popup shows correct status)

This task fixes the user-visible "timer at 0 but tab survives" inconsistency.

**Files:**
- Modify: `background/service-worker.js` (`getTabInfo`, lines ~557-605)
- Test: `tests/unit/service-worker.test.js`

- [ ] **Step 1: Write the failing tests**

Add these to `tests/unit/service-worker.test.js` in the `describe('handleMessage', ...)` block (next to the existing `GET_TAB_INFO` tests):

```js
it('GET_TAB_INFO marks an allowlisted tab as protected when mode is allowlist', async () => {
  await chrome.storage.sync.set({
    settings: { enabled: true, mode: 'allowlist', ttl: 60000, gracePeriod: 30, idleDetection: false },
    allowlist: ['app.clickup.com'],
  });
  setTabs([
    { id: 1, windowId: 1, index: 0, title: 'CU', url: 'https://app.clickup.com/t/123', pinned: false, active: false },
  ]);
  const result = await sendMessage({ type: 'GET_TAB_INFO' });
  expect(result.tabs[0].isProtected).toBe(true);
  expect(result.tabs[0].remaining).toBeNull();
});

it('GET_TAB_INFO does not mark an allowlisted tab as protected when mode is blocklist', async () => {
  await chrome.storage.sync.set({
    settings: { enabled: true, mode: 'blocklist', ttl: 60000, gracePeriod: 30, idleDetection: false },
    allowlist: ['app.clickup.com'],
    blocklist: [],
  });
  setTabs([
    { id: 1, windowId: 1, index: 0, title: 'CU', url: 'https://app.clickup.com/t/123', pinned: false, active: false },
  ]);
  const result = await sendMessage({ type: 'GET_TAB_INFO' });
  expect(result.tabs[0].isProtected).toBe(false);
});

it('GET_TAB_INFO marks a localhost:3000 tab as protected when localhost:3000 is allowlisted', async () => {
  await chrome.storage.sync.set({
    settings: { enabled: true, mode: 'allowlist', ttl: 60000, gracePeriod: 30, idleDetection: false },
    allowlist: ['localhost:3000'],
  });
  setTabs([
    { id: 1, windowId: 1, index: 0, title: 'Dev', url: 'http://localhost:3000/foo', pinned: false, active: false },
  ]);
  const result = await sendMessage({ type: 'GET_TAB_INFO' });
  expect(result.tabs[0].isProtected).toBe(true);
});
```

Check the existing `GET_TAB_INFO` test setup for the storage-key conventions used by `tests/setup.js` — if the mock uses different keys (e.g. nested under `sync` vs `local`), match the existing pattern.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/service-worker.test.js -t "GET_TAB_INFO"`
Expected: The three new tests fail. Existing GET_TAB_INFO tests still pass.

- [ ] **Step 3: Update `getTabInfo` to use `isTabProtected`**

In `background/service-worker.js`, modify `getTabInfo` to fetch the allowlist and use the helper.

Replace the storage destructure with:

```js
const [settings, allowlist, lastAccessed, snoozed, pendingGrace, manuallyProtected] = await Promise.all([
  getSettings(),
  getAllowlist(),
  getTabLastAccessed(),
  getSnoozed(),
  getPendingGrace(),
  getManuallyProtected(),
]);
```

After `const activeTabIds = new Set(...)`, add:

```js
const protectionCtx = { activeTabIds, manuallyProtected, settings, allowlist };
```

In the `tabs.map(...)` callback, replace the existing `isProtected` line with:

```js
const isProtected = isTabProtected(tab, protectionCtx);
```

Leave `isManuallyProtected` and `isAudible` declarations in place (the per-tab payload still exposes them as separate fields).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/service-worker.test.js -t "GET_TAB_INFO"`
Expected: All GET_TAB_INFO tests pass.

- [ ] **Step 5: Run full suite**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add background/service-worker.js tests/unit/service-worker.test.js
git commit -m "fix: getTabInfo marks allowlisted tabs as protected"
```

---

## Task 5: Manual verification

- [ ] **Step 1: Reload the extension**

In Chrome, open `chrome://extensions`, find TabTTL, click the reload button.

- [ ] **Step 2: Verify allowlist + popup consistency (bug 1, symptom C)**

1. Open Options → set mode to Allowlist.
2. Add `app.clickup.com` to the allowlist.
3. Open `https://app.clickup.com/` in a tab.
4. Open the popup.

Expected: The ClickUp tab appears in the **Protected** section with no countdown (label shows "Protected", not a ticking timer).

- [ ] **Step 3: Verify TTL doesn't close allowlisted tabs (bug 1, symptom A regression guard)**

1. Set TTL to 10 seconds in Options.
2. Wait 30 seconds.

Expected: The ClickUp tab is still open.

- [ ] **Step 4: Verify duplicate sweep respects allowlist**

1. Open a second `https://app.clickup.com/` tab (same URL).
2. Wait 5 seconds.

Expected: Both tabs remain open. Neither closed by duplicate detection.

- [ ] **Step 5: Verify port-bearing patterns (bug 2)**

1. Add `localhost:3000` to the allowlist.
2. Open `http://localhost:3000/` (any local dev server, or `python3 -m http.server 3000` in any directory).
3. Open the popup.

Expected: The localhost:3000 tab appears in **Protected**.

- [ ] **Step 6: Verify port specificity**

1. Start a second local server on port 8080 (`python3 -m http.server 8080`).
2. Open `http://localhost:8080/`.
3. Open the popup.

Expected: The localhost:8080 tab appears in **Managed** with a countdown — the `localhost:3000` allowlist entry does not protect it.

- [ ] **Step 7: Verify bare localhost still works**

1. Remove `localhost:3000` from the allowlist.
2. Add bare `localhost`.
3. Reload both localhost tabs (3000 and 8080).
4. Open the popup.

Expected: Both tabs appear in **Protected**.

---

## Self-Review Checklist

Before handing off, the writer of this plan should verify:

- Spec section "Allowlist consulted inconsistently" → covered by Tasks 2, 3, 4.
- Spec section "Patterns can't include a port" → covered by Task 1.
- Spec section "Per-domain TTL gets the fix for free" → no task needed (verified by Task 1's matcher tests).
- All test code in steps is concrete (no "add appropriate tests").
- All file paths are exact.
- Helper signature `isTabProtected(tab, ctx)` is consistent across Tasks 2, 3, 4.
- `protectionCtx` shape `{ activeTabIds, manuallyProtected, settings, allowlist }` is consistent across all three call sites.
