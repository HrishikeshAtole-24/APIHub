# ADR-007: Separate bounded retrieval from ranking

**Status:** Accepted

## Context

Ranking wants many signals: text relevance, popularity, reliability, latency, freshness, free-tier
status and documentation quality. Most of those cannot be expressed efficiently in SQL, and some
(semantic similarity) cannot be expressed at all.

Ranking in the database means a complex query that scans too much. Ranking everything in the
application means loading the catalogue into memory.

## Decision

**Two phases, explicitly.**

1. **Retrieval.** PostgreSQL returns at most 400 candidates using the GIN index, ordered by raw text
   rank so truncation keeps the most relevant material.
2. **Ranking.** The application scores those candidates and selects the page with a **size-K
   min-heap**: `O(N log K)` time and `O(K)` space, instead of sorting all N.

Only the surviving page is then hydrated with categories, ratings and favourite counts.

## Consequences

**Good.** Ranking complexity is unbounded by SQL's expressiveness and is unit-testable in isolation.
Hydration cost is proportional to page size, not result-set size. Adding a signal does not touch the
query.

**Bad.** Deep pagination degrades: page 20 needs a window of 480 candidates, and beyond the retrieval
cap results become approximate. Acceptable, since nobody paginates to page 20 of a search; they
refine it.

**Also.** The candidate cap means an extremely broad query is ranked over a sample rather than the
whole match set. The count shown is the true total, so the user is not misled.

## Revisit when

Deep pagination becomes a real access pattern, at which point cursor pagination over a materialised
ranking would replace the window.
