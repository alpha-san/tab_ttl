import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  filterByRange,
  computeReport,
  computeTopDomains,
  computeHourlyDistribution,
  formatDuration,
} from '../../utils/analytics.js';

describe('filterByRange', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns entries within the time window', () => {
    vi.setSystemTime(10000);
    const log = [
      { ts: 5000, domain: 'a.com' },
      { ts: 8000, domain: 'b.com' },
      { ts: 2000, domain: 'c.com' },
    ];
    const result = filterByRange(log, 6000); // cutoff = 4000
    expect(result).toHaveLength(2);
    expect(result.map(e => e.domain)).toEqual(['a.com', 'b.com']);
  });

  it('returns empty array for empty log', () => {
    vi.setSystemTime(10000);
    expect(filterByRange([], 5000)).toEqual([]);
  });

  it('includes entries exactly on the boundary', () => {
    vi.setSystemTime(10000);
    const log = [{ ts: 4000, domain: 'edge.com' }];
    const result = filterByRange(log, 6000); // cutoff = 4000
    expect(result).toHaveLength(1);
  });
});

describe('computeReport', () => {
  it('computes correct stats from log entries', () => {
    const log = [
      { ts: 1000, domain: 'a.com', ttlMs: 60000 },
      { ts: 2000, domain: 'b.com', ttlMs: 30000 },
      { ts: 3000, domain: 'a.com', ttlMs: 60000 },
    ];
    const report = computeReport(log);
    expect(report.tabsClosed).toBe(3);
    expect(report.timeSavedMs).toBe(150000);
    expect(report.memoryMB).toBe(3 * 75);
    expect(report.topDomains[0]).toEqual({ domain: 'a.com', count: 2 });
  });

  it('returns zeros for empty log', () => {
    const report = computeReport([]);
    expect(report.tabsClosed).toBe(0);
    expect(report.timeSavedMs).toBe(0);
    expect(report.memoryMB).toBe(0);
    expect(report.topDomains).toEqual([]);
  });

  it('handles entries with missing ttlMs', () => {
    const log = [{ ts: 1000, domain: 'x.com' }];
    const report = computeReport(log);
    expect(report.timeSavedMs).toBe(0);
  });
});

describe('computeTopDomains', () => {
  it('ranks domains by count descending', () => {
    const log = [
      { domain: 'b.com' }, { domain: 'a.com' },
      { domain: 'a.com' }, { domain: 'b.com' },
      { domain: 'a.com' },
    ];
    const result = computeTopDomains(log);
    expect(result[0]).toEqual({ domain: 'a.com', count: 3 });
    expect(result[1]).toEqual({ domain: 'b.com', count: 2 });
  });

  it('respects topN limit', () => {
    const log = [
      { domain: 'a.com' }, { domain: 'b.com' }, { domain: 'c.com' },
    ];
    const result = computeTopDomains(log, 2);
    expect(result).toHaveLength(2);
  });

  it('groups missing domain as (unknown)', () => {
    const log = [{ domain: '' }, { domain: undefined }];
    const result = computeTopDomains(log);
    expect(result[0]).toEqual({ domain: '(unknown)', count: 2 });
  });
});

describe('computeHourlyDistribution', () => {
  it('buckets events by hour', () => {
    const noon = new Date('2026-01-15T12:30:00').getTime();
    const oneAm = new Date('2026-01-15T01:00:00').getTime();
    const log = [{ ts: noon }, { ts: noon }, { ts: oneAm }];
    const hours = computeHourlyDistribution(log);
    expect(hours).toHaveLength(24);
    expect(hours[12]).toBe(2);
    expect(hours[1]).toBe(1);
    expect(hours[0]).toBe(0);
  });

  it('returns all zeros for empty log', () => {
    const hours = computeHourlyDistribution([]);
    expect(hours).toHaveLength(24);
    expect(hours.every(h => h === 0)).toBe(true);
  });
});

describe('formatDuration', () => {
  it('formats zero', () => expect(formatDuration(0)).toBe('0s'));
  it('formats negative as 0s', () => expect(formatDuration(-1000)).toBe('0s'));
  it('formats seconds', () => expect(formatDuration(45000)).toBe('45s'));
  it('formats minutes and seconds', () => expect(formatDuration(125000)).toBe('2m 5s'));
  it('formats hours and minutes', () => expect(formatDuration(3720000)).toBe('1h 2m'));
  it('formats days and hours', () => expect(formatDuration(90000000)).toBe('1d 1h'));
});
