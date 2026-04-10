# Allowlist Consistency & Port-Aware Patterns

## Background

Two related bugs surfaced when adding entries like `app.clickup.com`, `scriptso-web.onrender.com`, `localhost`, and `localhost:3000` to the allowlist.

**Bug 1 — Allowlist consulted inconsistently.** `checkTabTTLs` correctly skips allowlisted tabs, but two other code paths do not:

- `getTabInfo` computes `isProtected` from `pinned || active || manuallyProtected || audible` and never checks the allowlist. The popup therefore renders allowlisted tabs in the Managed section with a ticking countdown, even though the TTL closer will never close them. This is the user-visible "timer at 0, but tab survives" inconsistency.
- `closeDuplicateTab` filters by pinned/active/manuallyProtected/snoozed/pendingGrace/audible but not by the allowlist. A duplicate sweep would close an allowlisted tab.

The root cause is duplicated, drifted definitions of "this tab is protected" across three call sites.

**Bug 2 — Patterns can't include a port.** `matchesPattern` compares against `URL.hostname`, which strips the port. A pattern like `localhost:3000` can never match `http://localhost:3000/`, because `new URL('http://localhost:3000').hostname === 'localhost'`. Users running multiple local dev servers on different ports cannot allowlist them individually.

## Changelog

- Add a shared `isTabProtected(tab, ctx)` helper in `background/service-worker.js`. It centralizes the definition of "this tab should not be closed" and includes an allowlist check. Three call sites — `checkTabTTLs`, `closeDuplicateTab`, and `getTabInfo` — call it instead of inlining their own checks.
- Update `matchesPattern` in `utils/domain-matcher.js` so that patterns whose host portion contains `:` are matched against `URL.host` (preserves non-default ports) instead of `URL.hostname`. Patterns without `:` keep their existing behavior.
- Add unit tests covering port-bearing patterns and the unified protection check.

## Design

### `isTabProtected` helper

Defined locally in `background/service-worker.js` because it depends on tab and storage state, not pure URL utilities.

```js
function isTabProtected(tab, ctx) {
  const { activeTabIds, manuallyProtected, settings, allowlist } = ctx;
  if (tab.pinned) return true;
  if (activeTabIds.has(tab.id)) return true;
  if (manuallyProtected.has(tab.id)) return true;
  if (isTabAudible(tab)) return true;
  if (settings.mode === 'allowlist' && matchesAny(tab.url, allowlist)) return true;
  return false;
}
```

**Excluded from the helper on purpose:**

- **Snooze and pending-grace.** These are in-flight states, not "this tab is permanently safe." `checkTabTTLs` handles each with its own branch (snooze → skip this round; pending-grace → don't re-trigger), and `closeDuplicateTab` filters them separately. Folding them in would change semantics: a snoozed duplicate would survive a dedup sweep even after the snooze expires within the same sweep.
- **Blocklist mode allowlist.** When `settings.mode !== 'allowlist'`, the allowlist is ignored (matches existing `checkTabTTLs` behavior).

**Call sites:**

- `checkTabTTLs` — replaces the inline `pinned || activeTabIds.has || manuallyProtected || audible` checks plus the `if (settings.mode === 'allowlist') ...` branch. Snooze and pending-grace branches stay as-is.
- `closeDuplicateTab` — replaces the inline filter clauses for pinned/active/manuallyProtected/audible. Snooze and pending-grace filter clauses stay as-is. Adds an allowlist check via the helper.
- `getTabInfo` — replaces the `isProtected = tab.pinned || ...` expression. The popup automatically renders newly-protected tabs in the Protected section with no UI code change.

All three sites build a `ctx` with the same shape (`activeTabIds`, `manuallyProtected`, `settings`, `allowlist`). `closeDuplicateTab` gains one extra storage read (`getAllowlist`) alongside its existing five.

### Port-aware `matchesPattern`

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

**Behavior matrix:**

| Pattern | URL | Match? | Notes |
|---|---|---|---|
| `localhost` | `http://localhost/` | ✓ | unchanged |
| `localhost` | `http://localhost:3000/foo` | ✓ | unchanged — hostname strips port |
| `localhost:3000` | `http://localhost:3000/foo` | ✓ | new — uses `u.host` |
| `localhost:3000` | `http://localhost:8080/foo` | ✗ | new — different ports distinguished |
| `localhost:3000` | `http://localhost/` | ✗ | new |
| `app.clickup.com` | `https://app.clickup.com/t/123` | ✓ | unchanged |
| `app.clickup.com/` | `https://app.clickup.com/t/123` | ✗ | unchanged — pattern with trailing slash matches only the root path; documented quirk |

**Edge cases:**

- `URL.host` omits default ports (`:80`, `:443`). A pattern like `example.com:443` will not match `https://example.com/` because `u.host` is `example.com`. This is acceptable — users should not write default ports.
- IPv6 hosts (e.g. `[::1]:3000`) are out of scope. The current matcher does not handle them; this change is not a regression.
- Subdomains of port-bound patterns (e.g. `api.localhost:3000` matching `localhost:3000`) are not supported. The `endsWith('.' + patternHost)` rule still applies but is unlikely to be useful with ports. Can be revisited if it comes up.

### Per-domain TTL

`resolveTabTTL` already routes through `matchesPattern`, so port-bearing keys in `perDomainTTL` (e.g. `{ "localhost:3000": 600000 }`) will start working automatically. No additional code change.

## Testing

### `tests/unit/domain-matcher.test.js`

New cases:

- `localhost:3000` matches `http://localhost:3000/foo`
- `localhost:3000` does not match `http://localhost:8080/foo`
- `localhost:3000` does not match `http://localhost/`
- `localhost` (bare) still matches `http://localhost:3000/` (regression guard)
- `app.clickup.com` still matches `https://app.clickup.com/t/123` (regression guard)
- `app.clickup.com/` only matches the root path (documents existing behavior)

### `tests/unit/service-worker.test.js`

New cases for the unified `isTabProtected`:

- `GET_TAB_INFO` marks an allowlisted tab as `isProtected: true` when mode is `allowlist`
- `GET_TAB_INFO` does not mark an allowlisted tab as protected when mode is `blocklist`
- `closeDuplicateTab` does not close an allowlisted duplicate when mode is `allowlist`

Existing tests for pinned/active/manuallyProtected/audible should pass unchanged — they now exercise the same helper.

### Manual verification steps

1. Set mode to Allowlist. Add `app.clickup.com`. Open `https://app.clickup.com/...`. Open the popup — the ClickUp tab should appear in the Protected section with no countdown.
2. Set a short TTL (10s). Wait. The ClickUp tab should not be closed.
3. Open two `app.clickup.com` tabs in the same window with identical URLs. Neither should be closed by duplicate detection.
4. Add `localhost:3000` to the allowlist. Open `http://localhost:3000/`. It should appear in Protected.
5. Open `http://localhost:8080/`. It should appear in Managed (different port — correctly not protected).
6. Switch to Blocklist mode. The allowlist entries should have no effect.

## Files Touched

- `utils/domain-matcher.js` — port-aware host matching
- `background/service-worker.js` — new `isTabProtected` helper; refactor three call sites
- `tests/unit/domain-matcher.test.js` — new cases
- `tests/unit/service-worker.test.js` — new cases

## Out of Scope

- Input validation in the options page (e.g. stripping `https://` prefix or trailing slash on save). Worth doing eventually as a separate UX bug.
- IPv6 host support.
- Reworking the path-matching behavior of `app.clickup.com/` (matches only root). Documented but not changed.
