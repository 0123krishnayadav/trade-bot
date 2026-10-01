# syntax=docker/dockerfile:1
# Build from the project root:  docker build -f Docker/Dockerfile -t trade-bot .
# Or with compose:              docker compose -f Docker/compose.yml up -d

ARG BUN_VERSION=1.4.2

# ---- deps: production dependencies only ----
FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- runtime: runs from source (Bun runs TypeScript directly and bundles the dashboard's page at startup) ----
FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production APP_ENV=production
COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json tsconfig.json ./
COPY --chown=bun:bun src ./src
# SQLite and the daily log files live here; mount volumes to keep them between container runs
RUN mkdir -p /app/db /app/logs && chown bun:bun /app/db /app/logs
VOLUME ["/app/db", "/app/logs"]
USER bun
# The scheduler keeps the dashboard up and runs the bot on trading days.
CMD ["bun", "run", "src/scheduler/index.ts"]
