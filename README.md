# trade-bot

Broker-agnostic trading bot for Indian markets, built with [Bun](https://bun.com). Upstox is the first broker; the first strategy is an intraday NIFTY iron butterfly. It runs in **paper mode by default** (live prices, simulated fills, no real orders).

- **How the code works and where to start reading:** [docs/CODE_GUIDE.md](docs/CODE_GUIDE.md)
- **Running it for real** (build, scheduler, the daily login on a server, dashboard setup): [docs/PRODUCTION.md](docs/PRODUCTION.md)
- **What's done and what's next:** [docs/ROADMAP.md](docs/ROADMAP.md)

## Requirements

- **Bun 1.4 or newer** (`bun --version`).
- **Your own Upstox developer app** (https://account.upstox.com/developer/apps), with the redirect URL set to exactly `http://127.0.0.1:5000/callback`. Each person uses their own API key and their own `.env`.
- Optional: **Docker**, for running on a server.

## Setup

```bash
bun install
cp .env.example .env         # add UPSTOX_API_KEY and UPSTOX_API_SECRET (never commit .env)
bun run login                # opens the Upstox login page; needed once every trading day
bun run dashboard:setup      # one time: dashboard password + PIN → paste the printed lines into .env
bun run dashboard:build      # bundle the dashboard page (again after changing src/dashboard/web)
```

## Run (development, from source)

```bash
bun run start                # the bot: paper trading by default
bun run dashboard            # the dashboard on http://127.0.0.1:4000
bun run dashboard:dev        # the dashboard with hot reload, while working on the page
bun run all                  # bot + dashboard in one terminal; Ctrl+C stops both (the bot squares off first)
bun run scheduler            # dashboard always on, bot only on trading days (08:55–15:35 IST)
```

Press Ctrl+C **once** and wait: the bot squares off open positions before it exits.

## Useful commands

```bash
bun run report               # win rate, expectancy, max drawdown, exit reasons, per-day P&L
bun run holidays             # download the market holiday list now and show what's coming up
bun run upstox profile       # read-only checks against your Upstox account (see src/brokers/upstox/cli.ts)
bun test                     # all tests
bun run typecheck
```

## Production

```bash
bun run build                # everything into dist/ (self-contained backend + the dashboard page)
bun run start:prod           # the scheduler from dist/
docker compose -f Docker/compose.yml up -d --build    # or on a Linux server, with Docker
```

See [docs/PRODUCTION.md](docs/PRODUCTION.md), especially for **the daily Upstox login on a server** (it goes through an SSH tunnel).

## Safety

- **Paper is the default.** Real orders need **both** of these in `.env`:
  ```bash
  TRADING_MODE=live
  LIVE_TRADING_CONFIRM=yes
  ```
- **Risk limits on every order:** maximum lots per order, maximum open positions, and a daily loss limit that turns the **kill switch** on (square off everything, no new trades today). The dashboard has a kill switch button too.
- **Secrets stay local:** keep `.env` to yourself. Never commit it or paste it anywhere: it holds your API secret and dashboard hashes. `db/` holds your Upstox access token and is git-ignored, so don't share it either.

All settings are listed, with explanations, in `.env.example`.
