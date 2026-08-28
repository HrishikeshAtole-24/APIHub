/**
 * Security tests (report 28: "Security | Abuse/SSRF | blocked private IPs,
 * payload validation" and 28.1 minimum coverage priorities).
 *
 * These are the highest-value tests in the repository: a regression here is a
 * server-side request forgery hole, not a cosmetic bug.
 */
import { describe, expect, it } from 'vitest';

import { buildSecurityHeaders, buildWebCsp } from './headers.js';
import { classifyIp, isPublicIp, parseIpv4, parseIpv6 } from './ip.js';
import { hashPassword, needsRehash, safeEqual, verifyPassword } from './password.js';
import { containsSecret, redactHeaders, redactText, redactUrl } from './redaction.js';
import {
  escapeHtml,
  escapeJsonForHtml,
  safeFilename,
  sanitizeUrl,
  sanitizeUserText,
  stripInvisibleCharacters,
} from './sanitize.js';
import { SsrfError, validateTargetUrl, type SsrfPolicy } from './ssrf.js';
import {
  generateCsrfToken,
  generateSessionId,
  signSessionId,
  verifyCsrfToken,
  verifySessionCookie,
} from './tokens.js';

const permissivePolicy: SsrfPolicy = {
  allowHttp: true,
  hostAllowlist: [],
  maxRedirects: 3,
};

describe('IPv4 parsing and classification', () => {
  it('parses valid dotted quads', () => {
    expect(parseIpv4('0.0.0.0')).toBe(0);
    expect(parseIpv4('255.255.255.255')).toBe(0xffffffff);
    expect(parseIpv4('192.168.1.1')).toBe(0xc0a80101);
  });

  it('rejects octal-style leading zeros, a classic filter bypass', () => {
    // 010.0.0.1 is 8.0.0.1 to some resolvers and 10.0.0.1 to others.
    expect(parseIpv4('010.0.0.1')).toBeNull();
    expect(parseIpv4('127.00.0.1')).toBeNull();
  });

  it('rejects malformed addresses', () => {
    for (const bad of ['256.1.1.1', '1.2.3', '1.2.3.4.5', 'abc', '', '1.2.3.-1']) {
      expect(parseIpv4(bad)).toBeNull();
    }
  });

  it('blocks every private and reserved range', () => {
    const blocked: [string, string][] = [
      ['127.0.0.1', 'loopback'],
      ['127.1.1.1', 'loopback'],
      ['10.0.0.1', 'private'],
      ['10.255.255.255', 'private'],
      ['172.16.0.1', 'private'],
      ['172.31.255.255', 'private'],
      ['192.168.0.1', 'private'],
      ['169.254.1.1', 'link-local'],
      ['169.254.169.254', 'cloud-metadata'],
      ['100.100.100.200', 'cloud-metadata'],
      ['0.0.0.0', 'unspecified'],
      ['100.64.0.1', 'carrier-nat'],
      ['224.0.0.1', 'multicast'],
      ['255.255.255.255', 'broadcast'],
      ['198.18.0.1', 'reserved'],
      ['192.0.2.1', 'documentation'],
    ];

    for (const [address, reason] of blocked) {
      const result = classifyIp(address);
      expect(result.safe, `${address} should be blocked`).toBe(false);
      expect(result.reason, `${address} reason`).toBe(reason);
    }
  });

  it('allows genuine public addresses', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '172.15.255.255']) {
      expect(isPublicIp(address), `${address} should be allowed`).toBe(true);
    }
  });

  it('treats the boundaries of 172.16.0.0/12 correctly', () => {
    expect(isPublicIp('172.15.255.255')).toBe(true); // just below
    expect(isPublicIp('172.16.0.0')).toBe(false); // first blocked
    expect(isPublicIp('172.31.255.255')).toBe(false); // last blocked
    expect(isPublicIp('172.32.0.0')).toBe(true); // just above
  });
});

describe('IPv6 parsing and classification', () => {
  it('expands compressed notation', () => {
    expect(parseIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6('2001:db8::1')).toEqual([0x2001, 0x0db8, 0, 0, 0, 0, 0, 1]);
  });

  it('rejects malformed addresses', () => {
    for (const bad of ['1::2::3', 'gggg::1', '1:2:3:4:5:6:7', '']) {
      expect(parseIpv6(bad)).toBeNull();
    }
  });

  it('blocks loopback, link-local, unique-local and multicast', () => {
    expect(classifyIp('::1').safe).toBe(false);
    expect(classifyIp('fe80::1').reason).toBe('link-local');
    expect(classifyIp('fc00::1').reason).toBe('unique-local');
    expect(classifyIp('fd12:3456::1').reason).toBe('unique-local');
    expect(classifyIp('ff02::1').reason).toBe('multicast');
    expect(classifyIp('2001:db8::1').reason).toBe('documentation');
  });

  it('unwraps IPv4-mapped addresses instead of trusting them', () => {
    // The critical case: ::ffff:127.0.0.1 must NOT slip past as "some IPv6".
    expect(classifyIp('::ffff:127.0.0.1').safe).toBe(false);
    expect(classifyIp('::ffff:127.0.0.1').reason).toBe('loopback');
    expect(classifyIp('::ffff:169.254.169.254').reason).toBe('cloud-metadata');
    expect(classifyIp('::ffff:10.0.0.1').reason).toBe('private');
    expect(classifyIp('::ffff:8.8.8.8').safe).toBe(true);
  });

  it('strips brackets and zone indices', () => {
    expect(classifyIp('[::1]').safe).toBe(false);
    expect(classifyIp('fe80::1%eth0').reason).toBe('link-local');
  });

  it('allows public IPv6', () => {
    expect(isPublicIp('2606:4700:4700::1111')).toBe(true);
  });
});

describe('validateTargetUrl', () => {
  async function expectDenied(url: string, code: string, policy = permissivePolicy) {
    await expect(validateTargetUrl(url, policy)).rejects.toThrow(SsrfError);
    try {
      await validateTargetUrl(url, policy);
      throw new Error(`Expected ${url} to be denied`);
    } catch (error) {
      expect((error as SsrfError).code, `${url}`).toBe(code);
    }
  }

  it('rejects non-http protocols', async () => {
    await expectDenied('file:///etc/passwd', 'PROTOCOL_NOT_ALLOWED');
    await expectDenied('gopher://example.com/', 'PROTOCOL_NOT_ALLOWED');
    await expectDenied('ftp://example.com/', 'PROTOCOL_NOT_ALLOWED');
  });

  it('rejects plain http when the policy forbids it', async () => {
    await expectDenied('http://example.com/', 'PROTOCOL_NOT_ALLOWED', {
      ...permissivePolicy,
      allowHttp: false,
    });
  });

  it('rejects credentials embedded in the URL', async () => {
    await expectDenied('http://user:pass@example.com/', 'CREDENTIALS_IN_URL');
  });

  it('rejects loopback and metadata targets given as literal IPs', async () => {
    await expectDenied('http://127.0.0.1/', 'BLOCKED_ADDRESS');
    await expectDenied('http://169.254.169.254/latest/meta-data/', 'BLOCKED_ADDRESS');
    await expectDenied('http://[::1]/', 'BLOCKED_ADDRESS');
    await expectDenied('http://10.0.0.1/', 'BLOCKED_ADDRESS');
    await expectDenied('http://[::ffff:127.0.0.1]/', 'BLOCKED_ADDRESS');
  });

  it('rejects internal hostnames by name, not just by address', async () => {
    await expectDenied('http://localhost/', 'HOST_NOT_ALLOWED');
    await expectDenied('http://metadata.google.internal/', 'HOST_NOT_ALLOWED');
    await expectDenied('http://db.internal/', 'HOST_NOT_ALLOWED');
    await expectDenied('http://printer.local/', 'HOST_NOT_ALLOWED');
    await expectDenied('http://intranet-host/', 'HOST_NOT_ALLOWED');
  });

  it('rejects non-web ports', async () => {
    await expectDenied('http://example.com:22/', 'PORT_NOT_ALLOWED');
    await expectDenied('http://example.com:6379/', 'PORT_NOT_ALLOWED');
    await expectDenied('http://example.com:5432/', 'PORT_NOT_ALLOWED');
  });

  it('rejects unparseable URLs', async () => {
    await expectDenied('not a url', 'INVALID_URL');
    await expectDenied('', 'INVALID_URL');
  });

  it('enforces a host allowlist when configured', async () => {
    const policy: SsrfPolicy = {
      ...permissivePolicy,
      hostAllowlist: ['api.github.com'],
    };
    await expectDenied('https://example.com/', 'HOST_NOT_ALLOWED', policy);
  });

  it('accepts a subdomain of an allowlisted host', async () => {
    const policy: SsrfPolicy = { ...permissivePolicy, hostAllowlist: ['github.com'] };
    // Uses real DNS; skipped automatically if the network is unavailable.
    try {
      const result = await validateTargetUrl('https://api.github.com/', policy);
      expect(result.url.hostname).toBe('api.github.com');
      expect(result.addresses.length).toBeGreaterThan(0);
    } catch (error) {
      if ((error as SsrfError).code !== 'DNS_RESOLUTION_FAILED') throw error;
    }
  });
});

describe('redaction', () => {
  it('redacts sensitive headers case-insensitively', () => {
    const result = redactHeaders({
      Authorization: 'Bearer supersecrettoken',
      'X-API-Key': 'abc123',
      'Content-Type': 'application/json',
      Cookie: 'session=xyz',
    });

    expect(result['Authorization']).toBe('[REDACTED]');
    expect(result['X-API-Key']).toBe('[REDACTED]');
    expect(result['Cookie']).toBe('[REDACTED]');
    expect(result['Content-Type']).toBe('application/json');
  });

  it('strips credentials and secret query parameters from URLs', () => {
    expect(redactUrl('https://user:pass@example.com/path')).toBe('https://example.com/path');
    expect(redactUrl('https://example.com/?api_key=secret&page=2')).toContain('api_key=%5BREDACTED%5D');
    expect(redactUrl('https://example.com/?page=2')).toBe('https://example.com/?page=2');
  });

  it('redacts recognisable secrets in free text', () => {
    expect(redactText('token is sk-abcdefghijklmnopqrstuvwx')).toContain('[REDACTED]');
    expect(redactText('AKIAIOSFODNN7EXAMPLE')).toBe('[REDACTED]');
    expect(redactText('nothing sensitive here')).toBe('nothing sensitive here');
  });

  it('detects JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r';
    expect(containsSecret(jwt)).toBe(true);
  });
});

describe('password hashing', () => {
  it('produces a verifiable Argon2id hash', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong password entirely', hash)).toBe(false);
  }, 20_000);

  it('salts, so the same password hashes differently each time', async () => {
    const a = await hashPassword('same-password-here');
    const b = await hashPassword('same-password-here');
    expect(a).not.toBe(b);
  }, 20_000);

  it('treats a malformed stored hash as a failed login, not an error', async () => {
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('anything', '')).toBe(false);
  });

  it('flags weaker parameters for rehashing', () => {
    expect(needsRehash('$argon2id$v=19$m=4096,t=1,p=1$abc$def')).toBe(true);
    expect(needsRehash('$argon2id$v=19$m=19456,t=2,p=1$abc$def')).toBe(false);
    expect(needsRehash('garbage')).toBe(true);
  });

  it('compares strings without leaking length via an exception', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'much longer string')).toBe(false);
  });
});

describe('session and CSRF tokens', () => {
  const secret = 'a-test-secret-that-is-long-enough-for-hmac';

  it('round-trips a signed session cookie', () => {
    const id = generateSessionId();
    const cookie = signSessionId(id, secret);
    expect(verifySessionCookie(cookie, secret)).toBe(id);
  });

  it('rejects a tampered cookie', () => {
    const id = generateSessionId();
    const cookie = signSessionId(id, secret);
    expect(verifySessionCookie(`${cookie}x`, secret)).toBeNull();
    expect(verifySessionCookie(cookie, 'a-different-secret-of-sufficient-len')).toBeNull();
    expect(verifySessionCookie('no-signature-here', secret)).toBeNull();
  });

  it('binds a CSRF token to its session', () => {
    const sessionA = generateSessionId();
    const sessionB = generateSessionId();
    const token = generateCsrfToken(sessionA, secret);

    expect(verifyCsrfToken(token, sessionA, secret)).toBe(true);
    // The same token must not work for a different session.
    expect(verifyCsrfToken(token, sessionB, secret)).toBe(false);
    expect(verifyCsrfToken('bogus.token', sessionA, secret)).toBe(false);
  });
});

describe('sanitisation', () => {
  it('escapes HTML metacharacters', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;&#47;script&gt;',
    );
  });

  it('removes zero-width and bidi characters', () => {
    const trojan = `admin${String.fromCharCode(0x202e)}txt`;
    expect(stripInvisibleCharacters(trojan)).toBe('admintxt');
    expect(stripInvisibleCharacters(`a${String.fromCharCode(0x200b)}b`)).toBe('ab');
  });

  it('normalises user text and enforces a maximum length', () => {
    expect(sanitizeUserText('  hello\r\n\n\n\nworld  ')).toBe('hello\n\nworld');
    expect(sanitizeUserText('x'.repeat(100), 10)).toHaveLength(10);
  });

  it('only allows http and https in hrefs', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeUrl('data:text/html,<script>')).toBeNull();
    expect(sanitizeUrl('https://example.com/docs')).toBe('https://example.com/docs');
    expect(sanitizeUrl(null)).toBeNull();
  });

  it('escapes JSON so it cannot break out of a script tag', () => {
    const escaped = escapeJsonForHtml({ evil: '</script><script>alert(1)</script>' });
    expect(escaped).not.toContain('</script>');
    expect(escaped).toContain('\\u003c');
  });

  it('produces safe filenames', () => {
    expect(safeFilename('../../etc/passwd')).toBe('etc-passwd');
    expect(safeFilename('')).toBe('apihub-export');
  });
});

describe('security headers', () => {
  it('locks down the API response policy', () => {
    const headers = buildSecurityHeaders({ enableHsts: true });
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Content-Security-Policy']).toContain("default-src 'none'");
    expect(headers['Strict-Transport-Security']).toContain('max-age=31536000');
  });

  it('omits HSTS when not served over TLS', () => {
    const headers = buildSecurityHeaders({ enableHsts: false });
    expect(headers['Strict-Transport-Security']).toBeUndefined();
  });

  it('builds a nonce-based script policy for the web app', () => {
    const csp = buildWebCsp('abc123', { enableHsts: true });
    expect(csp).toContain("'nonce-abc123'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });
});
