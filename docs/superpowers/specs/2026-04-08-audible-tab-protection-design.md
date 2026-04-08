# Audible Tab Protection

## Summary

Prevent TabTTL from closing tabs that are actively playing unmuted audio. Audible tabs are treated as fully immune — like pinned tabs — across TTL checks, duplicate sweeps, and grace period closes. The popup UI shows a speaker indicator for audible-protected tabs.

## Detection

A tab is "audible-protected" when both conditions are met:

- `tab.audible === true` (Chrome reports the tab is producing audio)
- `tab.mutedInfo?.muted === false` (the user has not muted the tab)

No new permissions, APIs, or storage are needed. The `tab` object from `chrome.tabs.query()` and `chrome.tabs.get()` already includes both fields.

## Changes

### 1. TTL Check (`checkTabTTLs()`)

In the main TTL loop (after the existing `pinned`/`active`/`manuallyProtected` checks), skip tabs where `tab.audible && !tab.mutedInfo?.muted`.

In the duplicate sweep section, add the same check to the `eligible` filter so audible tabs are not closed as duplicates.

### 2. Duplicate Tab Close (`closeDuplicateTab()`)

Add `tab.audible && !tab.mutedInfo?.muted` to the duplicate filter so audible tabs are excluded from dedup closure.

### 3. Grace Period Close (`closeTabAfterGrace()`)

Before closing, re-fetch the tab and check audible state. If the tab is now audible and unmuted, cancel the grace close instead of removing the tab.

### 4. Proactive Grace Cancellation (`onUpdated` listener)

When `changeInfo.audible === true` fires in the existing `chrome.tabs.onUpdated` listener:

1. Fetch the full tab object (to get `mutedInfo`)
2. If the tab is unmuted and has a pending grace period, call `cancelGrace(tabId)` and `updateLastAccessed(tabId)` to cancel the close and reset the TTL clock

This handles the edge case where a tab enters grace period and then starts playing audio (e.g., a music site that takes a moment to begin playback).

### 5. Popup Tab Info (`getTabInfo()`)

- Add an `audible` boolean to the returned tab info, derived from `tab.audible && !tab.mutedInfo?.muted`
- Factor `audible` into `isProtected` so the TTL bar shows no countdown for audible tabs
- Display a speaker indicator in the popup alongside existing pinned/snoozed/protected indicators

## Testing

1. TTL check skips audible unmuted tabs (does not enter grace period)
2. TTL check does NOT skip audible muted tabs (proceeds normally)
3. Dedup skips audible tabs in both `checkTabTTLs()` sweep and `closeDuplicateTab()`
4. `closeTabAfterGrace()` cancels instead of closing if tab became audible
5. `onUpdated` with `audible: true` cancels pending grace and resets TTL
6. `getTabInfo()` returns audible state and marks tab as protected
