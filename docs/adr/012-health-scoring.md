# ADR-012: Health state machine and reliability score

**Status:** Accepted

## Context

"Is this API up?" is not a single observation. A probe can fail because the API is down, because our
network hiccuped, or because we are being rate limited. Reporting each failure as an outage would
make the status board flap and become worthless.

## Decision

**A state machine, not a boolean.** `UNKNOWN -> UP -> DEGRADED -> DOWN`, driven by consecutive
counters persisted on the row rather than by job-local state, so a duplicated job cannot corrupt it.

Classification encodes real judgement:

- `401` and `403` mean **up**. The endpoint works; we simply lack a credential. Most of the catalogue
  requires keys, and marking those down would be plainly wrong.
- `429` means **degraded**: alive and rate limiting us.
- `5xx` and transport failures mean **down**.
- A slow but successful response is **degraded**.

Two consecutive failures are required before a public status flips to down.

**Reliability** is a weighted composite, per the report:

```
0.50*uptime30d + 0.20*successRate7d + 0.15*latency + 0.10*freshness + 0.05*(1 - incidents)
```

Unmeasured dimensions score 0.5 (neutral), so a newly-added API is not ranked below one with a known
bad record. Windows are recomputed from stored observations rather than incremented, so they are
reproducible.

## Consequences

**Good.** Status is stable and defensible. Probe scheduling adapts: failing APIs are re-checked
sooner, long-dead ones back off up to eight times the base interval.

**Bad.** A genuine outage takes two probe cycles to appear. Deliberate: a false "down" on a public
board is more damaging than a few minutes of delay.

## Revisit when

Probing from multiple regions makes it possible to distinguish "down" from "unreachable from
here".
