# syntax=docker/dockerfile:1
# Build from the project root:  docker build -f Docker/Dockerfile -t trade-bot .
# Or with compose:              docker compose -f Docker/compose.yml up -d

ARG BUN_VERSION=1.4.2

# ---- build: install everything, then `bun run build` -> dist/ (backend bundles + the dashboard page) ----
FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN bun run build

# ---- runtime: only dist/ (the bundles are self-contained: no src/, no node_modules) ----
FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production APP_ENV=production
COPY --from=build --chown=bun:bun /app/dist ./dist
# SQLite and the daily log files live here; mount volumes to keep them between container runs
RUN mkdir -p /app/db /app/logs && chown bun:bun /app/db /app/logs
VOLUME ["/app/db", "/app/logs"]
USER bun
# The scheduler keeps the dashboard up and runs the bot on trading days.
CMD ["bun", "dist/scheduler/index.js"]
