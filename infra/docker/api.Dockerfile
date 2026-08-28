# APIHub API image.
#
# Multi-stage so the runtime layer contains only production dependencies and
# the bundled output. tsup bundles the internal @apihub/* packages into the
# artifact, so the final image does not need the monorepo layout.

# ── Stage 1: install ─────────────────────────────────────────
FROM node:24-alpine AS deps

RUN corepack enable && corepack prepare pnpm@11.22.0 --activate
WORKDIR /repo

# Copy only the manifests first. Docker caches this layer, so a source-only
# change does not re-run the install.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/web/package.json ./apps/web/
COPY packages/algorithms/package.json ./packages/algorithms/
COPY packages/config/package.json ./packages/config/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/database/package.json ./packages/database/
COPY packages/domain/package.json ./packages/domain/
COPY packages/jobs/package.json ./packages/jobs/
COPY packages/logger/package.json ./packages/logger/
COPY packages/runtime/package.json ./packages/runtime/
COPY packages/security/package.json ./packages/security/

RUN pnpm install --frozen-lockfile

# ── Stage 2: build ───────────────────────────────────────────
FROM deps AS build

COPY . .
RUN pnpm --filter @apihub/api build

# ── Stage 3: runtime ─────────────────────────────────────────
FROM node:24-alpine AS runtime

# dumb-init gives PID 1 correct signal forwarding, so SIGTERM reaches Node and
# the graceful shutdown path actually runs.
RUN apk add --no-cache dumb-init && \
    addgroup -g 1001 -S apihub && \
    adduser -u 1001 -S apihub -G apihub

WORKDIR /app
ENV NODE_ENV=production

# Bundled output plus the migrations the runner applies at startup.
COPY --from=build --chown=apihub:apihub /repo/apps/api/dist ./dist
COPY --from=build --chown=apihub:apihub /repo/packages/database/migrations ./migrations

# Only the dependencies tsup left external.
COPY --from=build --chown=apihub:apihub /repo/node_modules/.pnpm ./node_modules/.pnpm
COPY --from=build --chown=apihub:apihub /repo/apps/api/node_modules ./node_modules

USER apihub
EXPOSE 4000

# Readiness, not liveness: reports unhealthy when the database is unreachable,
# so an orchestrator stops routing to an instance that cannot serve.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
