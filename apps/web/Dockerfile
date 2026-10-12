# Multi-stage Dockerfile for @restaurant-os/web
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@12.4.2 --activate
WORKDIR /app

# Stage 1: Build client bundle
FROM base AS builder
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json tsconfig.json ./
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web

RUN pnpm install --frozen-lockfile
RUN pnpm --filter=@restaurant-os/shared build
RUN pnpm --filter=@restaurant-os/web build

# Stage 2: Production Nginx Server
FROM nginx:1.31-alpine AS runner

# Copy custom hardened Nginx configuration
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

# Copy production static assets
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
