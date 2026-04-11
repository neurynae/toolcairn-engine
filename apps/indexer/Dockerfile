# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Copy all source first (before pnpm install — prevents overlay FS wiping symlinks)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/indexer/ ./apps/indexer/
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/

# Install all dependencies
RUN pnpm install --no-frozen-lockfile

# Generate Prisma client
RUN pnpm --filter @toolcairn/db run db:generate

# Build all packages in dependency order
RUN pnpm --filter @toolcairn/config build && \
    pnpm --filter @toolcairn/core build && \
    pnpm --filter @toolcairn/db build && \
    pnpm --filter @toolcairn/vector build && \
    pnpm --filter @toolcairn/graph build && \
    pnpm --filter @toolcairn/queue build && \
    pnpm --filter @toolcairn/search build && \
    pnpm --filter @toolcairn/indexer build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/tsconfig ./packages/tsconfig/
COPY packages/config/package.json ./packages/config/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/errors/package.json ./packages/errors/
COPY packages/graph/package.json ./packages/graph/
COPY packages/queue/package.json ./packages/queue/
COPY packages/search/package.json ./packages/search/
COPY packages/vector/package.json ./packages/vector/
COPY packages/tools/package.json ./packages/tools/
COPY apps/indexer/package.json ./apps/indexer/
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/

RUN pnpm install --no-frozen-lockfile --prod

COPY packages/db/prisma ./packages/db/prisma/
COPY --from=builder /app/node_modules/.pnpm ./node_modules/.pnpm
COPY --from=builder /app/packages/config/dist ./packages/config/dist
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/errors/dist ./packages/errors/dist
COPY --from=builder /app/packages/graph/dist ./packages/graph/dist
COPY --from=builder /app/packages/queue/dist ./packages/queue/dist
COPY --from=builder /app/packages/search/dist ./packages/search/dist
COPY --from=builder /app/packages/vector/dist ./packages/vector/dist
COPY --from=builder /app/apps/indexer/dist ./apps/indexer/dist
COPY --from=builder /app/apps/indexer/src/seed ./apps/indexer/src/seed

ENV NODE_ENV=production

CMD ["node", "apps/indexer/dist/index.js"]
