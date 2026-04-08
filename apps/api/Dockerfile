# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Copy ALL source first — must happen before pnpm install
# so that node_modules symlinks created by pnpm are not shadowed by COPY layers
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/api/ ./apps/api/
COPY apps/mcp-server/package.json ./apps/mcp-server/
COPY apps/worker/package.json ./apps/worker/

# Install all dependencies — pnpm creates node_modules symlinks into source dirs
# Note: no cache mount — BuildKit cache mounts can unmount between layers,
# breaking pnpm's hardlink references from node_modules/.pnpm to the store
RUN pnpm install --no-frozen-lockfile

# Generate Prisma client (now works: packages/db/node_modules/prisma exists)
RUN pnpm --filter @toolpilot/db run db:generate

# Build all packages in dependency order
# Build order follows dependency graph: config/core → db/vector/graph/queue → search → tools → api
RUN pnpm --filter @toolpilot/config build && \
    pnpm --filter @toolpilot/core build && \
    pnpm --filter @toolpilot/db build && \
    pnpm --filter @toolpilot/vector build && \
    pnpm --filter @toolpilot/graph build && \
    pnpm --filter @toolpilot/queue build && \
    pnpm --filter @toolpilot/search build && \
    pnpm --filter @toolpilot/tools build && \
    pnpm --filter @toolpilot/api build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Copy workspace config + package manifests (ALL packages needed for pnpm workspace resolution)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/tsconfig ./packages/tsconfig/
COPY packages/config/package.json ./packages/config/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/graph/package.json ./packages/graph/
COPY packages/queue/package.json ./packages/queue/
COPY packages/search/package.json ./packages/search/
COPY packages/vector/package.json ./packages/vector/
COPY packages/tools/package.json ./packages/tools/
COPY packages/remote/package.json ./packages/remote/
COPY apps/api/package.json ./apps/api/
COPY apps/mcp-server/package.json ./apps/mcp-server/
COPY apps/worker/package.json ./apps/worker/

# Install production deps only
RUN pnpm install --no-frozen-lockfile --prod

# Copy Prisma schema and generated client from builder
COPY packages/db/prisma ./packages/db/prisma/
COPY --from=builder /app/node_modules/.pnpm ./node_modules/.pnpm

# Copy compiled dist from builder
COPY --from=builder /app/packages/config/dist ./packages/config/dist
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/graph/dist ./packages/graph/dist
COPY --from=builder /app/packages/queue/dist ./packages/queue/dist
COPY --from=builder /app/packages/search/dist ./packages/search/dist
COPY --from=builder /app/packages/vector/dist ./packages/vector/dist
COPY --from=builder /app/packages/tools/dist ./packages/tools/dist
COPY --from=builder /app/apps/api/dist ./apps/api/dist

EXPOSE 3001

ENV NODE_ENV=production

CMD ["node", "apps/api/dist/index.js"]
