# ADR-006: PostgreSQL full-text search before a search engine

**Status:** Accepted

## Context

Search is the product's core interaction. Elasticsearch or OpenSearch would offer richer analysis and
faceting, at the cost of a second datastore to run, secure, index and keep consistent.

## Decision

**PostgreSQL full-text search** with a weighted `tsvector`, maintained by a database trigger.

Weights follow the report: name `A`, provider and tags `B`, description `C`, long description `D`. A
GIN index backs the `@@` operator. `ts_rank_cd` is used rather than `ts_rank` because it accounts for
term proximity.

The trigger matters: any writer — the API, the ingestion worker, a manual SQL fix — produces a
correct search vector without remembering to recompute it.

## Consequences

**Good.** No second datastore, no index/database consistency problem, no reindex pipeline for
ordinary writes. Search participates in transactions. Verified in tests: a name match outranks a
description-only match.

**Bad.** English-only stemming. No fuzzy matching without `pg_trgm` (added, with a guard for
environments that lack it). Scales to hundreds of thousands of rows, not tens of millions.

**Upgrade path already in place.** `api_embeddings` stores vectors keyed by model, and the ranking
layer already has a hybrid strategy, so semantic search is an added retrieval arm rather than a
rewrite.

## Revisit when

p95 search latency exceeds the 500 ms target under real load, or the catalogue grows past roughly a
million rows.
