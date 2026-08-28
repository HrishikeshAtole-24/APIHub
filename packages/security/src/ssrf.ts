/**
 * SSRF guard (report 20.2, ADR-009).
 *
 * "The playground and health monitor are network clients. They must not be
 *  allowed to fetch arbitrary internal resources."
 *
 * Defence layers, applied in order:
 *   1. Protocol allowlist        — only http/https, and http only if enabled.
 *   2. Syntactic rejection       — credentials in URL, odd ports, bad hosts.
 *   3. Optional host allowlist   — when configured, nothing else is reachable.
 *   4. Literal-IP classification — blocks http://127.0.0.1 style targets.
 *   5. DNS resolution + classify — blocks hostnames that RESOLVE to private
 *                                  space, which is the real attack (an
 *                                  attacker controls DNS, not the URL text).
 *   6. Pinned connection         — the socket connects to an address that was
 *                                  actually validated, closing the DNS
 *                                  rebinding (TOCTOU) window where a name
 *                                  resolves publicly during the check and
 *                                  privately at connect time.
 *   7. Redirect re-validation    — every hop is re-checked by the caller.
 */
import dns from 'node:dns/promises';

import { classifyIp, IP_BLOCK_MESSAGES, type IpBlockReason } from './ip.js';

export interface SsrfPolicy {
  /** Permit plain http:// as well as https://. Default false. */
  allowHttp: boolean;
  /**
   * When non-empty, ONLY these hostnames (and their subdomains) are reachable.
   * An empty list means "any public host".
   */
  hostAllowlist: string[];
  /** Maximum redirect hops the caller may follow. */
  maxRedirects: number;
  /** Ports permitted in addition to the protocol defaults. Empty = defaults only. */
  extraPorts?: number[];
}

export const DEFAULT_SSRF_POLICY: SsrfPolicy = {
  allowHttp: false,
  hostAllowlist: [],
  maxRedirects: 3,
};

export type SsrfDenyCode =
  | 'INVALID_URL'
  | 'PROTOCOL_NOT_ALLOWED'
  | 'CREDENTIALS_IN_URL'
  | 'PORT_NOT_ALLOWED'
  | 'HOST_NOT_ALLOWED'
  | 'HOSTNAME_INVALID'
  | 'DNS_RESOLUTION_FAILED'
  | 'BLOCKED_ADDRESS';

export class SsrfError extends Error {
  constructor(
    readonly code: SsrfDenyCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'SsrfError';
  }
}

export interface SsrfValidationResult {
  /** The parsed, normalised URL that should actually be requested. */
  url: URL;
  /** Every address the hostname resolved to; all of them passed classification. */
  addresses: { address: string; family: 4 | 6 }[];
  /** True when the host portion was already a literal IP (no DNS was needed). */
  wasLiteralIp: boolean;
}

/** Ports allowed by default: the standard web ports only. */
const DEFAULT_ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);

/**
 * Hostnames that must never be resolved, regardless of what DNS says.
 * Some resolvers map these to public IPs, so a name check is needed in
 * addition to the address check.
 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
]);

/** Suffixes that indicate an internal network name. */
const BLOCKED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.intranet',
  '.private',
  '.corp',
  '.home',
  '.lan',
];

function hostMatchesAllowlist(hostname: string, allowlist: string[]): boolean {
  const host = hostname.toLowerCase();
  return allowlist.some((entry) => {
    const allowed = entry.toLowerCase().replace(/^\*\./, '');
    return host === allowed || host.endsWith(`.${allowed}`);
  });
}

/**
 * Validate a target URL against the SSRF policy, resolving DNS as part of the
 * check. Throws SsrfError on any violation.
 *
 * The returned `addresses` MUST be the ones the caller actually connects to
 * (see `createPinnedLookup`); validating a name and then letting the HTTP
 * client resolve it again reopens the rebinding hole.
 */
export async function validateTargetUrl(
  rawUrl: string,
  policy: SsrfPolicy = DEFAULT_SSRF_POLICY,
): Promise<SsrfValidationResult> {
  // 1. Parse.
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError('INVALID_URL', 'The URL could not be parsed.', rawUrl.slice(0, 200));
  }

  // 2. Protocol allowlist.
  const protocol = url.protocol.toLowerCase();
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new SsrfError(
      'PROTOCOL_NOT_ALLOWED',
      `Protocol "${url.protocol}" is not allowed. Use https://.`,
    );
  }
  if (protocol === 'http:' && !policy.allowHttp) {
    throw new SsrfError(
      'PROTOCOL_NOT_ALLOWED',
      'Plain http:// is disabled. Use https:// instead.',
    );
  }

  // 3. Credentials embedded in the URL are a common way to confuse parsers.
  if (url.username !== '' || url.password !== '') {
    throw new SsrfError(
      'CREDENTIALS_IN_URL',
      'Credentials must not be embedded in the URL. Use the Auth tab instead.',
    );
  }

  // 4. Port policy.
  const port = url.port === '' ? (protocol === 'https:' ? 443 : 80) : Number(url.port);
  const allowedPorts = new Set([...DEFAULT_ALLOWED_PORTS, ...(policy.extraPorts ?? [])]);
  if (!allowedPorts.has(port)) {
    throw new SsrfError('PORT_NOT_ALLOWED', `Port ${port} is not allowed.`);
  }

  // 5. Hostname sanity.
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (hostname.length === 0 || hostname.length > 253) {
    throw new SsrfError('HOSTNAME_INVALID', 'The hostname is missing or too long.');
  }
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new SsrfError('HOST_NOT_ALLOWED', `Requests to "${hostname}" are blocked.`);
  }
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new SsrfError('HOST_NOT_ALLOWED', `Internal hostnames like "${hostname}" are blocked.`);
  }
  // A bare name with no dot is almost always an internal host.
  const isLiteralIp = /^\[?[0-9a-f:.]+\]?$/i.test(hostname) && /[.:]/.test(hostname);
  if (!hostname.includes('.') && !isLiteralIp) {
    throw new SsrfError('HOST_NOT_ALLOWED', `"${hostname}" is not a public hostname.`);
  }

  // 6. Optional strict allowlist.
  if (policy.hostAllowlist.length > 0 && !hostMatchesAllowlist(hostname, policy.hostAllowlist)) {
    throw new SsrfError(
      'HOST_NOT_ALLOWED',
      `"${hostname}" is not on the configured allowlist.`,
    );
  }

  // 7. Literal IP target: classify directly, no DNS involved.
  const bare = hostname.replace(/^\[|\]$/g, '');
  const literal = classifyIp(bare);
  if (literal.version !== null) {
    if (!literal.safe) {
      throw new SsrfError(
        'BLOCKED_ADDRESS',
        `The target ${IP_BLOCK_MESSAGES[literal.reason as IpBlockReason]}.`,
        bare,
      );
    }
    return {
      url,
      addresses: [{ address: bare, family: literal.version }],
      wasLiteralIp: true,
    };
  }

  // 8. Resolve and classify EVERY answer. One bad record poisons the target.
  let records: { address: string; family: number }[];
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new SsrfError(
      'DNS_RESOLUTION_FAILED',
      `Could not resolve "${hostname}".`,
      error instanceof Error ? error.message : undefined,
    );
  }

  if (records.length === 0) {
    throw new SsrfError('DNS_RESOLUTION_FAILED', `"${hostname}" did not resolve to any address.`);
  }

  const addresses: { address: string; family: 4 | 6 }[] = [];
  for (const record of records) {
    const classification = classifyIp(record.address);
    if (!classification.safe) {
      throw new SsrfError(
        'BLOCKED_ADDRESS',
        `"${hostname}" ${IP_BLOCK_MESSAGES[classification.reason as IpBlockReason]}.`,
        record.address,
      );
    }
    addresses.push({ address: record.address, family: record.family === 6 ? 6 : 4 });
  }

  return { url, addresses, wasLiteralIp: false };
}

/**
 * Build a `lookup` function for undici/node http that returns ONLY addresses
 * validated above, and re-classifies defensively before handing them over.
 *
 * This is the anti-rebinding pin: the connection can only go to an address the
 * guard already approved.
 */
export function createPinnedLookup(
  addresses: readonly { address: string; family: 4 | 6 }[],
): (
  hostname: string,
  options: unknown,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | { address: string; family: number }[],
    family?: number,
  ) => void,
) => void {
  const pinned = addresses.filter((entry) => classifyIp(entry.address).safe);

  return (_hostname, options, callback) => {
    if (pinned.length === 0) {
      const error: NodeJS.ErrnoException = new Error('No permitted address for host');
      error.code = 'ENOTFOUND';
      callback(error, '');
      return;
    }

    const wantsAll =
      typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;

    if (wantsAll) {
      callback(
        null,
        pinned.map((entry) => ({ address: entry.address, family: entry.family })),
      );
      return;
    }

    const first = pinned[0] as { address: string; family: 4 | 6 };
    callback(null, first.address, first.family);
  };
}

/**
 * Validate a redirect target. Redirects are the most common way to slip past a
 * one-shot URL check, so every hop gets the full treatment (report 20.2:
 * "limit redirects").
 */
export async function validateRedirect(
  location: string,
  currentUrl: URL,
  policy: SsrfPolicy,
): Promise<SsrfValidationResult> {
  // Relative Location headers are legal; resolve against the current URL first.
  const absolute = new URL(location, currentUrl).toString();
  return validateTargetUrl(absolute, policy);
}
