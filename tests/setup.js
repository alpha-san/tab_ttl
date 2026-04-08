import { vi, beforeEach } from 'vitest';

function makeStorage() {
  let store = {};
  return {
    get: vi.fn(async (key) => {
      if (typeof key === 'string') {
        return key in store ? { [key]: structuredClone(store[key]) } : {};
      }
      if (Array.isArray(key)) {
        const result = {};
        for (const k of key) {
          if (k in store) result[k] = structuredClone(store[k]);
        }
        return result;
      }
      return { ...store };
    }),
    set: vi.fn(async (items) => {
      Object.assign(store, structuredClone(items));
    }),
    clear: vi.fn(async () => {
      for (const k of Object.keys(store)) delete store[k];
    }),
    _reset() {
      for (const k of Object.keys(store)) delete store[k];
    },
  };
}

const syncStorage = makeStorage();
const localStorage = makeStorage();
const sessionStorage = makeStorage();

const alarms = new Map();
const tabs = [];
const removedTabIds = [];
const createdTabs = [];

globalThis.chrome = {
  storage: {
    sync: syncStorage,
    local: localStorage,
    session: sessionStorage,
  },
  tabs: {
    query: vi.fn(async (filter) => {
      let result = [...tabs];
      if (filter && filter.active === true) {
        result = result.filter(t => t.active);
      }
      return result;
    }),
    get: vi.fn(async (id) => {
      const tab = tabs.find(t => t.id === id);
      if (!tab) throw new Error(`No tab with id ${id}`);
      return tab;
    }),
    remove: vi.fn(async (id) => { removedTabIds.push(id); }),
    create: vi.fn(async (opts) => { createdTabs.push(opts); return { id: 999, ...opts }; }),
    onActivated: { addListener: vi.fn() },
    onUpdated: { addListener: vi.fn() },
    onCreated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
  },
  alarms: {
    create: vi.fn((name, opts) => { alarms.set(name, opts); }),
    clear: vi.fn(async (name) => { alarms.delete(name); }),
    onAlarm: { addListener: vi.fn() },
  },
  notifications: {
    create: vi.fn(async () => {}),
    clear: vi.fn(() => {}),
    onButtonClicked: { addListener: vi.fn() },
  },
  idle: {
    queryState: vi.fn(async () => 'active'),
  },
  runtime: {
    getURL: vi.fn((path) => path),
    onInstalled: { addListener: vi.fn() },
    onStartup: { addListener: vi.fn() },
    onMessage: { addListener: vi.fn() },
  },
};

export function resetChromeStorage() {
  syncStorage._reset();
  localStorage._reset();
  sessionStorage._reset();
}

export function setTabs(newTabs) {
  tabs.length = 0;
  tabs.push(...newTabs);
}

export function getRemovedTabIds() {
  return removedTabIds;
}

export function getCreatedTabs() {
  return createdTabs;
}

export function getAlarms() {
  return alarms;
}

export function resetAll() {
  resetChromeStorage();
  tabs.length = 0;
  removedTabIds.length = 0;
  createdTabs.length = 0;
  alarms.clear();

  chrome.tabs.query.mockClear();
  chrome.tabs.get.mockClear();
  chrome.tabs.remove.mockClear();
  chrome.tabs.create.mockClear();
  chrome.alarms.create.mockClear();
  chrome.alarms.clear.mockClear();
  chrome.notifications.create.mockClear();
  chrome.notifications.clear.mockClear();
  chrome.idle.queryState.mockReturnValue(Promise.resolve('active'));
}

beforeEach(() => {
  resetAll();
});
