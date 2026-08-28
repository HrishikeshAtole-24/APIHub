/**
 * IP address classification for the SSRF boundary (report 20.2).
 *
 * The rule APIHub enforces: an outbound request initiated on a user's behalf
 * may only reach a PUBLIC unicast address. Everything else — loopback,
 * private ranges, link-local, cloud metadata endpoints, multicast, reserved
 * space — is denied.
 *
 * Deny-by-default: an address we cannot parse or classify is treated as unsafe.
 */

/** Why an address was rejected. Surfaced to the user and recorded in audit logs. */
export type IpBlockReason =
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'cloud-metadata'
  | 'multicast'
  | 'broadcast'
  | 'unspecified'
  | 'reserved'
  | 'carrier-nat'
  | 'documentation'
  | 'unique-local'
  | 'unparseable';

export interface IpClassification {
  safe: boolean;
  reason?: IpBlockReason;
  version: 4 | 6 | null;
}

// ── IPv4 ──────────────────────────────────────────────────────

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Parse dotted-quad IPv4 into a 32-bit unsigned integer, or null. */
export function parseIpv4(address: string): number | null {
  const match = IPV4_PATTERN.exec(address);
  if (!match) return null;

  let value = 0;
  for (let i = 1; i <= 4; i += 1) {
    const octetText = match[i] as string;
    // Reject leading zeros: "010.0.0.1" is octal in some resolvers, a classic
    // SSRF filter bypass.
    if (octetText.length > 1 && octetText.startsWith('0')) return null;
    const octet = Number(octetText);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

interface Range4 {
  cidr: string;
  reason: IpBlockReason;
  base: number;
  mask: number;
}

function range4(cidr: string, reason: IpBlockReason): Range4 {
  const [addressPart, prefixPart] = cidr.split('/');
  const base = parseIpv4(addressPart as string);
  if (base === null) throw new Error(`Invalid CIDR in blocklist: ${cidr}`);

  const prefix = Number(prefixPart);
  // A /0 mask would be `-1 >>> 0`; guard it explicitly since `<<32` is a no-op in JS.
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { cidr, reason, base: (base & mask) >>> 0, mask };
}

/**
 * IPv4 ranges that must never be reachable through the playground or a probe.
 * Ordered most-specific first so the reported reason is the most useful one.
 */
const BLOCKED_IPV4: Range4[] = [
  range4('169.254.169.254/32', 'cloud-metadata'), // AWS/GCP/Azure/DO IMDS
  range4('100.100.100.200/32', 'cloud-metadata'), // Alibaba Cloud metadata
  range4('255.255.255.255/32', 'broadcast'), // must precede 240.0.0.0/4
  range4('0.0.0.0/8', 'unspecified'),
  range4('10.0.0.0/8', 'private'),
  range4('100.64.0.0/10', 'carrier-nat'), // RFC 6598 CGNAT
  range4('127.0.0.0/8', 'loopback'),
  range4('169.254.0.0/16', 'link-local'),
  range4('172.16.0.0/12', 'private'),
  range4('192.0.0.0/24', 'reserved'),
  range4('192.0.2.0/24', 'documentation'),
  range4('192.88.99.0/24', 'reserved'),
  range4('192.168.0.0/16', 'private'),
  range4('198.18.0.0/15', 'reserved'), // benchmarking
  range4('198.51.100.0/24', 'documentation'),
  range4('203.0.113.0/24', 'documentation'),
  range4('224.0.0.0/4', 'multicast'),
  range4('240.0.0.0/4', 'reserved'),
];

export function classifyIpv4(address: string): IpClassification {
  const value = parseIpv4(address);
  if (value === null) return { safe: false, reason: 'unparseable', version: null };

  for (const range of BLOCKED_IPV4) {
    if (((value & range.mask) >>> 0) === range.base) {
      return { safe: false, reason: range.reason, version: 4 };
    }
  }
  return { safe: true, version: 4 };
}

// ── IPv6 ──────────────────────────────────────────────────────

/** Expand an IPv6 address (including `::` and IPv4-mapped forms) to 8 groups. */
export function parseIpv6(address: string): number[] | null {
  let text = address.trim().toLowerCase();

  // Strip a zone index such as `%eth0`.
  const zoneIndex = text.indexOf('%');
  if (zoneIndex !== -1) text = text.slice(0, zoneIndex);
  if (text.length === 0) return null;

  // Handle a trailing IPv4 portion, e.g. ::ffff:192.168.1.1
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (v4 === null) return null;
    text = `${text.slice(0, lastColon + 1)}${((v4 >>> 16) & 0xffff)
      .toString(16)
      .padStart(4, '0')}:${(v4 & 0xffff).toString(16).padStart(4, '0')}`;
  }

  const doubleColonCount = (text.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return null;

  let head: string[];
  let rear: string[];

  if (doubleColonCount === 1) {
    const [left = '', right = ''] = text.split('::');
    head = left.length > 0 ? left.split(':') : [];
    rear = right.length > 0 ? right.split(':') : [];
    if (head.length + rear.length > 7) return null;
  } else {
    head = text.split(':');
    rear = [];
    if (head.length !== 8) return null;
  }

  const groups: number[] = [];
  for (const part of head) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(parseInt(part, 16));
  }
  while (groups.length + rear.length < 8) groups.push(0);
  for (const part of rear) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(parseInt(part, 16));
  }

  return groups.length === 8 ? groups : null;
}

export function classifyIpv6(address: string): IpClassification {
  const groups = parseIpv6(address);
  if (!groups) return { safe: false, reason: 'unparseable', version: null };

  const [g0 = 0, g1 = 0] = groups;

  // ::  (unspecified)
  if (groups.every((g) => g === 0)) return { safe: false, reason: 'unspecified', version: 6 };
  // ::1 (loopback)
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) {
    return { safe: false, reason: 'loopback', version: 6 };
  }

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible: classify the embedded v4.
  // Without this, `http://[::ffff:127.0.0.1]/` would bypass the v4 blocklist.
  const isV4Mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  const isV4Compatible = groups.slice(0, 6).every((g) => g === 0);
  if (isV4Mapped || isV4Compatible) {
    const g6 = groups[6] as number;
    const g7 = groups[7] as number;
    const embedded = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
    const nested = classifyIpv4(embedded);
    return nested.safe ? { safe: true, version: 6 } : { ...nested, version: 6 };
  }

  // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfe80) return { safe: false, reason: 'link-local', version: 6 };
  // fc00::/7 unique local
  if ((g0 & 0xfe00) === 0xfc00) return { safe: false, reason: 'unique-local', version: 6 };
  // ff00::/8 multicast
  if ((g0 & 0xff00) === 0xff00) return { safe: false, reason: 'multicast', version: 6 };
  // 2001:db8::/32 documentation
  if (g0 === 0x2001 && g1 === 0x0db8) return { safe: false, reason: 'documentation', version: 6 };
  // 100::/64 discard-only
  if (g0 === 0x0100 && groups.slice(1, 4).every((g) => g === 0)) {
    return { safe: false, reason: 'reserved', version: 6 };
  }

  return { safe: true, version: 6 };
}

/** Classify any literal IP address. Deny-by-default on parse failure. */
export function classifyIp(address: string): IpClassification {
  const trimmed = address.trim().replace(/^\[|\]$/g, '');
  if (trimmed.length === 0) return { safe: false, reason: 'unparseable', version: null };
  return trimmed.includes(':') ? classifyIpv6(trimmed) : classifyIpv4(trimmed);
}

export function isPublicIp(address: string): boolean {
  return classifyIp(address).safe;
}

/** Human-readable explanation, used in error responses and audit logs. */
export const IP_BLOCK_MESSAGES: Record<IpBlockReason, string> = {
  loopback: 'resolves to a loopback address',
  private: 'resolves to a private network address',
  'link-local': 'resolves to a link-local address',
  'cloud-metadata': 'resolves to a cloud metadata endpoint',
  multicast: 'resolves to a multicast address',
  broadcast: 'resolves to a broadcast address',
  unspecified: 'resolves to an unspecified address',
  reserved: 'resolves to a reserved address range',
  'carrier-nat': 'resolves to a carrier-grade NAT address',
  documentation: 'resolves to a documentation-only address range',
  'unique-local': 'resolves to a unique local address',
  unparseable: 'could not be parsed as a valid IP address',
};
