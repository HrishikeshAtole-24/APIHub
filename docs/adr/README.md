# Architecture Decision Records

Each record captures one decision, the forces behind it, and what it costs. They are written so a
future maintainer can tell whether a decision still holds — a record with no stated trade-off is not
worth keeping.

Format: context, decision, consequences (including the ones we dislike), and the conditions that
would justify revisiting.

| ADR | Decision | Status |
|---|---|---|
| [001](001-modular-monolith.md) | Modular monolith instead of microservices | Accepted |
| [002](002-nextjs-app-router.md) | Next.js App Router with Server Components | Accepted |
| [003](003-fastify-backend.md) | Fastify for the API layer | Accepted |
| [004](004-postgres-drivers.md) | PostgreSQL with an interchangeable driver layer | Accepted |
| [005](005-redis-optional.md) | Redis as an optimisation, never a requirement | Accepted |
| [006](006-postgres-fts.md) | PostgreSQL full-text search before a search engine | Accepted |
| [007](007-retrieval-then-ranking.md) | Separate bounded retrieval from ranking | Accepted |
| [008](008-job-queue-abstraction.md) | Queue abstraction over BullMQ | Accepted |
| [009](009-ssrf-boundary.md) | SSRF boundary for all outbound requests | Accepted |
| [010](010-provenance.md) | Provenance and attribution on every record | Accepted |
| [011](011-idempotent-ingestion.md) | Idempotent ingestion via fingerprints | Accepted |
| [012](012-health-scoring.md) | Health state machine and reliability score | Accepted |
| [013](013-server-sessions.md) | Server-side sessions instead of stateless JWTs | Accepted |
| [014](014-deterministic-recommendations.md) | Deterministic, grounded recommendations | Accepted |
| [015](015-typescript-5.md) | TypeScript 5.9 rather than the 7.0 native port | Accepted |
