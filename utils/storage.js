import {
  DEFAULT_TTL_MS,
  DEFAULT_GRACE_PERIOD_S,
  DEFAULT_SNOOZE_MINUTES,
  DEFAULT_IDLE_THRESHOLD_S,
  MODE_BLOCKLIST,
  DEFAULT_STREAK_TAB_LIMIT,
} from './constants.js';

const DEFAULT_SETTINGS = {
  enabled: true,
  ttl: DEFAULT_TTL_MS,
  mode: MODE_BLOCKLIST,
  gracePeriod: DEFAULT_GRACE_PERIOD_S,
  idleDetection: true,
  idleThreshold: DEFAULT_IDLE_THRESHOLD_S,
  snoozeMinutes: DEFAULT_SNOOZE_MINUTES,
  streakTabLimit: DEFAULT_STREAK_TAB_LIMIT,
};

// ─── Settings ────────────────────────────────────────────────────────────────

export async function getSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
}

export async function saveSettings(settings) {
  await chrome.storage.sync.set({ settings });
}

// ─── Domain lists ─────────────────────────────────────────────────────────────

export async function getAllowlist() {
  const { allowlist } = await chrome.storage.sync.get('allowlist');
  return allowlist ?? [];
}

export async function saveAllowlist(domains) {
  await chrome.storage.sync.set({ allowlist: domains });
}

export async function getBlocklist() {
  const { blocklist } = await chrome.storage.sync.get('blocklist');
  return blocklist ?? [];
}

export async function saveBlocklist(domains) {
  await chrome.storage.sync.set({ blocklist: domains });
}

// ─── Per-domain TTL ───────────────────────────────────────────────────────────

export async function getPerDomainTTL() {
  const { perDomainTTL } = await chrome.storage.sync.get('perDomainTTL');
  return perDomainTTL ?? {};
}

export async function savePerDomainTTL(map) {
  await chrome.storage.sync.set({ perDomainTTL: map });
}

// ─── Tab last-accessed timestamps (local, tab-id keyed) ───────────────────────

export async function getTabLastAccessed() {
  const { tabLastAccessed } = await chrome.storage.local.get('tabLastAccessed');
  return tabLastAccessed ?? {};
}

export async function saveTabLastAccessed(data) {
  await chrome.storage.local.set({ tabLastAccessed: data });
}

// ─── Snoozed tabs (local, tab-id keyed → snooze expiry timestamp) ─────────────

export async function getSnoozed() {
  const { snoozed } = await chrome.storage.local.get('snoozed');
  return snoozed ?? {};
}

export async function saveSnoozed(data) {
  await chrome.storage.local.set({ snoozed: data });
}

// ─── Pending grace-period closes (local, tab-id keyed) ────────────────────────

export async function getPendingGrace() {
  const { pendingGrace } = await chrome.storage.local.get('pendingGrace');
  return pendingGrace ?? {};
}

export async function savePendingGrace(data) {
  await chrome.storage.local.set({ pendingGrace: data });
}

// ─── Closed tab history (local) ───────────────────────────────────────────────

export async function getClosedTabs() {
  const { closedTabs } = await chrome.storage.local.get('closedTabs');
  return closedTabs ?? [];
}

export async function saveClosedTabs(tabs) {
  await chrome.storage.local.set({ closedTabs: tabs });
}

// ─── Analytics log (local) ────────────────────────────────────────────────────

export async function getAnalyticsLog() {
  const { analyticsLog } = await chrome.storage.local.get('analyticsLog');
  return analyticsLog ?? [];
}

export async function saveAnalyticsLog(log) {
  await chrome.storage.local.set({ analyticsLog: log });
}

// ─── Analytics state (local) ─────────────────────────────────────────────────

export async function getAnalyticsState() {
  const { analyticsState } = await chrome.storage.local.get('analyticsState');
  return analyticsState ?? {
    streakData: {
      currentStreak: 0,
      bestStreak: 0,
      lastCheckedDate: null,
      lastStreakBrokenDate: null,
    },
  };
}

export async function saveAnalyticsState(state) {
  await chrome.storage.local.set({ analyticsState: state });
}
