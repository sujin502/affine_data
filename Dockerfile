# syntax=docker/dockerfile:1.7

# ============================================================
# Stage 1: Build server native (Rust)
# ============================================================
FROM node:22-bookworm AS native-builder
WORKDIR /app

# Install Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Copy only what's needed for native build
COPY .yarn .yarn
COPY .yarnrc.yml package.json yarn.lock ./
COPY packages/backend/native ./packages/backend/native
COPY packages/backend/server/package.json ./packages/backend/server/

# Install dependencies
RUN corepack enable && corepack prepare yarn@4.13.0 --activate
RUN yarn install --immutable

# Build native
RUN yarn workspace @affine/server-native build

# ============================================================
# Stage 2: Build frontend (web, admin, mobile)
# ============================================================
FROM node:22-bookworm AS frontend-builder
WORKDIR /app

COPY .yarn .yarn
COPY .yarnrc.yml package.json yarn.lock ./
COPY packages/backend/server/package.json ./packages/backend/server/
COPY packages/frontend ./packages/frontend
COPY packages/common ./packages/common
COPY packages/affine ./packages/affine

RUN corepack enable && corepack prepare yarn@4.13.0 --activate
RUN yarn install --immutable

# Build web
RUN yarn affine @affine/web build
# Build admin
RUN yarn affine @affine/admin build
# Build mobile
RUN yarn affine @affine/mobile build

# ============================================================
# Stage 3: Build server (TypeScript)
# ============================================================
FROM node:22-bookworm AS server-builder
WORKDIR /app

# Copy native artifact from native-builder
COPY --from=native-builder /app/packages/backend/native/server-native.node ./packages/backend/native/server-native.node

COPY .yarn .yarn
COPY .yarnrc.yml package.json yarn.lock ./
COPY packages/backend/server ./packages/backend/server
COPY packages/backend/native/package.json ./packages/backend/native/
COPY packages/common ./packages/common
COPY packages/affine ./packages/affine

RUN corepack enable && corepack prepare yarn@4.13.0 --activate
RUN yarn install --immutable

# Build server
RUN yarn workspace @affine/server build

# Install production dependencies
RUN yarn workspaces focus @affine/server --production

# Generate Prisma client
RUN yarn workspace @affine/server prisma generate

# Move node_modules into server directory (as expected by Dockerfile)
RUN mv ./node_modules ./packages/backend/server

# ============================================================
# Stage 4: Runtime image
# ============================================================
FROM node:22-bookworm-slim
WORKDIR /app

# Copy server
COPY --from=server-builder /app/packages/backend/server /app

# Copy frontend dists
COPY --from=frontend-builder /app/packages/frontend/apps/web/dist /app/static
COPY --from=frontend-builder /app/packages/frontend/admin/dist /app/static/admin
COPY --from=frontend-builder /app/packages/frontend/apps/mobile/dist /app/static/mobile

# Install runtime dependencies
RUN apt-get update && \
  apt-get install -y --no-install-recommends openssl libjemalloc2 ca-certificates && \
  rm -rf /var/lib/apt/lists/*

ENV LD_PRELOAD=libjemalloc.so.2

EXPOSE 3010

CMD ["node", "./dist/main.js"]
