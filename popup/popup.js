// popup.js — TabTTL popup controller

const $ = id => document.getElementById(id);

let refreshTimer = null;
let currentSettings = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await load();

  $('enableToggle').addEventListener('change', onToggleEnabled);
  $('settingsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('refreshBtn').addEventListener('click', load);
  $('historyBtn').addEventListener('click', openHistory);
  $('historyBackBtn').addEventListener('click', closeHistory);
  $('clearHistoryBtn').addEventListener('click', onClearHistory);

  // Auto-refresh every 10 seconds to keep countdowns live.
  refreshTimer = setInterval(load, 10_000);
});

window.addEventListener('unload', () => clearInterval(refreshTimer));

// ─── Data loading ─────────────────────────────────────────────────────────────

async function load() {
  try {
    const data = await sendMessage({ type: 'GET_TAB_INFO' });
    currentSettings = data.settings;
    renderHeader(data.settings);
    renderTabs(data.tabs, data.settings);
    updateHistoryCount();
  } catch (err) {
    console.error('TabTTL popup error:', err);
  }
}

async function updateHistoryCount() {
  const { tabs } = await sendMessage({ type: 'GET_CLOSED_TABS' });
  const el = $('historyCount');
  el.textContent = tabs.length > 0 ? String(tabs.length) : '';
}

// ─── Header ───────────────────────────────────────────────────────────────────

function renderHeader(settings) {
  const toggle = $('enableToggle');
  toggle.checked = settings.enabled;

  const banner = $('statusBanner');
  if (!settings.enabled) {
    banner.className = 'status-banner disabled';
    banner.textContent = 'TabTTL is disabled';
  } else {
    banner.className = 'status-banner hidden';
  }
}

async function onToggleEnabled(e) {
  const enabled = e.target.checked;
  const settings = { ...currentSettings, enabled };
  await chrome.storage.sync.set({ settings });
  currentSettings = settings;
  renderHeader(settings);
}

// ─── Tab list ─────────────────────────────────────────────────────────────────

function renderTabs(tabs, settings) {
  const container = $('tabList');

  if (tabs.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🗂</div>
        <div class="empty-state-text">No open tabs</div>
      </div>`;
    return;
  }

  // Split into protected vs managed.
  const protected_ = tabs.filter(t => t.isProtected);
  const managed = tabs.filter(t => !t.isProtected);

  // Sort managed: in-grace first, then by remaining TTL ascending.
  managed.sort((a, b) => {
    if (a.inGrace !== b.inGrace) return a.inGrace ? -1 : 1;
    if (a.isSnoozed !== b.isSnoozed) return a.isSnoozed ? 1 : -1;
    return (a.remaining ?? Infinity) - (b.remaining ?? Infinity);
  });

  const html = [];

  if (managed.length > 0) {
    html.push('<div class="section-label">Managed</div>');
    managed.forEach(tab => html.push(renderTabItem(tab, settings)));
  }

  if (protected_.length > 0) {
    html.push('<div class="section-label">Protected</div>');
    protected_.forEach(tab => html.push(renderTabItem(tab, settings)));
  }

  container.innerHTML = html.join('');

  // Attach action listeners after rendering.
  container.querySelectorAll('[data-snooze]').forEach(btn => {
    btn.addEventListener('click', () => onSnooze(parseInt(btn.dataset.snooze, 10)));
  });
  container.querySelectorAll('[data-undo]').forEach(btn => {
    btn.addEventListener('click', () => onUndo(parseInt(btn.dataset.undo, 10)));
  });
  container.querySelectorAll('[data-protect]').forEach(btn => {
    btn.addEventListener('click', () => onProtect(parseInt(btn.dataset.protect, 10)));
  });
}

function renderTabItem(tab, settings) {
  const faviconHtml = tab.favIconUrl
    ? `<img class="tab-favicon" src="${escHtml(tab.favIconUrl)}" alt="" />`
    : `<div class="tab-favicon-placeholder"></div>`;

  const badges = [];
  if (tab.active)    badges.push('<span class="badge badge-active">Active</span>');
  if (tab.pinned)    badges.push('<span class="badge badge-pinned">Pinned</span>');
  if (tab.isSnoozed) badges.push('<span class="badge badge-snoozed">Snoozed</span>');
  if (tab.inGrace)   badges.push('<span class="badge badge-grace">Closing…</span>');
  if (tab.audible)   badges.push('<span class="badge badge-audible">Playing</span>');

  let actionHtml = '';
  if (tab.inGrace) {
    actionHtml = `<button class="btn-small btn-undo" data-undo="${tab.id}">Undo</button>`;
  } else if (tab.manuallyProtected) {
    actionHtml = `<button class="btn-small btn-protect active" data-protect="${tab.id}" title="Unprotect tab">🛡</button>`;
  } else if (!tab.isProtected) {
    actionHtml = `
      <button class="btn-small btn-protect" data-protect="${tab.id}" title="Protect tab">🛡</button>
      <button class="btn-small" data-snooze="${tab.id}" title="Snooze for ${settings.snoozeMinutes} min">+${settings.snoozeMinutes}m</button>`;
  }

  const { ttlLabel, ttlClass, barWidth, barClass } = computeTTL(tab);

  return `
    <div class="tab-item${tab.inGrace ? ' grace' : ''}">
      ${faviconHtml}
      <div class="tab-title-row">
        <span class="tab-title" title="${escHtml(tab.title || tab.url || '')}">${escHtml(tab.title || tab.url || 'Untitled')}</span>
        ${badges.join('')}
      </div>
      <div class="tab-actions">${actionHtml}</div>
      <div class="tab-ttl-row">
        <div class="ttl-bar"><div class="ttl-fill ${barClass}" style="width:${barWidth}%"></div></div>
        <span class="ttl-label ${ttlClass}">${ttlLabel}</span>
      </div>
    </div>`;
}

function computeTTL(tab) {
  if (tab.isProtected) {
    return { ttlLabel: 'Protected', ttlClass: 'protected', barWidth: 100, barClass: 'safe' };
  }
  if (tab.isSnoozed) {
    const remaining = tab.snoozeUntil - Date.now();
    return {
      ttlLabel: `Snoozed ${formatDuration(remaining)}`,
      ttlClass: 'snoozed',
      barWidth: 100,
      barClass: 'safe',
    };
  }
  if (tab.remaining == null) {
    return { ttlLabel: '—', ttlClass: '', barWidth: 100, barClass: 'safe' };
  }
  const pct = Math.min(100, (tab.remaining / tab.ttl) * 100);
  const barClass = pct > 50 ? 'safe' : pct > 20 ? 'warn' : 'urgent';
  const ttlClass = tab.inGrace ? 'urgent' : pct <= 20 ? 'urgent' : '';
  return {
    ttlLabel: tab.inGrace ? 'Closing…' : formatDuration(tab.remaining),
    ttlClass,
    barWidth: pct,
    barClass,
  };
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function onSnooze(tabId) {
  await sendMessage({ type: 'SNOOZE_TAB', tabId, minutes: currentSettings.snoozeMinutes });
  await load();
}

async function onUndo(tabId) {
  await sendMessage({ type: 'CANCEL_GRACE', tabId });
  await load();
}

async function onProtect(tabId) {
  await sendMessage({ type: 'TOGGLE_PROTECT_TAB', tabId });
  await load();
}

// ─── History panel ────────────────────────────────────────────────────────────

async function openHistory() {
  const { tabs } = await sendMessage({ type: 'GET_CLOSED_TABS' });
  renderHistory(tabs);
  $('historyPanel').classList.add('visible');
}

function closeHistory() {
  $('historyPanel').classList.remove('visible');
}

function renderHistory(tabs) {
  const list = $('historyList');
  if (tabs.length === 0) {
    list.innerHTML = '<div class="history-empty">No closed tabs yet</div>';
    return;
  }

  list.innerHTML = tabs.map(entry => {
    const faviconHtml = entry.favIconUrl
      ? `<img class="history-favicon" src="${escHtml(entry.favIconUrl)}" alt="" />`
      : `<div class="history-favicon-placeholder"></div>`;
    const timeAgo = formatTimeAgo(entry.closedAt);
    return `
      <div class="history-item">
        ${faviconHtml}
        <div class="history-info">
          <div class="history-title-text" title="${escHtml(entry.title || entry.url || '')}">${escHtml(entry.title || entry.url || 'Untitled')}</div>
          <div class="history-meta">${escHtml(shortenUrl(entry.url || ''))} · ${timeAgo}</div>
        </div>
        <button class="btn-small" data-restore="${escHtml(entry.url || '')}">Restore</button>
      </div>`;
  }).join('');

  list.querySelectorAll('[data-restore]').forEach(btn => {
    btn.addEventListener('click', () => onRestore(btn.dataset.restore));
  });
}

async function onRestore(url) {
  await sendMessage({ type: 'RESTORE_TAB', url });
  closeHistory();
}

async function onClearHistory() {
  await sendMessage({ type: 'CLEAR_HISTORY' });
  $('historyList').innerHTML = '<div class="history-empty">No closed tabs yet</div>';
  $('historyCount').textContent = '';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, response => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      if (response?.error) return reject(new Error(response.error));
      resolve(response);
    });
  });
}

function formatDuration(ms) {
  if (ms <= 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
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
