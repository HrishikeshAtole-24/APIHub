import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NextConfig } from 'next';

/**
 * Next.js configuration (report 10).
 *
 * `transpilePackages` is what makes the internal @apihub/* packages work: they
 * ship TypeScript source rather than build output, so Next compiles them as
 * part of the app. That keeps the monorepo free of a build-order dependency.
 */
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  /*
   * Standalone output traces exactly the files the server needs and emits a
   * self-contained bundle, so the Docker runtime layer ships no node_modules.
   */
  output: 'standalone',
  /*
   * The monorepo root, so tracing follows workspace packages correctly.
   *
   * `fileURLToPath` is required rather than `URL.pathname`: on Windows the
   * latter yields "/C:/..." which Next cannot canonicalize.
   */
  outputFileTracingRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),

  transpilePackages: ['@apihub/contracts'],

  // Type-safe route strings for <Link href>.
  typedRoutes: true,

  /**
   * Security headers for the web app (report 20.3).
   *
   * The API sets its own; these cover the HTML surface. CSP is applied in
   * middleware instead, because it needs a per-request nonce.
   */
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=()',
          },
        ],
      },
    ];
  },
};

export default config;
