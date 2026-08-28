/**
 * Playground contracts (report 5 FR-04, 20.2).
 *
 * The playground is the platform's most security-sensitive surface: it makes
 * the server issue an HTTP request on a user's behalf. The request schema is
 * therefore deliberately narrow — no arbitrary protocols, bounded sizes,
 * bounded header counts.
 */
import { z } from 'zod';

import { HttpMethodSchema, IsoDateSchema } from './common';

/** A single user-supplied header. Keys are validated against RFC 7230 token rules. */
export const HeaderPairSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/, 'Invalid header name'),
  value: z.string().max(4096),
  enabled: z.boolean().default(true),
});
export type HeaderPair = z.infer<typeof HeaderPairSchema>;

export const QueryParamSchema = z.object({
  name: z.string().min(1).max(128),
  value: z.string().max(2048),
  enabled: z.boolean().default(true),
});
export type QueryParam = z.infer<typeof QueryParamSchema>;

/**
 * Auth the user wants applied to the outbound request.
 *
 * MVP policy (report 4.2): credentials are used for a single request and are
 * never persisted server-side. The client may keep them in sessionStorage.
 */
export const PlaygroundAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.literal('apiKey'),
    key: z.string().min(1).max(1024),
    in: z.enum(['header', 'query']),
    name: z.string().min(1).max(128),
  }),
  z.object({ type: z.literal('bearer'), token: z.string().min(1).max(4096) }),
  z.object({
    type: z.literal('basic'),
    username: z.string().max(256),
    password: z.string().max(256),
  }),
]);
export type PlaygroundAuth = z.infer<typeof PlaygroundAuthSchema>;

export const PlaygroundRequestSchema = z.object({
  /** Optional: links the execution to a catalogue entry for analytics. */
  apiId: z.string().optional(),
  method: HttpMethodSchema,
  url: z.string().min(1).max(2048),
  headers: z.array(HeaderPairSchema).max(30).default([]),
  queryParams: z.array(QueryParamSchema).max(30).default([]),
  body: z.string().max(64 * 1024).optional(),
  contentType: z.string().max(128).optional(),
  auth: PlaygroundAuthSchema.default({ type: 'none' }),
  /** Client-side cap; the server clamps this to its own configured maximum. */
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
});
export type PlaygroundRequest = z.infer<typeof PlaygroundRequestSchema>;

/** Where the response time went. Populated best-effort from undici timings. */
export const TimingBreakdownSchema = z.object({
  dnsMs: z.number().nullable(),
  connectMs: z.number().nullable(),
  tlsMs: z.number().nullable(),
  firstByteMs: z.number().nullable(),
  downloadMs: z.number().nullable(),
  totalMs: z.number(),
});
export type TimingBreakdown = z.infer<typeof TimingBreakdownSchema>;

export const PlaygroundResponseSchema = z.object({
  requestId: z.string(),
  ok: z.boolean(),
  status: z.number().int(),
  statusText: z.string(),
  headers: z.record(z.string(), z.string()),
  /** Response body, truncated to the configured maximum. */
  body: z.string(),
  /** True when the body hit the size cap and was cut short. */
  truncated: z.boolean(),
  bodySizeBytes: z.number().int(),
  contentType: z.string().nullable(),
  timing: TimingBreakdownSchema,
  /** Redirect chain actually followed, for transparency. */
  redirects: z.array(z.string()),
  /** The final URL after redirects, with secrets stripped. */
  finalUrl: z.string(),
  executedAt: IsoDateSchema,
});
export type PlaygroundResponse = z.infer<typeof PlaygroundResponseSchema>;

// ── Code generation (report FR "API Test Generator") ──────────

export const CodeLanguageSchema = z.enum([
  'curl',
  'javascript-fetch',
  'javascript-axios',
  'typescript-fetch',
  'python-requests',
  'python-httpx',
  'go',
  'java',
  'csharp',
  'php',
  'ruby',
  'rust',
]);
export type CodeLanguage = z.infer<typeof CodeLanguageSchema>;

export const CODE_LANGUAGE_LABELS: Record<CodeLanguage, string> = {
  curl: 'cURL',
  'javascript-fetch': 'JavaScript (fetch)',
  'javascript-axios': 'JavaScript (axios)',
  'typescript-fetch': 'TypeScript (fetch)',
  'python-requests': 'Python (requests)',
  'python-httpx': 'Python (httpx)',
  go: 'Go',
  java: 'Java',
  csharp: 'C#',
  php: 'PHP',
  ruby: 'Ruby',
  rust: 'Rust',
};

/** Syntax-highlighting hint for the frontend code viewer. */
export const CODE_LANGUAGE_SYNTAX: Record<CodeLanguage, string> = {
  curl: 'bash',
  'javascript-fetch': 'javascript',
  'javascript-axios': 'javascript',
  'typescript-fetch': 'typescript',
  'python-requests': 'python',
  'python-httpx': 'python',
  go: 'go',
  java: 'java',
  csharp: 'csharp',
  php: 'php',
  ruby: 'ruby',
  rust: 'rust',
};

export const CodeGenRequestSchema = z.object({
  language: CodeLanguageSchema,
  request: PlaygroundRequestSchema,
});
export type CodeGenRequest = z.infer<typeof CodeGenRequestSchema>;

export const CodeGenResultSchema = z.object({
  language: CodeLanguageSchema,
  syntax: z.string(),
  code: z.string(),
});
export type CodeGenResult = z.infer<typeof CodeGenResultSchema>;
