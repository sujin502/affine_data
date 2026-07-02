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

# Build server
RUN yarn workspace @affine/server build

# Verify build output exists
RUN echo "=== Checking dist ===" && ls -la packages/backend/server/dist/ && echo "=== main.js size ===" && wc -c packages/backend/server/dist/main.js

# Generate Prisma client
RUN yarn workspace @affine/server prisma generate

# ============================================================
# Stage 2: Runtime
# ============================================================
FROM node:22-bookworm-slim
WORKDIR /app

# Copy server dist
COPY --from=builder /app/packages/backend/server/dist /app/dist

# Copy production node_modules
COPY --from=builder /app/node_modules /app/node_modules

# Copy server package.json
COPY --from=builder /app/packages/backend/server/package.json /app/package.json

# Copy native module
COPY --from=builder /app/packages/backend/native/server-native.node /app/server-native.node

# Create empty static directories (use official image for frontend, or mount separately)
RUN mkdir -p /app/static/admin /app/static/mobile

# Install runtime dependencies
RUN apt-get update && \
  apt-get install -y --no-install-recommends openssl libjemalloc2 ca-certificates && \
  rm -rf /var/lib/apt/lists/*

ENV LD_PRELOAD=libjemalloc.so.2

EXPOSE 3010

CMD ["node", "./dist/main.js"]
