# trade-bot

Broker-agnostic trading bot for Indian markets, built with [Bun](https://bun.com). Upstox is the
first broker. The plan and progress are in [docs/ROADMAP.md](docs/ROADMAP.md).

## Setup

```bash
bun install
cp .env.example .env     # add your Upstox API key and secret
bun run login            # once a day: opens the Upstox login page
```

## Run

```bash
bun run start            # paper trading (default): live prices, simulated fills, no real orders
bun run dashboard        # the dashboard on http://127.0.0.1:4000 (needs a build: see below)
bun run dashboard:dev    # while working on the page: bundles on the fly, hot reload
bun run all              # both in one terminal; Ctrl+C stops both, the bot squares off first
bun run scheduler        # every day: dashboard always on, bot only on trading days (08:55–15:35)
bun run report           # win rate, expectancy, drawdown, exit reasons, per-day P&L
```

## Build for production

```bash
bun run build            # everything into dist/: backend bundles (+ source maps) and the dashboard page
bun run start:prod       # the scheduler from dist/ (it runs the built bot and dashboard)
bun dist/index.js        # or any single program: dist/login.js, dist/dashboard/server.js, ...
bun run dashboard:build  # only the dashboard page (dist/web), e.g. after changing src/dashboard/web
```

The built backend is self-contained (no `node_modules` needed); the Docker image contains only `dist/`.
Running in production, the daily Upstox login on a server and the dashboard setup: see `docs/PRODUCTION.md`.
During development keep running from source (`bun run start`, `bun run dashboard:dev`).

## Notes

The bot runs the NIFTY iron butterfly until you press Ctrl+C; any open trade is squared off
before it exits. Orders, completed trades and strategy state are saved in `db/trade-bot.sqlite`.

The dashboard needs a one-time `bun run dashboard:setup` (password and PIN; it prints the
`DASHBOARD_*` lines for `.env`).

Live trading places **real orders** and needs two settings in `.env`:

```bash
TRADING_MODE=live
LIVE_TRADING_CONFIRM=yes
```

All settings are listed in `.env.example`.

## Other commands

```bash
bun run upstox profile   # read-only checks against your Upstox account (see src/brokers/upstox/cli.ts)
bun test
bun run typecheck
```

## Docker

```bash
docker build -f Docker/Dockerfile -t trade-bot .
docker run --rm --env-file .env -v trade-bot-db:/app/db trade-bot
```

The daily login happens outside the container for now (see step 28 in the roadmap).
