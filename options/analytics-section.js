// analytics-section.js — Analytics tab rendering for the options page

import {
  filterByRange,
  computeReport,
  computeTopDomains,
  computeHourlyDistribution,
  formatDuration,
} from '../utils/analytics.js';

const WEEK_MS  = 7  * 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

const $ = id => document.getElementById(id);

let currentLog   = [];
let currentState = null;
let currentPeriod = WEEK_MS;

export async function initAnalyticsSection() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_ANALYTICS_DATA' });
  currentLog   = response.log   ?? [];
  currentState = response.state ?? null;

  renderAll();
  bindPeriodButtons();
  bindClearButton();
}

// ─── Render ───────────────────────────────────────────────────────────────────

function renderAll() {
  const log = filterByRange(currentLog, currentPeriod);
  renderSummary(log);
  renderTopDomains(log);
  renderHourlyChart(log);
  renderStreak();
}

function renderSummary(log) {
  const { tabsClosed, timeSavedMs, memoryMB } = computeReport(log);
  $('stat-tabs-closed').textContent = tabsClosed;
  $('stat-time-saved').textContent  = formatDuration(timeSavedMs);
  $('stat-memory').textContent      = `${memoryMB.toLocaleString()} MB`;
}

function renderTopDomains(log) {
  const container = $('top-domains-chart');
  const domains = computeTopDomains(log, 15);

  if (domains.length === 0) {
    container.innerHTML = '<p class="chart-empty">No data for this period.</p>';
    return;
  }

  const max = domains[0].count;
  container.innerHTML = domains.map(({ domain, count }) => {
    const pct = max > 0 ? Math.round((count / max) * 100) : 0;
    return `
      <div class="bar-row">
        <span class="bar-domain" title="${escHtml(domain)}">${escHtml(domain)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <span class="bar-count">${count}</span>
      </div>`;
  }).join('');
}

function renderHourlyChart(log) {
  const container = $('hourly-chart');
  const hours = computeHourlyDistribution(log);
  const max = Math.max(...hours, 1);

  const W = 560, H = 120;
  const barW = Math.floor(W / 24);
  const gap  = 2;
  const chartH = H - 20; // leave 20px for x-axis labels

  const rects = hours.map((count, h) => {
    const barH = Math.round((count / max) * chartH);
    const x = h * barW + gap / 2;
    const y = chartH - barH;
    const isPeak = max > 0 && count >= max * 0.75;
    const fill = isPeak ? 'var(--primary)' : 'var(--surface-alt)';
    return `<rect x="${x}" y="${y}" width="${barW - gap}" height="${barH}" fill="${fill}" rx="2"/>`;
  }).join('');

  // X-axis labels every 6 hours
  const labels = [0, 6, 12, 18].map(h => {
    const x = h * barW + barW / 2;
    const label = h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`;
    return `<text class="chart-axis-label" x="${x}" y="${H - 2}" text-anchor="middle">${label}</text>`;
  }).join('');

  container.innerHTML = `
    <svg class="hourly-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      ${rects}
      ${labels}
    </svg>`;
}

function renderStreak() {
  if (!currentState?.streakData) return;
  const { currentStreak, bestStreak, lastStreakBrokenDate } = currentState.streakData;

  $('streak-current').textContent = currentStreak ?? 0;
  $('streak-best').textContent    = bestStreak    ?? 0;
  $('streak-last-broken').textContent = lastStreakBrokenDate ?? '—';
}

// ─── Bindings ─────────────────────────────────────────────────────────────────

function bindPeriodButtons() {
  $('analytics-period-week').addEventListener('click', () => setPeriod(WEEK_MS));
  $('analytics-period-month').addEventListener('click', () => setPeriod(MONTH_MS));
}

function setPeriod(ms) {
  currentPeriod = ms;
  $('analytics-period-week').classList.toggle('active',  ms === WEEK_MS);
  $('analytics-period-month').classList.toggle('active', ms === MONTH_MS);
  renderAll();
}

function bindClearButton() {
  $('clearAnalyticsBtn').addEventListener('click', async () => {
    if (!confirm('Clear all analytics data? Streak info will be preserved.')) return;
    await chrome.runtime.sendMessage({ type: 'CLEAR_ANALYTICS' });
    currentLog = [];
    renderAll();
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
