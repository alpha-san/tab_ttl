/**
 * Extract the effective hostname from a URL.
 * Returns empty string for non-http(s) URLs.
 */
export function getHostname(url) {
  try {
    const { hostname, protocol } = new URL(url);
    return (protocol === 'http:' || protocol === 'https:') ? hostname : '';
  } catch {
    return '';
  }
}

/**
 * Check whether a URL matches a given pattern.
 *
 * Patterns:
 *   'github.com'            — matches github.com and any subdomain
 *   'github.com/myorg/*'   — matches that path prefix on github.com/subdomains
 */
export function matchesPattern(url, pattern) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;

    const slashIdx = pattern.indexOf('/');
    const patternHost = slashIdx === -1 ? pattern : pattern.slice(0, slashIdx);
    const patternPath = slashIdx === -1 ? null : pattern.slice(slashIdx);

    const target = patternHost.includes(':') ? u.host : u.hostname;
    const hostMatches =
      target === patternHost ||
      target.endsWith('.' + patternHost);

    if (!hostMatches) return false;
    if (patternPath === null) return true;

    if (patternPath.endsWith('*')) {
      return u.pathname.startsWith(patternPath.slice(0, -1));
    }
    return u.pathname === patternPath;
  } catch {
    return false;
  }
}

/**
 * Returns true if the URL matches any pattern in the list.
 */
export function matchesAny(url, patterns) {
  return patterns.some(p => matchesPattern(url, p));
}
