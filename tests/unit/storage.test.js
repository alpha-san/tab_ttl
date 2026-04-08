import { describe, it, expect } from 'vitest';
import { getSettings, getManuallyProtected, saveManuallyProtected } from '../../utils/storage.js';

describe('getSettings', () => {
  it('returns all defaults when storage is empty', async () => {
    const settings = await getSettings();
    expect(settings.enabled).toBe(true);
    expect(settings.ttl).toBe(5 * 60 * 1000);
    expect(settings.mode).toBe('blocklist');
    expect(settings.gracePeriod).toBe(15);
    expect(settings.idleDetection).toBe(true);
    expect(settings.idleThreshold).toBe(60);
    expect(settings.snoozeMinutes).toBe(10);
    expect(settings.streakTabLimit).toBe(20);
  });

  it('merges stored overrides with defaults', async () => {
    await chrome.storage.sync.set({ settings: { ttl: 999, enabled: false } });
    const settings = await getSettings();
    expect(settings.enabled).toBe(false);
    expect(settings.ttl).toBe(999);
    expect(settings.gracePeriod).toBe(15);
    expect(settings.mode).toBe('blocklist');
  });
});

describe('getManuallyProtected / saveManuallyProtected', () => {
  it('returns empty Set when storage is empty', async () => {
    const set = await getManuallyProtected();
    expect(set).toBeInstanceOf(Set);
    expect(set.size).toBe(0);
  });

  it('round-trips through save and get', async () => {
    const original = new Set([1, 2, 3]);
    await saveManuallyProtected(original);
    const loaded = await getManuallyProtected();
    expect(loaded).toBeInstanceOf(Set);
    expect([...loaded].sort()).toEqual([1, 2, 3]);
  });

  it('preserves Set semantics (no duplicates)', async () => {
    const set = new Set([5, 5, 5]);
    await saveManuallyProtected(set);
    const loaded = await getManuallyProtected();
    expect(loaded.size).toBe(1);
    expect(loaded.has(5)).toBe(true);
  });
});
