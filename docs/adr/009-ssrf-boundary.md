# ADR-009: SSRF boundary for all outbound requests

**Status:** Accepted

## Context

Two features make the server issue HTTP requests influenced by users: the playground (fully
user-controlled) and health probes (URLs from an ingested third-party dataset). Both are classic
server-side request forgery vectors.

The naive mistake is validating the URL string. The real attack validates fine and *resolves* to
`169.254.169.254`, or resolves publicly during validation and privately at connect time.

## Decision

A single guard in `packages/security`, applied to **every** outbound request:

1. Protocol allowlist (`https`, and `http` only when explicitly enabled).
2. Port allowlist. 22, 5432, 6379 and friends are refused.
3. Rejection of credentials in the URL and of internal hostnames (`localhost`, `.local`,
   `.internal`, `metadata.google.internal`).
4. **DNS resolution, then classification of every returned address** against a blocklist covering
   loopback, RFC 1918, link-local, CGNAT, multicast, reserved, documentation and cloud-metadata
   ranges, with IPv4-mapped IPv6 unwrapped so `::ffff:127.0.0.1` is caught.
5. **Connection pinned** to a validated address via a custom `lookup`, closing the DNS-rebinding
   window.
6. Hop-by-hop and identity headers stripped; CRLF in header values rejected.
7. Timeouts, a redirect limit, and a response cap enforced *while streaming* and *after
   decompression*, so a small gzip payload cannot expand past it.
8. Per-host circuit breaker.
9. Secrets redacted before logging; only the hostname is persisted.

## Consequences

**Good.** One implementation, one test suite, covering both call sites. Seventeen attack vectors are
asserted in the API integration tests and a further twenty at the unit level.

**Bad.** Legitimate targets are occasionally refused, such as an API on a non-standard port or a host
behind CGNAT. The allowlist is configurable for deployments that need it.

**Deliberately user-facing.** A blocked request explains why ("resolves to a cloud metadata
endpoint"). That reveals nothing an attacker could not determine themselves, and it saves everyone
else from a confusing failure.

## Revisit when

The playground moves to a dedicated egress network. The guard stays; the network becomes a second
layer.
