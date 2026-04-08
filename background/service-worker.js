import {
  ALARM_CHECK,
  ALARM_GRACE_PREFIX,
  ALARM_INTERVAL_MINUTES,
  CLOSED_TABS_MAX,
  ANALYTICS_LOG_MAX_DAYS,
  ANALYTICS_LOG_MAX_ENTRIES,
} from '../utils/constants.js';
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
import { matchesAny } from '../utils/domain-matcher.js';

// ─── Initialization ───────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  await initAlarm();
  await syncExistingTabs();
});

chrome.runtime.onStartup.addListener(async () => {
  await initAlarm();
  await syncExistingTabs();
});

async function initAlarm() {
  await chrome.alarms.clear(ALARM_CHECK);
  chrome.alarms.create(ALARM_CHECK, { periodInMinutes: ALARM_INTERVAL_MINUTES });
}

// Ensure every already-open tab has a lastAccessed entry.
async function syncExistingTabs() {
  const tabs = await chrome.tabs.query({});
  const lastAccessed = await getTabLastAccessed();
  const now = Date.now();
  for (const tab of tabs) {
    if (tab.id != null && !(tab.id in lastAccessed)) {
      lastAccessed[tab.id] = now;
    }
  }
  await saveTabLastAccessed(lastAccessed);
}

// ─── Tab event listeners ──────────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await updateLastAccessed(tabId);
  // If the user switches to a tab that was in grace period, cancel the close.
  await cancelGrace(tabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'loading') {
    await updateLastAccessed(tabId);
  }
  if (changeInfo.url) {
    await closeDuplicateTab(tabId);
  }
});

chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.id != null) {
    await updateLastAccessed(tab.id);
    await closeDuplicateTab(tab.id);
  }
});

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

async function updateLastAccessed(tabId) {
  const lastAccessed = await getTabLastAccessed();
  lastAccessed[tabId] = Date.now();
  await saveTabLastAccessed(lastAccessed);
}

// ─── Alarm handler ────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_CHECK) {
    await checkTabTTLs();
  } else if (alarm.name.startsWith(ALARM_GRACE_PREFIX)) {
    const tabId = parseInt(alarm.name.slice(ALARM_GRACE_PREFIX.length), 10);
    if (!isNaN(tabId)) await closeTabAfterGrace(tabId);
  }
});

// ─── TTL check ────────────────────────────────────────────────────────────────

async function checkTabTTLs() {
  const settings = await getSettings();
  if (!settings.enabled) return;

  // Idle detection: pause closing when user is away from their computer so
  // that tabs aren't cleaned up unnoticed. Closing resumes when they return.
  if (settings.idleDetection) {
    const state = await chrome.idle.queryState(settings.idleThreshold);
    if (state !== 'active') return;
  }

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

  const now = Date.now();
  const allTabs = await chrome.tabs.query({});

  // Collect active tab IDs across all windows.
  const activeTabs = await chrome.tabs.query({ active: true });
  const activeTabIds = new Set(activeTabs.map(t => t.id));

  for (const tab of allTabs) {
    if (tab.id == null) continue;
    if (tab.pinned) continue;                    // Never close pinned tabs
    if (manuallyProtected.has(tab.id)) continue; // Never close manually protected tabs
    if (activeTabIds.has(tab.id)) continue;      // Never close active tab
    if (pendingGrace[tab.id]) continue;          // Already queued for grace close

    const url = tab.url ?? '';
    if (!url.startsWith('http')) continue;       // Skip chrome://, about:, etc.

    // Apply mode filter.
    if (settings.mode === 'allowlist') {
      if (matchesAny(url, allowlist)) continue;  // On safe list — protect it
    } else {
      if (!matchesAny(url, blocklist)) continue; // Not on block list — skip
    }

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

  await checkStreak(settings);
}

/**
 * Return the per-domain TTL for a URL if one exists, otherwise the global TTL.
 */
function resolveTabTTL(url, perDomainTTL, globalTTL) {
  try {
    const hostname = new URL(url).hostname;
    for (const [pattern, ttl] of Object.entries(perDomainTTL)) {
      if (hostname === pattern || hostname.endsWith('.' + pattern)) return ttl;
    }
  } catch { /* ignore */ }
  return globalTTL;
}

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
  const [lastAccessed, snoozed, pendingGrace, manuallyProtected, perDomainTTL] = await Promise.all([
    getTabLastAccessed(),
    getSnoozed(),
    getPendingGrace(),
    getManuallyProtected(),
    getPerDomainTTL(),
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

// ─── Grace period ─────────────────────────────────────────────────────────────

async function initiateGraceClose(tab, gracePeriodSeconds) {
  const pendingGrace = await getPendingGrace();
  if (pendingGrace[tab.id]) return;

  const closeAt = Date.now() + gracePeriodSeconds * 1000;
  pendingGrace[tab.id] = {
    tabId: tab.id,
    url: tab.url,
    title: tab.title,
    closeAt,
  };
  await savePendingGrace(pendingGrace);

  // One-shot alarm that survives service worker suspension.
  chrome.alarms.create(`${ALARM_GRACE_PREFIX}${tab.id}`, { when: closeAt });

  try {
    await chrome.notifications.create(`grace-${tab.id}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon.svg'),
      title: 'TabTTL — Closing Tab',
      message: `"${tab.title || tab.url}" closes in ${gracePeriodSeconds}s`,
      buttons: [{ title: 'Keep Open' }],
      requireInteraction: true,
    });
  } catch (e) {
    console.warn('TabTTL: notification failed:', e);
  }
}

async function closeTabAfterGrace(tabId) {
  const pendingGrace = await getPendingGrace();
  if (!pendingGrace[tabId]) return;

  delete pendingGrace[tabId];
  await savePendingGrace(pendingGrace);
  chrome.notifications.clear(`grace-${tabId}`);

  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.active || tab.pinned) return; // Last-second protection
    const manuallyProtected = await getManuallyProtected();
    if (manuallyProtected.has(tabId)) return; // Grace state already cleared above; TTL re-evaluated on next alarm tick

    const ts = Date.now();
    const lastAccessed = await getTabLastAccessed();
    const openedAt = lastAccessed[tabId] ?? ts;

    let domain = '';
    let ttlMs = 0;
    try {
      domain = new URL(tab.url).hostname;
      const [settings, perDomainTTL] = await Promise.all([getSettings(), getPerDomainTTL()]);
      ttlMs = resolveTabTTL(tab.url, perDomainTTL, settings.ttl);
    } catch { /* ignore */ }

    await appendAnalyticsEvent({ ts, openedAt, domain, ttlMs, ageMs: ts - openedAt });

    await addToClosedHistory({
      tabId,
      url: tab.url,
      title: tab.title,
      favIconUrl: tab.favIconUrl,
      closedAt: ts,
    });

    await chrome.tabs.remove(tabId);
  } catch {
    // Tab was already closed manually — nothing to do.
  }
}

async function cancelGrace(tabId, removeFromHistory = false) {
  const pendingGrace = await getPendingGrace();
  if (!pendingGrace[tabId]) return;

  delete pendingGrace[tabId];
  await savePendingGrace(pendingGrace);
  await chrome.alarms.clear(`${ALARM_GRACE_PREFIX}${tabId}`);
  chrome.notifications.clear(`grace-${tabId}`);
}

// ─── Notification interactions ────────────────────────────────────────────────

chrome.notifications.onButtonClicked.addListener(async (notifId, buttonIndex) => {
  // "Keep Open" button (index 0)
  if (notifId.startsWith('grace-') && buttonIndex === 0) {
    const tabId = parseInt(notifId.slice('grace-'.length), 10);
    if (!isNaN(tabId)) {
      await cancelGrace(tabId);
      await updateLastAccessed(tabId); // Reset TTL clock
    }
  }
});

// ─── Closed tab history ───────────────────────────────────────────────────────

async function addToClosedHistory(entry) {
  const history = await getClosedTabs();
  history.unshift(entry); // Most recent first
  if (history.length > CLOSED_TABS_MAX) history.length = CLOSED_TABS_MAX;
  await saveClosedTabs(history);
}

// ─── Analytics ────────────────────────────────────────────────────────────────

async function appendAnalyticsEvent(event) {
  const log = await getAnalyticsLog();
  log.push(event);

  const cutoff = Date.now() - ANALYTICS_LOG_MAX_DAYS * 24 * 60 * 60 * 1000;
  const pruned = log.filter(e => e.ts >= cutoff);

  // Cap at max entries (keep most recent)
  if (pruned.length > ANALYTICS_LOG_MAX_ENTRIES) {
    pruned.splice(0, pruned.length - ANALYTICS_LOG_MAX_ENTRIES);
  }

  await saveAnalyticsLog(pruned);
}

async function checkStreak(settings) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const state = await getAnalyticsState();
  const { streakData } = state;

  if (streakData.lastCheckedDate === today) return;

  const allTabs = await chrome.tabs.query({});
  const tabCount = allTabs.length;
  const limit = settings.streakTabLimit ?? 20;

  if (tabCount <= limit) {
    streakData.currentStreak = (streakData.currentStreak ?? 0) + 1;
    streakData.bestStreak = Math.max(streakData.bestStreak ?? 0, streakData.currentStreak);
  } else {
    streakData.lastStreakBrokenDate = today;
    streakData.currentStreak = 0;
  }
  streakData.lastCheckedDate = today;

  await saveAnalyticsState({ ...state, streakData });
}

// ─── Message handler (popup / options) ───────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message }));
  return true; // Keep channel open for async response
});

async function handleMessage(message) {
  switch (message.type) {
    case 'GET_TAB_INFO':
      return getTabInfo();

    case 'SNOOZE_TAB': {
      const { tabId, minutes } = message;
      const snoozed = await getSnoozed();
      snoozed[tabId] = Date.now() + minutes * 60 * 1000;
      await saveSnoozed(snoozed);
      await cancelGrace(tabId);
      return { ok: true };
    }

    case 'CANCEL_GRACE':
      await cancelGrace(message.tabId);
      await updateLastAccessed(message.tabId);
      return { ok: true };

    case 'RESTORE_TAB':
      await chrome.tabs.create({ url: message.url, active: false });
      return { ok: true };

    case 'CLEAR_HISTORY':
      await saveClosedTabs([]);
      return { ok: true };

    case 'GET_CLOSED_TABS':
      return { tabs: await getClosedTabs() };

    case 'FORCE_CHECK':
      await checkTabTTLs();
      return { ok: true };

    case 'GET_ANALYTICS_DATA': {
      const [log, state] = await Promise.all([getAnalyticsLog(), getAnalyticsState()]);
      return { log, state };
    }

    case 'CLEAR_ANALYTICS':
      await saveAnalyticsLog([]);
      return { ok: true };

    case 'TOGGLE_PROTECT_TAB': {
      const set = await getManuallyProtected();
      const isNowProtected = !set.has(message.tabId);
      if (isNowProtected) {
        set.add(message.tabId);
      } else {
        set.delete(message.tabId);
      }
      await saveManuallyProtected(set);
      return { protected: isNowProtected };
    }

    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}

// ─── Tab info for popup ───────────────────────────────────────────────────────

async function getTabInfo() {
  const [settings, lastAccessed, snoozed, pendingGrace, manuallyProtected] = await Promise.all([
    getSettings(),
    getTabLastAccessed(),
    getSnoozed(),
    getPendingGrace(),
    getManuallyProtected(),
  ]);

  const allTabs = await chrome.tabs.query({});
  const activeTabs = await chrome.tabs.query({ active: true });
  const activeTabIds = new Set(activeTabs.map(t => t.id));

  const now = Date.now();

  const tabs = allTabs.map(tab => {
    const accessed = lastAccessed[tab.id] ?? now;
    const age = now - accessed;
    const isManuallyProtected = manuallyProtected.has(tab.id);
    const isProtected = tab.pinned || activeTabIds.has(tab.id) || isManuallyProtected;
    const snoozeUntil = snoozed[tab.id] ?? null;
    const isSnoozed = snoozeUntil != null && snoozeUntil > now;
    const inGrace = !!pendingGrace[tab.id];
    const ttl = resolveTabTTL(tab.url ?? '', {}, settings.ttl);

    return {
      id: tab.id,
      windowId: tab.windowId,
      index: tab.index,
      title: tab.title,
      url: tab.url,
      favIconUrl: tab.favIconUrl,
      pinned: tab.pinned,
      active: activeTabIds.has(tab.id),
      isProtected,
      manuallyProtected: isManuallyProtected,
      age,
      ttl,
      remaining: isProtected || isSnoozed ? null : Math.max(0, ttl - age),
      snoozeUntil,
      isSnoozed,
      inGrace,
    };
  });

  return { tabs, settings };
}
