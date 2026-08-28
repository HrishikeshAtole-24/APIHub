# ADR-010: Provenance and attribution on every record

**Status:** Accepted

## Context

The catalogue derives from an MIT-licensed upstream project. MIT requires attribution. Beyond the
licence, a catalogue that cannot say where a record came from cannot be audited, corrected or
trusted.

## Decision

Every API row stores `source_id`, `source_record_id`, `source_revision`, `imported_at` and a content
`fingerprint`. Sources are first-class rows carrying name, URL, licence and transform version.

Provenance is **surfaced in the product**: every API detail page shows its source, licence and import
time, and the footer credits the upstream project on every page.

## Consequences

**Good.** Licence obligations are met by construction rather than by a line in a README. A wrong
record can be traced to the exact upstream revision. Changing the normalisation logic is a
`transform_version` bump, making the effect auditable.

**Bad.** Five extra columns and a join on the detail query. Trivial next to the benefit.

## Revisit when

Additional sources are added. The model already supports them; only adapters are needed.
