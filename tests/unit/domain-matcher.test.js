import { describe, it, expect } from 'vitest';
import { getHostname, matchesPattern, matchesAny } from '../../utils/domain-matcher.js';

describe('getHostname', () => {
  it('extracts hostname from https URL', () => {
    expect(getHostname('https://github.com/user/repo')).toBe('github.com');
  });

  it('extracts hostname from http URL', () => {
    expect(getHostname('http://example.com')).toBe('example.com');
  });

  it('returns empty for chrome:// URL', () => {
    expect(getHostname('chrome://extensions')).toBe('');
  });

  it('returns empty for about: URL', () => {
    expect(getHostname('about:blank')).toBe('');
  });

  it('returns empty for ftp URL', () => {
    expect(getHostname('ftp://files.example.com')).toBe('');
  });

  it('returns empty for malformed URL', () => {
    expect(getHostname('not a url')).toBe('');
  });

  it('returns empty for empty string', () => {
    expect(getHostname('')).toBe('');
  });
});

describe('matchesPattern', () => {
  it('matches exact domain', () => {
    expect(matchesPattern('https://github.com/page', 'github.com')).toBe(true);
  });

  it('matches subdomain', () => {
    expect(matchesPattern('https://api.github.com/v1', 'github.com')).toBe(true);
  });

  it('does not match partial hostname', () => {
    expect(matchesPattern('https://notgithub.com', 'github.com')).toBe(false);
  });

  it('matches exact path', () => {
    expect(matchesPattern('https://github.com/myorg', 'github.com/myorg')).toBe(true);
  });

  it('does not match different path (exact mode)', () => {
    expect(matchesPattern('https://github.com/other', 'github.com/myorg')).toBe(false);
  });

  it('matches wildcard path prefix', () => {
    expect(matchesPattern('https://github.com/myorg/repo', 'github.com/myorg/*')).toBe(true);
  });

  it('does not match wildcard path for different prefix', () => {
    expect(matchesPattern('https://github.com/other/repo', 'github.com/myorg/*')).toBe(false);
  });

  it('returns false for non-http URL', () => {
    expect(matchesPattern('chrome://extensions', 'extensions')).toBe(false);
  });

  it('returns false for malformed URL', () => {
    expect(matchesPattern('not-a-url', 'example.com')).toBe(false);
  });
});

describe('matchesPattern with ports', () => {
  it('matches localhost:3000 against http://localhost:3000/foo', () => {
    expect(matchesPattern('http://localhost:3000/foo', 'localhost:3000')).toBe(true);
  });

  it('does not match localhost:3000 against http://localhost:8080/foo', () => {
    expect(matchesPattern('http://localhost:8080/foo', 'localhost:3000')).toBe(false);
  });

  it('does not match localhost:3000 against http://localhost/', () => {
    expect(matchesPattern('http://localhost/', 'localhost:3000')).toBe(false);
  });

  it('bare localhost still matches http://localhost:3000/ (regression guard)', () => {
    expect(matchesPattern('http://localhost:3000/', 'localhost')).toBe(true);
  });

  it('bare localhost still matches http://localhost/ (regression guard)', () => {
    expect(matchesPattern('http://localhost/', 'localhost')).toBe(true);
  });

  it('app.clickup.com still matches https://app.clickup.com/t/123 (regression guard)', () => {
    expect(matchesPattern('https://app.clickup.com/t/123', 'app.clickup.com')).toBe(true);
  });

  it('app.clickup.com/ only matches the root path (documents existing behavior)', () => {
    expect(matchesPattern('https://app.clickup.com/', 'app.clickup.com/')).toBe(true);
    expect(matchesPattern('https://app.clickup.com/t/123', 'app.clickup.com/')).toBe(false);
  });
});

describe('matchesAny', () => {
  it('returns true if any pattern matches', () => {
    expect(matchesAny('https://github.com', ['gitlab.com', 'github.com'])).toBe(true);
  });

  it('returns false if none match', () => {
    expect(matchesAny('https://github.com', ['gitlab.com', 'bitbucket.org'])).toBe(false);
  });

  it('returns false for empty pattern list', () => {
    expect(matchesAny('https://github.com', [])).toBe(false);
  });
});
