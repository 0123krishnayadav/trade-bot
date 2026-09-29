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
```

The bot runs the NIFTY iron butterfly until you press Ctrl+C; any open trade is squared off
before it exits. Orders, completed trades and strategy state are saved in `db/trade-bot.sqlite`.

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
