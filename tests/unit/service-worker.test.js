import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setTabs, resetAll, getRemovedTabIds, getAlarms } from '../setup.js';

// Dynamic import so Chrome mock is in place when module loads
let messageHandler;
let alarmHandler;
let onRemovedHandler;
let onCreatedHandler;
let onUpdatedHandler;

beforeEach(() => {
  resetAll();
});

// Import once — extract listeners
const importPromise = import('../../background/service-worker.js').then(() => {
  messageHandler = chrome.runtime.onMessage.addListener.mock.calls[0][0];
  alarmHandler = chrome.alarms.onAlarm.addListener.mock.calls[0][0];
  onRemovedHandler = chrome.tabs.onRemoved.addListener.mock.calls[0][0];
  onCreatedHandler = chrome.tabs.onCreated.addListener.mock.calls[0][0];
  onUpdatedHandler = chrome.tabs.onUpdated.addListener.mock.calls[0][0];
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
    expect(result.tabs[0].isProtected).toBe(true);
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

  it('skips snoozed duplicate tabs', async () => {
    await importPromise;
    vi.useFakeTimers();
    vi.setSystemTime(2000);

    await chrome.storage.sync.set({
      settings: { enabled: true, ttl: 60000, mode: 'blocklist', idleDetection: false, gracePeriod: 10 },
    });
    await chrome.storage.local.set({
      tabLastAccessed: { 1: 1000, 2: 2000 },
      snoozed: { 1: 9999999 },
    });

    setTabs([
      { id: 1, windowId: 10, url: 'https://example.com/page', pinned: false, active: false },
      { id: 2, windowId: 10, url: 'https://example.com/page', pinned: false, active: false },
    ]);

    await onCreatedHandler({ id: 2, windowId: 10, url: 'https://example.com/page' });

    expect(getRemovedTabIds()).toEqual([]);
    vi.useRealTimers();
  });

  it('skips duplicate tabs in grace period', async () => {
    await importPromise;
    vi.useFakeTimers();
    vi.setSystemTime(2000);

    await chrome.storage.sync.set({
      settings: { enabled: true, ttl: 60000, mode: 'blocklist', idleDetection: false, gracePeriod: 10 },
    });
    await chrome.storage.local.set({
      tabLastAccessed: { 1: 1000, 2: 2000 },
      pendingGrace: { 1: { tabId: 1, closeAt: 5000 } },
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

    it('does not initiate grace for tab already closed as duplicate', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000000);

      // Tab 1 is a duplicate AND TTL-expired — dedup should close it,
      // and the TTL loop should NOT create a grace alarm for it.
      await chrome.storage.sync.set({
        settings: { enabled: true, ttl: 1000, mode: 'blocklist', idleDetection: false, gracePeriod: 10 },
      });
      await chrome.storage.sync.set({ blocklist: ['example.com'] });
      await chrome.storage.local.set({
        tabLastAccessed: { 1: 0, 2: 900000 },
      });

      setTabs([
        { id: 1, windowId: 10, url: 'https://example.com/page', title: 'Old', pinned: false, active: false },
        { id: 2, windowId: 10, url: 'https://example.com/page', title: 'New', pinned: false, active: false },
      ]);

      await sendMessage({ type: 'FORCE_CHECK' });

      // Tab 1 should be closed as a duplicate
      expect(getRemovedTabIds()).toContain(1);
      // No grace alarm should be created for tab 1 (it was already closed as a duplicate)
      expect(getAlarms().has('tabTTL-grace-1')).toBe(false);
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
});
