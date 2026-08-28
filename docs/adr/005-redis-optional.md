# ADR-005: Redis as an optimisation, never a requirement

**Status:** Accepted

## Context

Redis backs caching, rate limiting, distributed locks and queues. Report section 35 requires the
platform to degrade rather than fail when Redis is unavailable, but each of those four uses has a
different correct failure mode.

## Decision

Every Redis-backed capability sits behind an interface with an in-process implementation, and each
one chooses its own failure behaviour:

| Capability | Redis down |
|---|---|
| Cache | Fail **open** — a miss is always safe; PostgreSQL is the source of truth |
| Rate limiting | Fail **closed** — fall back to a per-instance limiter, never to unlimited |
| Locks | Degrade to in-process — correctness comes from idempotent jobs, not the lock |
| Queues | Degrade to an in-process queue with the same retry, backoff and dead-letter semantics |

## Consequences

**Good.** A Redis outage degrades performance, not availability. Local development needs no Redis.
The distinction between "cache may fail open" and "limiter must fail closed" is expressed in code
rather than assumed.

**Bad.** Two implementations of each capability to keep in step. Mitigated by keeping the *policy*
(token-bucket maths, backoff, LRU) in `packages/algorithms` and unit-testing it once, so only the
transport differs.

**Cost of the fallback.** With N API instances and no Redis, the effective rate limit is N times the
configured limit. Acceptable for a degraded mode, not as a steady state.

## Revisit when

Multi-instance deployment becomes the norm. At that point Redis stops being optional in practice,
even though the code still tolerates its absence.
