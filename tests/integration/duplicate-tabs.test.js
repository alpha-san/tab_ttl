import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setTabs, resetAll, getRemovedTabIds } from '../setup.js';

let messageHandler;
let onCreatedHandler;

beforeEach(() => {
  resetAll();
});

const importPromise = import('../../background/service-worker.js').then(() => {
  messageHandler = chrome.runtime.onMessage.addListener.mock.calls[0][0];
  onCreatedHandler = chrome.tabs.onCreated.addListener.mock.calls[0][0];
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

describe('duplicate tab lifecycle', () => {
  it('immediate close on create, then periodic sweep catches restored duplicate', async () => {
    await importPromise;
    vi.useFakeTimers();
    vi.setSystemTime(10000);

    // Setup: enabled, high TTL so no TTL-based closes
    await chrome.storage.sync.set({
      settings: { enabled: true, ttl: 99999999, mode: 'blocklist', idleDetection: false, gracePeriod: 10 },
    });
    await chrome.storage.sync.set({ blocklist: [] });

    // Phase 1: Tab 1 exists, tab 2 created as duplicate → tab 1 should close
    await chrome.storage.local.set({
      tabLastAccessed: { 1: 5000 },
    });
    setTabs([
      { id: 1, windowId: 10, url: 'https://example.com', title: 'Original', favIconUrl: '', pinned: false, active: false },
      { id: 2, windowId: 10, url: 'https://example.com', title: 'Duplicate', favIconUrl: '', pinned: false, active: false },
    ]);

    await onCreatedHandler({ id: 2, windowId: 10, url: 'https://example.com' });

    expect(getRemovedTabIds()).toContain(1);
    expect(getRemovedTabIds()).not.toContain(2);

    // Verify analytics and history logged
    const { closedTabs } = await chrome.storage.local.get('closedTabs');
    expect(closedTabs).toHaveLength(1);
    expect(closedTabs[0].tabId).toBe(1);

    const { analyticsLog } = await chrome.storage.local.get('analyticsLog');
    expect(analyticsLog).toHaveLength(1);

    // Phase 2: Simulate another duplicate appearing (e.g., session restore)
    // Reset removed list for clarity
    getRemovedTabIds().length = 0;
    vi.setSystemTime(20000);

    await chrome.storage.local.set({
      tabLastAccessed: { 2: 10000, 3: 15000 },
    });
    setTabs([
      { id: 2, windowId: 10, url: 'https://example.com', title: 'Kept', pinned: false, active: false },
      { id: 3, windowId: 10, url: 'https://example.com', title: 'Restored', pinned: false, active: false },
    ]);

    await sendMessage({ type: 'FORCE_CHECK' });

    expect(getRemovedTabIds()).toContain(2);
    expect(getRemovedTabIds()).not.toContain(3);

    vi.useRealTimers();
  });
});
