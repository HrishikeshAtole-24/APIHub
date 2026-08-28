/**
 * Playground service (report FR-04).
 *
 * Wraps the executor with the things that are policy rather than transport:
 * analytics, event publication and the "never persist a secret" rule.
 */
import type { CodeGenResult, CodeLanguage, PlaygroundRequest, PlaygroundResponse } from '@apihub/contracts';
import { schema, type Database } from '@apihub/database';
import { events } from '@apihub/runtime';
import { sql } from 'drizzle-orm';

import { generateAll, generateCode } from './codegen.js';
import { executePlaygroundRequest } from './executor.js';

export class PlaygroundService {
  constructor(private readonly db: Database) {}

  async execute(
    input: PlaygroundRequest,
    context: { requestId: string; userId: string | null },
  ): Promise<PlaygroundResponse> {
    let result;
    let errorCode: string | null = null;

    try {
      result = await executePlaygroundRequest(input, context.requestId);
    } catch (error) {
      errorCode = (error as { code?: string }).code ?? 'UPSTREAM_ERROR';
      // Record the failed attempt for abuse detection, then rethrow.
      await this.recordRun(input, context.userId, null, null, errorCode).catch(() => {});
      throw error;
    }

    await this.recordRun(
      input,
      context.userId,
      result.status,
      result.timing.totalMs,
      null,
      result.targetHost,
    ).catch(() => {});

    events.emitAsync('playground.executed', {
      apiId: input.apiId ?? null,
      host: result.targetHost,
      status: result.status,
    });

    // Strip the internal-only field before it reaches the client.
    const { targetHost: _targetHost, ...response } = result;
    return response;
  }

  /**
   * Persist a narrow execution record.
   *
   * Deliberately excludes the URL path, query, headers and body: any of those
   * can carry a credential (report 20.1). Only the host is kept, which is what
   * abuse detection and usage analytics actually need.
   */
  private async recordRun(
    input: PlaygroundRequest,
    userId: string | null,
    status: number | null,
    latencyMs: number | null,
    errorCode: string | null,
    host?: string,
  ): Promise<void> {
    let targetHost = host;
    if (!targetHost) {
      try {
        targetHost = new URL(input.url).hostname;
      } catch {
        targetHost = 'invalid';
      }
    }

    await this.db.insert(schema.playgroundRuns).values({
      id: schema.newId('audit'),
      userId,
      apiId: input.apiId ?? null,
      method: input.method,
      targetHost,
      responseStatus: status,
      latencyMs: latencyMs === null ? null : Math.round(latencyMs),
      errorCode,
    });

    if (input.apiId) {
      const day = new Date().toISOString().slice(0, 10);
      await this.db
        .insert(schema.apiViews)
        .values({ day, apiId: input.apiId, playgroundRuns: 1 })
        .onConflictDoUpdate({
          target: [schema.apiViews.day, schema.apiViews.apiId],
          set: { playgroundRuns: sql`${schema.apiViews.playgroundRuns} + 1` },
        });
    }
  }

  generate(language: CodeLanguage, request: PlaygroundRequest): CodeGenResult {
    return generateCode(language, request);
  }

  generateAll(request: PlaygroundRequest): CodeGenResult[] {
    return generateAll(request);
  }
}
