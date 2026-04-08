# Duplicate Tab Removal — Design Spec

## Summary

Auto-close older duplicate tabs when a new tab opens (or navigates to) the same URL within the same window. Duplicates are detected both immediately on tab creation/navigation and periodically via the existing alarm sweep.

## URL Matching

- URLs are compared after stripping the fragment (`#hash`) only
- Query parameters are preserved — `?tab=stars` and `?tab=repos` are distinct
- Non-http URLs (`chrome://`, `about:`, etc.) are excluded from duplicate detection

A helper function `normalizeUrlForDedup(url)` handles this:

```
normalizeUrlForDedup("https://github.com/foo#readme") → "https://github.com/foo"
normalizeUrlForDedup("chrome://extensions") → null
```

## Duplicate Resolution Strategy

When duplicates are found (same normalized URL, same window):

- The **older** tab (by `lastAccessed` timestamp) is closed
- The **newer** tab (the trigger, or most-recently-accessed) survives
- Each closed duplicate is logged to analytics (`appendAnalyticsEvent`) and closed-tab history (`addToClosedHistory`)

## Detection Triggers

### Immediate: `closeDuplicateTab(tabId)`

Called from two existing event listeners in `service-worker.js`:

1. **`chrome.tabs.onCreated`** — after `updateLastAccessed(tab.id)`
2. **`chrome.tabs.onUpdated`** — when `changeInfo.url` is present (URL navigation)

Logic:

1. Bail early if `settings.enabled` is `false`
2. Get the trigger tab via `chrome.tabs.get(tabId)` — extract URL and `windowId`
3. Normalize the URL; bail if `null`
4. Query all tabs in the same window: `chrome.tabs.query({ windowId })`
5. Find other tabs with the same normalized URL (excluding the trigger tab)
6. Filter out protected tabs (pinned, active, manually protected, snoozed, in grace period)
7. Close the remaining older duplicates
8. Log each closure to analytics and closed-tab history

### Periodic: inside `checkTabTTLs()`

Added before the existing TTL age checks to catch edge cases (session restore, URL changes while service worker was suspended):

1. Build a map: `normalizedUrl → [tab, ...]` grouped by `windowId`
2. For each group with more than one tab:
   - Filter out protected tabs
   - Sort remaining by `lastAccessed` descending (most recent first)
   - Keep the most-recently-accessed tab, close the rest
   - Log each closure to analytics and closed-tab history

## Protection Rules

A tab is **never** closed as a duplicate if any of these are true:

- Tab is pinned
- Tab is the active tab in its window
- Tab is manually protected (shield button)
- Tab is snoozed
- Tab is in grace period

If both duplicates are protected, they coexist until one loses protection.

## Edge Cases

- **Tab already closed between detection and removal:** `chrome.tabs.remove()` fails silently (existing try/catch pattern)
- **Rapid successive navigations:** Each `onUpdated` call queries current state — no stale data
- **Non-http URLs:** Skipped by `normalizeUrlForDedup` returning `null`
- **`about:blank` / new tab pages:** Skipped (not `http`)

## Settings & Permissions

- **No new settings.** Feature is tied to the existing `settings.enabled` toggle
- **No new permissions.** Existing `tabs` and `storage` permissions are sufficient
- **No UI changes** in options page or popup

## Files Modified

- `background/service-worker.js` — all changes live here:
  - New `normalizeUrlForDedup(url)` helper
  - New `closeDuplicateTab(tabId)` function
  - Updated `onCreated` and `onUpdated` listeners to call `closeDuplicateTab`
  - Updated `checkTabTTLs()` with duplicate sweep before TTL checks
