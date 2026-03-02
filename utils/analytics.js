// utils/analytics.js — pure computation functions (no chrome API, no DOM)

import { MEMORY_PER_TAB_MB } from './constants.js';

/**
 * Filter log entries to those within sinceMs milliseconds of now.
 * @param {Array} log
 * @param {number} sinceMs
 * @returns {Array}
 */
export function filterByRange(log, sinceMs) {
  const cutoff = Date.now() - sinceMs;
  return log.filter(e => e.ts >= cutoff);
}

/**
 * Compute summary report from a log slice.
 * @param {Array} log
 * @param {number} period — ms, used only as a label carrier; caller pre-filters
 * @returns {{ tabsClosed: number, timeSavedMs: number, memoryMB: number, topDomains: Array }}
 */
export function computeReport(log) {
  const tabsClosed = log.length;
  const timeSavedMs = log.reduce((sum, e) => sum + (e.ttlMs ?? 0), 0);
  const memoryMB = tabsClosed * MEMORY_PER_TAB_MB;
  const topDomains = computeTopDomains(log, 5);
  return { tabsClosed, timeSavedMs, memoryMB, topDomains };
}

/**
 * Compute the top N domains by close count.
 * @param {Array} log
 * @param {number} [topN=15]
 * @returns {Array<{domain: string, count: number}>}
 */
export function computeTopDomains(log, topN = 15) {
  const counts = {};
  for (const e of log) {
    const d = e.domain || '(unknown)';
    counts[d] = (counts[d] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);
}

/**
 * Compute close-event counts bucketed by hour of day (local time).
 * @param {Array} log
 * @returns {number[]} — length 24, index = hour (0–23)
 */
export function computeHourlyDistribution(log) {
  const hours = new Array(24).fill(0);
  for (const e of log) {
    const h = new Date(e.ts).getHours();
    hours[h]++;
  }
  return hours;
}

/**
 * Format a duration in ms to a human-readable string.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (ms <= 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;

  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
