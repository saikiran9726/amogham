# Multi-stage Dockerfile for @restaurant-os/api
FROM node:25-alpine AS base
RUN corepack enable && corepack prepare pnpm@12.4.2 --activate
WORKDIR /app

# Stage 1: Build dependencies and compile code
FROM base AS builder
ARG GIT_SHA
ENV GIT_SHA=$GIT_SHA
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json tsconfig.json ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

RUN pnpm install --frozen-lockfile
RUN pnpm --filter=@restaurant-os/shared build
RUN pnpm --filter=@restaurant-os/api build

# Stage 2: Deploy production-only bundle (no devDependencies shipped)
RUN pnpm --filter=@restaurant-os/api --prod deploy /app/deployed

# Ensure migrations and built artifacts are copied to the deployed directory
RUN cp -r /app/apps/api/dist /app/deployed/dist && \
    mkdir -p /app/deployed/dist/db/migrations && \
    cp -r /app/apps/api/src/db/migrations/* /app/deployed/dist/db/migrations/

# Stage 3: Production runner
FROM node:25-alpine AS runner
ARG GIT_SHA
ENV GIT_SHA=$GIT_SHA
ENV NODE_ENV=production
ENV UV_THREADPOOL_SIZE=8
WORKDIR /app

# Create and switch to non-root user
USER node

# Copy deployed production bundle
COPY --from=builder --chown=node:node /app/deployed ./

EXPOSE 4000

# Healthcheck against liveness endpoint
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/healthz || exit 1

# Default CMD runs the API server; separate migrate service uses ["node", "dist/db/migrate.js", "up"]
CMD ["node", "dist/index.js"]
