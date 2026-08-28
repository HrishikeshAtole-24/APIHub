/**
 * Custom Drizzle column types.
 */
import { customType } from 'drizzle-orm/pg-core';

/**
 * PostgreSQL `tsvector`.
 *
 * Drizzle has no built-in tsvector type. The column is never read into
 * application code — it exists purely so `@@` queries can use the GIN index —
 * so the driver mapping is a plain string.
 */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

/**
 * PostgreSQL `vector(n)` from the pgvector extension.
 *
 * Only used by the optional Neon-only migration. Kept here so the same schema
 * file can describe both deployments.
 */
export const vector = customType<{ data: number[]; driverData: string; config: { dimensions: number } }>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 384})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string): number[] {
    return value
      .slice(1, -1)
      .split(',')
      .map((n) => Number(n));
  },
});
