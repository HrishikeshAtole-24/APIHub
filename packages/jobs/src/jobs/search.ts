/**
 * Search reindex job (report 15, 25).
 *
 * The tsvector itself is maintained by a database trigger, so a reindex is not
 * about rebuilding text vectors. It refreshes the DERIVED projections that the
 * trigger cannot know about:
 *   - denormalised category counts,
 *   - the tsvector for rows written before the trigger existed,
 *   - PostgreSQL planner statistics after a large import.
 */
import { getLogger } from '@apihub/logger';
import type { DatabaseHandle } from '@apihub/database';

const log = getLogger('worker.search');

export async function reindexSearch(handle: DatabaseHandle): Promise<void> {
  const startedAt = Date.now();

  // Touching updated_at fires the BEFORE UPDATE trigger, which recomputes the
  // weighted search vector. Restricted to rows missing one so a reindex on a
  // large catalogue does not rewrite every row.
  await handle.execute(`
    UPDATE apis SET updated_at = updated_at WHERE search_vector IS NULL
  `);

  await handle.execute(`
    UPDATE categories c
       SET api_count = (
         SELECT count(*) FROM api_category_map m
           JOIN apis a ON a.id = m.api_id
          WHERE m.category_id = c.id AND a.status = 'active'
       )
  `);

  // Refresh planner statistics: after a bulk import the estimates are stale,
  // which is a common cause of a sudden switch to a sequential scan.
  try {
    await handle.execute('ANALYZE apis');
    await handle.execute('ANALYZE api_category_map');
  } catch {
    // ANALYZE is an optimisation; not every deployment grants permission.
  }

  log.info({ durationMs: Date.now() - startedAt }, 'search projection refreshed');
}
