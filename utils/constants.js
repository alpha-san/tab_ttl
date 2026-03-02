// Alarm names
export const ALARM_CHECK = 'tabTTL-check';
export const ALARM_GRACE_PREFIX = 'tabTTL-grace-';

// Chrome alarms minimum period is 30 seconds (0.5 minutes)
export const ALARM_INTERVAL_MINUTES = 0.5;

// Default settings
export const DEFAULT_TTL_MS = 5 * 60 * 1000;   // 5 minutes
export const DEFAULT_GRACE_PERIOD_S = 15;        // 15 seconds
export const DEFAULT_SNOOZE_MINUTES = 10;
export const DEFAULT_IDLE_THRESHOLD_S = 60;      // 1 minute

// History limit
export const CLOSED_TABS_MAX = 100;

// Analytics
export const ANALYTICS_LOG_MAX_DAYS = 90;
export const ANALYTICS_LOG_MAX_ENTRIES = 5000;
export const MEMORY_PER_TAB_MB = 75;
export const DEFAULT_STREAK_TAB_LIMIT = 20;

// Modes
export const MODE_ALLOWLIST = 'allowlist';
export const MODE_BLOCKLIST = 'blocklist';
