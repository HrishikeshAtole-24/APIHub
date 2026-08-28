# ADR-013: Server-side sessions instead of stateless JWTs

**Status:** Accepted

## Context

A stateless JWT avoids a database lookup per request. It also cannot be revoked: logout, "sign out
everywhere", and disabling a compromised account all become "wait for expiry", unless a revocation
list is added, which reintroduces the lookup while keeping the complexity.

## Decision

**Server-side sessions** in PostgreSQL, referenced by an opaque id in an HttpOnly cookie.

- The cookie carries `<sessionId>.<hmac>`, so a forged cookie is rejected without a database hit.
- Only the **HMAC of the session id** is stored, so a database dump does not yield usable cookies.
  The same reasoning as password hashing.
- `lastSeenAt` is refreshed at most once a minute, keeping read endpoints read-only.
- Passwords use **Argon2id** via `hash-wasm` (WebAssembly, no native toolchain), with parameters from
  OWASP guidance and transparent rehashing on login when they are raised.
- Login performs a decoy hash when no account matches, so timing cannot enumerate registered emails.
  The decoy is computed for real at boot; a hand-written constant would be rejected as malformed and
  return instantly, defeating the purpose.
- CSRF tokens are bound to the session, so one cannot be replayed against another.

## Consequences

**Good.** Immediate revocation. Sessions are inspectable and auditable. No token-size limits on what
the session can reference.

**Bad.** A database read per authenticated request. Cheap, indexed, and cacheable in Redis.

## Revisit when

An OAuth provider is added. The identity provider sits behind an adapter; sessions stay.
