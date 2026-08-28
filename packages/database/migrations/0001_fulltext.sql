-- Full-text search support (report 15.1).
--
-- Drizzle can describe the tsvector column and its GIN index, but not the
-- logic that keeps the vector in sync. That is done here with a trigger so the
-- index is maintained by PostgreSQL itself: any writer (the API, the ingestion
-- worker, a manual SQL fix) gets a correct search vector without remembering
-- to recompute it.
--
-- Weights follow the report's instruction that "API name/title matches
-- dominate description matches":
--   A  name                (highest)
--   B  provider + tags
--   C  description
--   D  long description    (lowest)

CREATE OR REPLACE FUNCTION apihub_apis_search_vector() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
      setweight(to_tsvector('english', coalesce(NEW.name, '')), 'A')
   || setweight(to_tsvector('english', coalesce(NEW.provider, '')), 'B')
   || setweight(
        to_tsvector(
          'english',
          coalesce(
            (SELECT string_agg(value, ' ')
               FROM jsonb_array_elements_text(
                 CASE
                   WHEN jsonb_typeof(NEW.tags) = 'array' THEN NEW.tags
                   ELSE '[]'::jsonb
                 END
               ) AS t(value)),
            ''
          )
        ),
        'B'
      )
   || setweight(to_tsvector('english', coalesce(NEW.description, '')), 'C')
   || setweight(to_tsvector('english', coalesce(NEW.long_description, '')), 'D');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS apis_search_vector_trigger ON apis;
--> statement-breakpoint

CREATE TRIGGER apis_search_vector_trigger
  BEFORE INSERT OR UPDATE OF name, provider, description, long_description, tags
  ON apis
  FOR EACH ROW
  EXECUTE FUNCTION apihub_apis_search_vector();
--> statement-breakpoint

-- Backfill any rows that predate the trigger.
UPDATE apis SET updated_at = updated_at WHERE search_vector IS NULL;
--> statement-breakpoint

-- Trigram index for fuzzy name matching and "did you mean?" suggestions.
-- pg_trgm ships with PostgreSQL and is available on Neon and PGlite alike;
-- the guard keeps the migration idempotent if the extension is unavailable.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX IF NOT EXISTS apis_name_trgm_idx ON apis USING gin (name gin_trgm_ops);
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pg_trgm unavailable; fuzzy name matching will use the application fallback';
END;
$$;
