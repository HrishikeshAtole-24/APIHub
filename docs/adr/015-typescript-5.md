# ADR-015: TypeScript 5.9 rather than the 7.0 native port

**Status:** Accepted

## Context

TypeScript 7.0, the Go-native compiler port, is the current `latest` on npm and offers a large speed
improvement.

## Decision

Pin **TypeScript 5.9.3** across the monorepo.

## Rationale

The report itself says to "verify exact package versions during bootstrap" rather than accept moving
`latest` tags. The toolchain here spans drizzle-kit, tsup, vitest, Next.js and typescript-eslint, and
a native compiler rewrite is exactly the kind of change where one of those has an incompatibility
that costs more than the compile time saves.

Everything else is pinned to genuinely current versions: Next.js 16.3, React 19.2, Fastify 5.12,
Drizzle 0.45, Zod 4.4, Node 24 LTS.

## Consequences

**Good.** A build that works. No time spent debugging toolchain incompatibilities in a project whose
point is the architecture.

**Bad.** Slower type checking than TS 7 would give, and a version bump owed later.

## Revisit when

The surrounding toolchain has settled on TS 7, realistically once drizzle-kit and typescript-eslint
publish releases that test against it.
