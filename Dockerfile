# syntax=docker/dockerfile:1.7

# ============================================================
# Stage 1: Build server native (Rust) + server (TypeScript)
# ============================================================
FROM node:22-bookworm AS builder
WORKDIR /app

# Install Rust for native module
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Copy everything (needed for monorepo workspace resolution)
COPY . .

# Install all dependencies
RUN corepack enable && corepack prepare yarn@4.13.0 --activate
RUN yarn install --immutable

# Build native
RUN yarn workspace @affine/server-native build

# The server-native package conditionally requires architecture-specific files.
# Rspack statically checks these require() calls, so create aliases for the current x64 build.
RUN cp packages/backend/native/server-native.node packages/backend/native/server-native.x64.node && \
  cp packages/backend/native/server-native.node packages/backend/native/server-native.arm64.node && \
  cp packages/backend/native/server-native.node packages/backend/native/server-native.armv7.node

# Build server with rspack (bypass CLI spawnSync bug, use tsx directly)
RUN npx tsx tools/cli/src/affine.ts bundle -p @affine/server

# Verify build output exists
RUN echo "=== Checking dist ===" && ls packages/backend/server/dist/main.js && echo "=== OK ==="

# Install production dependencies only
RUN yarn workspaces focus @affine/server --production

# Generate Prisma client
RUN yarn workspace @affine/server prisma generate

# ============================================================
# Stage 2: Runtime
# ============================================================
# Use official image for frontend static files
FROM ghcr.io/toeverything/affine:stable AS frontend

FROM node:22-bookworm-slim
WORKDIR /app

# Copy server dist
COPY --from=builder /app/packages/backend/server/dist /app/dist

# Copy production node_modules
COPY --from=builder /app/node_modules /app/node_modules

# Copy server package.json
COPY --from=builder /app/packages/backend/server/package.json /app/package.json

# Copy scripts (self-host-predeploy.js etc.)
COPY --from=builder /app/packages/backend/server/scripts /app/scripts

# Copy prisma schema and migrations (needed by migration script)
COPY --from=builder /app/packages/backend/server/schema.prisma /app/schema.prisma
COPY --from=builder /app/packages/backend/server/migrations /app/migrations

# Copy native modules
COPY --from=builder /app/packages/backend/native/server-native.node /app/server-native.node
COPY --from=builder /app/packages/backend/native/server-native.x64.node /app/server-native.x64.node
COPY --from=builder /app/packages/backend/native/server-native.arm64.node /app/server-native.arm64.node
COPY --from=builder /app/packages/backend/native/server-native.armv7.node /app/server-native.armv7.node

# Copy frontend static files from official image
COPY --from=frontend /app/static /app/static

# Override admin static files with this repository's customized admin build.
COPY ./packages/frontend/admin/dist /app/static/admin

# Install runtime dependencies
RUN apt-get update && \
  apt-get install -y --no-install-recommends openssl libjemalloc2 ca-certificates && \
  rm -rf /var/lib/apt/lists/*

ENV LD_PRELOAD=libjemalloc.so.2

EXPOSE 3010

CMD ["node", "./dist/main.js"]
