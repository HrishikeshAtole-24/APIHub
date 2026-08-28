# ADR-003: Fastify for the API layer

**Status:** Accepted

## Context

The API needs schema validation at the boundary, a plugin and encapsulation model for middleware,
and throughput headroom for a proxy endpoint that holds connections open.

Express is the default choice and would work. NestJS offers more structure at the cost of a
framework-shaped application.

## Decision

**Fastify**, with our own layering (route to service to repository) rather than a framework's.

## Consequences

**Good.** Materially faster JSON serialisation and routing than Express. Encapsulated plugin scopes
map cleanly to route groups. First-class async/await with no `next(err)` plumbing.

**Bad.** A smaller middleware ecosystem than Express, and its type generics are involved enough that
the app instance is pinned to the default `FastifyInstance` so plugin signatures stay portable.

**Sharp edge discovered.** Fastify does not propagate an error handler into encapsulated contexts
created *before* it is registered. Registering `setErrorHandler` after `app.register(routes)` left
every `/v1` route on the default handler, turning SSRF rejections into raw 500 responses. The handler
is now registered before routes, with a comment stating why.

## Revisit when

The API needs generated OpenAPI documentation as a first-class artifact. Fastify supports it, but the
schema-first workflow would change how routes are written.
