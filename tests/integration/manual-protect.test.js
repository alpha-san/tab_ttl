import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setTabs, resetAll } from '../setup.js';

let messageHandler;
let onRemovedHandler;

const importPromise = import('../../background/service-worker.js').then(() => {
  messageHandler = chrome.runtime.onMessage.addListener.mock.calls[0][0];
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

beforeEach(() => {
  resetAll();
});

describe('Manual protection lifecycle', () => {
  const TAB_ID = 77;

  async function setupExpiredTab() {
    vi.useFakeTimers();
    vi.setSystemTime(1000000);
    await chrome.storage.sync.set({
      settings: {
        enabled: true,
        ttl: 60000,
        mode: 'blocklist',
        idleDetection: false,
        gracePeriod: 10,
      },
    });
    await chrome.storage.sync.set({ blocklist: ['test.com'] });
    setTabs([
      {
        id: TAB_ID, windowId: 1, index: 0,
        title: 'Test', url: 'https://test.com',
        pinned: false, active: false,
      },
    ]);
    await chrome.storage.local.set({
      tabLastAccessed: { [TAB_ID]: 0 }, // well past TTL
    });
  }

  it('protected tab is skipped during TTL check', async () => {
    await setupExpiredTab();

    // Protect the tab
    const result = await sendMessage({ type: 'TOGGLE_PROTECT_TAB', tabId: TAB_ID });
    expect(result.protected).toBe(true);

    // Force check — should NOT initiate grace
    await sendMessage({ type: 'FORCE_CHECK' });
    expect(chrome.notifications.create).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('unprotected tab becomes eligible again', async () => {
    await setupExpiredTab();

    // Protect, then unprotect
    await sendMessage({ type: 'TOGGLE_PROTECT_TAB', tabId: TAB_ID });
    const result = await sendMessage({ type: 'TOGGLE_PROTECT_TAB', tabId: TAB_ID });
    expect(result.protected).toBe(false);

    // Force check — should initiate grace now
    await sendMessage({ type: 'FORCE_CHECK' });
    expect(chrome.alarms.create).toHaveBeenCalledWith(
      `tabTTL-grace-${TAB_ID}`,
      expect.objectContaining({ when: expect.any(Number) }),
    );

    vi.useRealTimers();
  });

  it('cleanup on tab removal removes protection', async () => {
    await importPromise;
    await chrome.storage.session.set({ manuallyProtected: [TAB_ID] });
    await chrome.storage.local.set({
      tabLastAccessed: { [TAB_ID]: 1000 },
      snoozed: {},
    });

    // Simulate tab close
    await onRemovedHandler(TAB_ID);

    const { manuallyProtected } = await chrome.storage.session.get('manuallyProtected');
    expect(manuallyProtected).not.toContain(TAB_ID);
  });

  it('GET_TAB_INFO reflects manual protection status', async () => {
    await setupExpiredTab();

    // Protect the tab
    await sendMessage({ type: 'TOGGLE_PROTECT_TAB', tabId: TAB_ID });

    const info = await sendMessage({ type: 'GET_TAB_INFO' });
    const tab = info.tabs.find(t => t.id === TAB_ID);
    expect(tab.manuallyProtected).toBe(true);
    expect(tab.isProtected).toBe(true);

    vi.useRealTimers();
  });
});
