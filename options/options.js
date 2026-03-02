// options.js — TabTTL settings page controller

import { getSettings, saveSettings, getAllowlist, saveAllowlist, getBlocklist, saveBlocklist, getPerDomainTTL, savePerDomainTTL, getClosedTabs, saveClosedTabs } from '../utils/storage.js';
import { MODE_ALLOWLIST, MODE_BLOCKLIST, DEFAULT_STREAK_TAB_LIMIT } from '../utils/constants.js';
import { initAnalyticsSection } from './analytics-section.js';

const $ = id => document.getElementById(id);

let settings = null;
let perDomainTTL = {};

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await loadAll();
  bindNavigation();
  bindSettingsInputs();
  bindDomainActions();
  bindHistoryActions();
});

async function loadAll() {
  settings = await getSettings();
  perDomainTTL = await getPerDomainTTL();

  renderGeneralSettings(settings);
  await renderDomainList(settings.mode);
  renderPerDomainTTL(perDomainTTL);
  await renderHistory();
  await initAnalyticsSection();
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function bindNavigation() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.section;
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
      $(`section-${target}`).classList.add('active');
    });
  });
}

// ─── General settings ─────────────────────────────────────────────────────────

function renderGeneralSettings(s) {
  $('enabled').checked = s.enabled;

  // TTL — convert ms to display value
  const { value, unit } = msToDisplay(s.ttl);
  $('ttlValue').value = value;
  $('ttlUnit').value = unit;
  highlightPreset(s.ttl);

  document.querySelector(`input[name="mode"][value="${s.mode}"]`).checked = true;

  $('gracePeriod').value = s.gracePeriod;
  $('snoozeMinutes').value = s.snoozeMinutes;
  $('idleDetection').checked = s.idleDetection;
  $('idleThreshold').value = s.idleThreshold;
  $('idleThresholdField').style.display = s.idleDetection ? '' : 'none';
  $('streakTabLimit').value = s.streakTabLimit ?? DEFAULT_STREAK_TAB_LIMIT;
}

function bindSettingsInputs() {
  $('enabled').addEventListener('change', async () => {
    await updateSettings({ enabled: $('enabled').checked });
  });

  const saveTTL = debounce(async () => {
    const ms = displayToMs($('ttlValue').value, $('ttlUnit').value);
    if (ms > 0) {
      await updateSettings({ ttl: ms });
      highlightPreset(ms);
    }
  }, 400);
  $('ttlValue').addEventListener('input', saveTTL);
  $('ttlUnit').addEventListener('change', saveTTL);

  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ms = parseInt(btn.dataset.ttl, 10);
      const { value, unit } = msToDisplay(ms);
      $('ttlValue').value = value;
      $('ttlUnit').value = unit;
      await updateSettings({ ttl: ms });
      highlightPreset(ms);
    });
  });

  document.querySelectorAll('input[name="mode"]').forEach(radio => {
    radio.addEventListener('change', async () => {
      const mode = radio.value;
      await updateSettings({ mode });
      await renderDomainList(mode);
      updateDomainListUI(mode);
    });
  });

  const saveGrace = debounce(async () => {
    const val = parseInt($('gracePeriod').value, 10);
    if (val >= 5) await updateSettings({ gracePeriod: val });
  }, 400);
  $('gracePeriod').addEventListener('input', saveGrace);

  const saveSnooze = debounce(async () => {
    const val = parseInt($('snoozeMinutes').value, 10);
    if (val >= 1) await updateSettings({ snoozeMinutes: val });
  }, 400);
  $('snoozeMinutes').addEventListener('input', saveSnooze);

  $('idleDetection').addEventListener('change', async () => {
    const enabled = $('idleDetection').checked;
    $('idleThresholdField').style.display = enabled ? '' : 'none';
    await updateSettings({ idleDetection: enabled });
  });

  const saveIdleThreshold = debounce(async () => {
    const val = parseInt($('idleThreshold').value, 10);
    if (val >= 15) await updateSettings({ idleThreshold: val });
  }, 400);
  $('idleThreshold').addEventListener('input', saveIdleThreshold);

  const saveStreakTabLimit = debounce(async () => {
    const val = parseInt($('streakTabLimit').value, 10);
    if (val >= 1) await updateSettings({ streakTabLimit: val });
  }, 400);
  $('streakTabLimit').addEventListener('input', saveStreakTabLimit);
}

async function updateSettings(patch) {
  settings = { ...settings, ...patch };
  await saveSettings(settings);
  showToast();
}

function highlightPreset(ttlMs) {
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.ttl, 10) === ttlMs);
  });
}

// ─── Domain list ──────────────────────────────────────────────────────────────

function updateDomainListUI(mode) {
  if (mode === MODE_ALLOWLIST) {
    $('domainListTitle').textContent = 'Allowlist';
    $('domainListDesc').textContent =
      'Tabs from these domains are protected — they will never be auto-closed.';
  } else {
    $('domainListTitle').textContent = 'Blocklist';
    $('domainListDesc').textContent =
      'Tabs from these domains will be auto-closed. Supports exact domains (github.com) and path patterns (github.com/myorg/*).';
  }
}

async function renderDomainList(mode) {
  updateDomainListUI(mode);
  const domains = mode === MODE_ALLOWLIST ? await getAllowlist() : await getBlocklist();
  const list = $('domainList');
  list.innerHTML = '';
  if (domains.length === 0) {
    list.innerHTML = '<li style="color:var(--text-muted);font-size:13px;padding:8px 0;">No entries yet.</li>';
    return;
  }
  domains.forEach(pattern => list.appendChild(makeDomainItem(pattern, null)));
}

function makeDomainItem(pattern, ttlMs) {
  const li = document.createElement('li');
  li.className = 'domain-item';
  li.dataset.pattern = pattern;

  const span = document.createElement('span');
  span.className = 'domain-item-pattern';
  span.textContent = pattern;
  li.appendChild(span);

  if (ttlMs != null) {
    const ttlSpan = document.createElement('span');
    ttlSpan.className = 'domain-item-ttl';
    ttlSpan.textContent = formatTTL(ttlMs);
    li.appendChild(ttlSpan);
  }

  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn-remove';
  removeBtn.title = 'Remove';
  removeBtn.textContent = '×';
  li.appendChild(removeBtn);
  return li;
}

function bindDomainActions() {
  // Add domain button
  $('addDomainBtn').addEventListener('click', async () => {
    const pattern = $('domainInput').value.trim().toLowerCase();
    if (!pattern) return;

    const mode = settings.mode;
    const domains = mode === MODE_ALLOWLIST ? await getAllowlist() : await getBlocklist();
    if (!domains.includes(pattern)) {
      domains.push(pattern);
      if (mode === MODE_ALLOWLIST) await saveAllowlist(domains);
      else await saveBlocklist(domains);
    }
    $('domainInput').value = '';
    await renderDomainList(mode);
    showToast();
  });

  $('domainInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('addDomainBtn').click();
  });

  // Remove via delegation
  $('domainList').addEventListener('click', async e => {
    if (!e.target.classList.contains('btn-remove')) return;
    const item = e.target.closest('.domain-item');
    if (!item) return;
    const pattern = item.dataset.pattern;
    const mode = settings.mode;
    const domains = mode === MODE_ALLOWLIST ? await getAllowlist() : await getBlocklist();
    const idx = domains.indexOf(pattern);
    if (idx !== -1) {
      domains.splice(idx, 1);
      if (mode === MODE_ALLOWLIST) await saveAllowlist(domains);
      else await saveBlocklist(domains);
    }
    item.remove();
    showToast();
  });

  // Add per-domain TTL
  $('addPerDomainBtn').addEventListener('click', async () => {
    const pattern = $('perDomainPattern').value.trim().toLowerCase();
    const value = parseInt($('perDomainValue').value, 10);
    const unit = $('perDomainUnit').value;
    if (!pattern || !value || value <= 0) return;

    const ms = displayToMs(value, unit);
    perDomainTTL[pattern] = ms;
    await savePerDomainTTL(perDomainTTL);
    $('perDomainPattern').value = '';
    $('perDomainValue').value = '';
    renderPerDomainTTL(perDomainTTL);
    showToast();
  });

  $('perDomainList').addEventListener('click', async e => {
    if (!e.target.classList.contains('btn-remove')) return;
    const item = e.target.closest('.domain-item');
    if (!item) return;
    delete perDomainTTL[item.dataset.pattern];
    await savePerDomainTTL(perDomainTTL);
    item.remove();
    showToast();
  });
}

function renderPerDomainTTL(map) {
  const list = $('perDomainList');
  list.innerHTML = '';
  const entries = Object.entries(map);
  if (entries.length === 0) {
    list.innerHTML = '<li style="color:var(--text-muted);font-size:13px;padding:8px 0;">No overrides yet.</li>';
    return;
  }
  entries.forEach(([pattern, ttlMs]) => list.appendChild(makeDomainItem(pattern, ttlMs)));
}

// ─── History ──────────────────────────────────────────────────────────────────

async function renderHistory() {
  const tabs = await getClosedTabs();
  const list = $('historyEntries');
  const meta = $('historyMeta');

  meta.textContent = tabs.length > 0 ? `${tabs.length} tab${tabs.length !== 1 ? 's' : ''} in history` : '';

  if (tabs.length === 0) {
    list.innerHTML = '<li class="history-empty">No closed tabs in history yet.</li>';
    return;
  }

  list.innerHTML = tabs.map(entry => {
    const faviconHtml = entry.favIconUrl
      ? `<img class="history-favicon" src="${escHtml(entry.favIconUrl)}" alt="" />`
      : '<div class="history-favicon-placeholder"></div>';
    return `
      <li class="history-entry">
        ${faviconHtml}
        <div class="history-info">
          <div class="history-title-text" title="${escHtml(entry.title || entry.url || '')}">${escHtml(entry.title || 'Untitled')}</div>
          <div class="history-url">${escHtml(shortenUrl(entry.url || ''))}</div>
        </div>
        <span class="history-time">${formatTimeAgo(entry.closedAt)}</span>
        <button class="btn btn-ghost" data-restore="${escHtml(entry.url || '')}">Restore</button>
      </li>`;
  }).join('');

  list.querySelectorAll('[data-restore]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await chrome.tabs.create({ url: btn.dataset.restore, active: false });
    });
  });
}

function bindHistoryActions() {
  $('clearHistoryBtn').addEventListener('click', async () => {
    if (!confirm('Clear all closed tab history?')) return;
    await saveClosedTabs([]);
    await renderHistory();
    showToast();
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function msToDisplay(ms) {
  if (ms < 60_000) return { value: Math.round(ms / 1000), unit: 's' };
  if (ms < 3_600_000 || ms % 3_600_000 !== 0) return { value: Math.round(ms / 60_000), unit: 'm' };
  return { value: Math.round(ms / 3_600_000), unit: 'h' };
}

function displayToMs(value, unit) {
  const n = parseFloat(value);
  if (unit === 's') return n * 1_000;
  if (unit === 'h') return n * 3_600_000;
  return n * 60_000; // default: minutes
}

function formatTTL(ms) {
  const { value, unit } = msToDisplay(ms);
  const labels = { s: 'sec', m: 'min', h: 'hr' };
  return `${value} ${labels[unit]}`;
}

function formatTimeAgo(ts) {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function shortenUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== '/' ? u.pathname : '');
  } catch {
    return url;
  }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let toastTimer;
function showToast() {
  const toast = $('saveToast');
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
