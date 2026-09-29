# syntax=docker/dockerfile:1
# Build from the project root:  docker build -f Docker/Dockerfile -t trade-bot .

ARG BUN_VERSION=1.4.2

# ---- build: install dependencies and bundle the app into dist/ ----
FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN bun run build

FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production APP_ENV=production
COPY --from=build --chown=bun:bun /app/dist ./dist
# SQLite lives here; mount a volume on it to keep data between container runs
RUN mkdir -p /app/db && chown bun:bun /app/db
VOLUME /app/db
USER bun
CMD ["bun", "run", "dist/index.js"]
