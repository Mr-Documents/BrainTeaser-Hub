# syntax=docker/dockerfile:1

# ============================================================================
# Brain Teaser Hub
#
# Multi-stage so the runtime image carries no build tooling, no dev
# dependencies and no source it does not need. Runs as a non-root user.
# ============================================================================

# ------------------------------------------------------------------ builder
# Compiles the stylesheet. Needs devDependencies (sass); the runtime does not.
FROM node:22-alpine AS builder

WORKDIR /app

# Copied first so a source-only change reuses the cached install layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY public/scss ./public/scss
RUN npx sass public/scss/main.scss public/css/main.css --style=compressed --no-source-map

# ------------------------------------------------------------------- deps
# Production dependencies only, resolved separately so they never mix with
# the build stage's devDependencies.
FROM node:22-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ----------------------------------------------------------------- runtime
FROM node:22-alpine AS runtime

# dumb-init reaps zombies and forwards signals, so SIGTERM actually reaches
# Node and the graceful shutdown path runs on every deploy.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production \
    PORT=3000 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules

COPY package.json ./
COPY src    ./src
COPY views  ./views
COPY public ./public
COPY data/puzzles.seed.json ./data/puzzles.seed.json
COPY supabase ./supabase
COPY scripts  ./scripts

# The compiled stylesheet comes only from the builder - public/css is excluded
# from the build context so a stale committed copy can never win.
COPY --from=builder /app/public/css ./public/css

# node:alpine ships an unprivileged `node` user; own the tree so the JSON
# driver can still write if someone runs without Supabase configured.
RUN chown -R node:node /app
USER node

EXPOSE 3000

# Liveness only - deliberately does not touch the database, so a storage blip
# cannot cause the orchestrator to kill an otherwise healthy container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
