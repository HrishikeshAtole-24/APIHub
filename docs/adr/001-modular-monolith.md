# ADR-001: Modular monolith instead of microservices

**Status:** Accepted

## Context

APIHub has several distinct domains: catalogue, search, playground, health monitoring, ingestion,
identity, reviews and admin. A service-per-domain layout is the obvious "scalable" answer and the
one a portfolio project is tempted to reach for.

At the current scale that would buy nothing and cost a great deal: every cross-domain read becomes a
network call, a transaction spanning catalogue and search becomes a distributed transaction, and
local development needs an orchestrator before a single page renders.

## Decision

Build a **modular monolith** with enforced module boundaries in code, plus a **separate worker
runtime**.

The API is one deployable with `src/modules/*` owning its own repository, service and routes.
Modules talk through typed service interfaces and a domain event bus, never by reaching into each
other's tables.

The worker is split out from day one, because health probes and ingestion are genuinely
asynchronous, IO-bound, and need to scale on a different axis from request handling.

## Consequences

**Good.** Transactions stay local. Debugging is one process and one log stream. Deployment is one
artifact. Refactoring across a boundary is a compiler error rather than a version negotiation.

**Bad.** Nothing forces the boundaries at runtime; a careless import can couple two modules, and
only review catches it. The whole API scales as one unit, so a hot search endpoint drags the rest of
it along.

**Mitigation.** Shared logic that both runtimes need lives in `packages/domain` and `packages/jobs`,
so extracting a service later means changing a caller, not rewriting the logic.

## Revisit when

A single module's traffic or failure profile diverges sharply from the rest, most likely search or
the playground proxy. Extract that one, not all of them.
