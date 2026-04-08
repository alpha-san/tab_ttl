# TabTTL

A Chrome extension that automatically closes tabs after a configurable time-to-live (TTL). Helps keep your browser tidy without manual tab management.

## Features

- **Configurable TTL** - Set a global TTL for all tabs (default: 10 minutes)
- **Per-domain TTL** - Override the global TTL for specific domains
- **Allowlist / Blocklist modes** - Choose which tabs are managed
- **Grace period** - Get a notification before a tab closes, with a "Keep Open" button
- **Snooze** - Temporarily extend a tab's TTL from the popup
- **Manual protection** - Shield individual tabs from auto-closing for the current session
- **Idle detection** - Pauses tab closing when you're away from your computer
- **Tab history** - Browse and restore recently closed tabs
- **Analytics** - Track closing patterns, top domains, hourly distribution, and streaks

## Requirements

- Google Chrome 102 or later (requires `chrome.storage.session` API)

## Setup

### 1. Generate icons

PNG icons are not checked in. Generate them by opening `icons/generate-icons.html` in a browser, then save the downloaded files (`icon16.png`, `icon48.png`, `icon128.png`) to the `icons/` directory.

### 2. Install dependencies

```bash
npm install
```

### 3. Load the extension

1. Navigate to `chrome://extensions`
2. Enable **Developer Mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `tab_ttl` project directory

After making code changes, click the reload button on the extension card at `chrome://extensions` to pick up changes.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Creates `dist/tab-ttl.zip` for distribution / Chrome Web Store upload |
| `npm run lint` | Validates `manifest.json` and checks all JS files for syntax errors |

## Project Structure

```
tab_ttl/
├── manifest.json                  MV3 manifest
├── background/
│   └── service-worker.js          Core logic: TTL checks, grace period, analytics, messages
├── popup/
│   ├── popup.html                 Extension popup
│   ├── popup.css                  Dark-themed popup styles
│   └── popup.js                   Tab list, snooze, protect, history slide-in
├── options/
│   ├── options.html               Settings page
│   ├── options.css                Settings styles
│   ├── options.js                 Settings controller
│   ├── analytics-section.css      Analytics tab styles
│   └── analytics-section.js       Analytics rendering and charts
├── utils/
│   ├── constants.js               Alarm names, defaults, limits
│   ├── storage.js                 All chrome.storage read/write helpers
│   ├── analytics.js               Pure computation for analytics data
│   └── domain-matcher.js          URL/domain pattern matching
├── icons/
│   ├── icon.svg                   Source SVG icon
│   └── generate-icons.html        Browser-based PNG icon generator
└── scripts/
    └── build.sh                   Zip packaging script
```

## Architecture

- **Manifest V3** with ES modules throughout (`"type": "module"`)
- **`chrome.alarms`** drives TTL checks (30-second interval) and one-shot grace period timers
- **`chrome.storage.sync`** stores settings, allowlist, blocklist, and per-domain TTL (synced across devices)
- **`chrome.storage.local`** stores tab timestamps, snoozed state, grace state, closed tab history, and analytics
- **`chrome.storage.session`** stores manually protected tabs (cleared automatically when the browser closes)
- **Idle detection** via `chrome.idle.queryState` skips TTL checks when the user is away

## Settings

Accessible via the options page (right-click the extension icon > Options):

| Section | What it configures |
|---------|-------------------|
| **General** | Enable/disable, global TTL, grace period, snooze duration |
| **Domains** | Allowlist/blocklist mode, domain patterns, per-domain TTL overrides |
| **Advanced** | Idle detection, idle threshold, streak tab limit |
| **History** | Browse and restore closed tabs |
| **Analytics** | View closing stats, top domains, hourly patterns, streaks |
