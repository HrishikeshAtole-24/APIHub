# ADR-008: Queue abstraction over BullMQ

**Status:** Accepted

## Context

Background work — ingestion, health probes, aggregation, cleanup — needs retries, backoff,
scheduling, priority and a dead-letter path. BullMQ provides all of it, and requires Redis.

## Decision

Define a `JobQueue` interface and implement it twice: **BullMQ** when Redis is configured, and an
**in-process priority queue** when it is not.

The in-process implementation is not a stub. It implements priority ordering (via the binary heap
from `packages/algorithms`), delayed jobs, bounded concurrency, exponential backoff with jitter,
attempt limits, a dead-letter list, and replay of failed jobs.

Job handlers live in `packages/jobs` so the same code runs in a dedicated worker process or hosted
inside the API.

## Consequences

**Good.** The full ingestion and monitoring pipeline runs on a clean machine. Handler logic is
testable without infrastructure. Nothing in the application couples to BullMQ's API.

**Bad.** The in-process queue loses its state on restart, which is exactly what Redis is for. Two
implementations to maintain.

**Behaviour aligned deliberately.** `repeat()` does not fire immediately by default, matching BullMQ.
An earlier version fired on registration, which re-imported the entire catalogue on every dev reload
and every deploy.

## Revisit when

Job volume needs multiple competing consumers with visibility guarantees. That is already BullMQ's
territory, so the interface would not change.
