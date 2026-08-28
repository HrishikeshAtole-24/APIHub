# ADR-002: Next.js App Router with Server Components

**Status:** Accepted

## Context

The catalogue must be indexable: public API pages are the product's SEO surface. It must also feel
like a tool, with an interactive playground and instant filtering.

Those pull in opposite directions. A pure SPA renders an empty shell to crawlers; a pure
server-rendered app makes the playground painful.

## Decision

Next.js App Router, defaulting to **Server Components**, with client interactivity added as islands.

- Catalogue, detail, categories and status pages are Server Components: real HTML, real metadata, no
  client fetching.
- Only genuinely interactive pieces are client components: the playground, filters, command palette,
  favourite button, theme toggle.
- Search and filter state lives in the **URL**, so every view is linkable and the back button works.
- Suspense boundaries stream slow sections (statistics, health) without blocking the page.

## Consequences

**Good.** Fast first paint and correct SEO with no separate rendering path. The client bundle stays
small because most of the tree never ships JavaScript. URL-as-state removes an entire class of
client store bugs.

**Bad.** The server/client split is a real constraint that has to be held in mind constantly; a
stray hook in a Server Component is a build error. Personalised data forces dynamic rendering,
losing static optimisation on those routes.

**Note.** Session state is resolved on the server and seeded into context, so the header renders
signed-in on first paint with no authentication flicker.

## Revisit when

The product loses its public surface entirely and becomes a single dense dashboard, at which point a
plain SPA would be simpler.
