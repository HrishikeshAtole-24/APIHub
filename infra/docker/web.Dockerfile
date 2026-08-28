# APIHub web image.
#
# Uses Next.js standalone output: the build traces exactly which files the
# server needs and emits a self-contained bundle, so the runtime layer does not
# ship node_modules.

# ── Stage 1: install ─────────────────────────────────────────
FROM node:24-alpine AS deps

RUN corepack enable && corepack prepare pnpm@11.22.0 --activate
WORKDIR /repo

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

# Next.js inlines NEXT_PUBLIC_* values at build time, so the API URL must be
# known here rather than at container start.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1

COPY . .
RUN pnpm --filter @apihub/web build

# ── Stage 3: runtime ─────────────────────────────────────────
FROM node:24-alpine AS runtime

RUN apk add --no-cache dumb-init && \
    addgroup -g 1001 -S apihub && \
    adduser -u 1001 -S apihub -G apihub

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Standalone output includes a minimal server plus only the traced dependencies.
COPY --from=build --chown=apihub:apihub /repo/apps/web/.next/standalone ./
COPY --from=build --chown=apihub:apihub /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=apihub:apihub /repo/apps/web/public ./apps/web/public

USER apihub
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/web/server.js"]
