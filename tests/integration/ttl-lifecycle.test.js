import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setTabs, resetAll } from '../setup.js';

let messageHandler;
let alarmHandler;

const importPromise = import('../../background/service-worker.js').then(() => {
  messageHandler = chrome.runtime.onMessage.addListener.mock.calls[0][0];
  alarmHandler = chrome.alarms.onAlarm.addListener.mock.calls[0][0];
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

beforeEach(() => {
  resetAll();
});

describe('TTL lifecycle: expire → grace → close → history + analytics', () => {
  it('completes full lifecycle for an expired tab', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000000);

    // Setup: a tab that expired 500s ago, blocklist mode matching its domain
    await chrome.storage.sync.set({
      settings: {
        enabled: true,
        ttl: 60000,
        mode: 'blocklist',
        idleDetection: false,
        gracePeriod: 10,
      },
    });
    await chrome.storage.sync.set({ blocklist: ['example.com'] });
    setTabs([
      {
        id: 50, windowId: 1, index: 0,
        title: 'Example Page', url: 'https://example.com/page',
        favIconUrl: 'https://example.com/favicon.ico',
        pinned: false, active: false,
      },
    ]);
    await chrome.storage.local.set({
      tabLastAccessed: { 50: 500000 }, // 500s ago, well past 60s TTL
    });

    // Step 1: Trigger TTL check — should initiate grace
    await sendMessage({ type: 'FORCE_CHECK' });

    // Verify grace alarm was created
    expect(chrome.alarms.create).toHaveBeenCalledWith(
      'tabTTL-grace-50',
      { when: 1000000 + 10 * 1000 },
    );
    expect(chrome.notifications.create).toHaveBeenCalledWith(
      'grace-50',
      expect.objectContaining({
        title: 'TabTTL — Closing Tab',
      }),
    );

    // Verify pendingGrace was set
    const { pendingGrace } = await chrome.storage.local.get('pendingGrace');
    expect(pendingGrace[50]).toBeDefined();
    expect(pendingGrace[50].closeAt).toBe(1010000);

    // Step 2: Fire the grace alarm — should close the tab
    vi.setSystemTime(1010000);
    await alarmHandler({ name: 'tabTTL-grace-50' });

    // Verify tab was removed
    expect(chrome.tabs.remove).toHaveBeenCalledWith(50);

    // Verify closed tab history
    const { closedTabs } = await chrome.storage.local.get('closedTabs');
    expect(closedTabs).toHaveLength(1);
    expect(closedTabs[0].tabId).toBe(50);
    expect(closedTabs[0].url).toBe('https://example.com/page');
    expect(closedTabs[0].title).toBe('Example Page');

    // Verify analytics event
    const { analyticsLog } = await chrome.storage.local.get('analyticsLog');
    expect(analyticsLog).toHaveLength(1);
    expect(analyticsLog[0].domain).toBe('example.com');
    expect(analyticsLog[0].ageMs).toBeGreaterThan(0);

    // Verify pendingGrace was cleared
    const { pendingGrace: pg2 } = await chrome.storage.local.get('pendingGrace');
    expect(pg2[50]).toBeUndefined();

    vi.useRealTimers();
  });
});
