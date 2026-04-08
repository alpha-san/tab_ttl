import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setTabs, resetAll } from '../setup.js';

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
