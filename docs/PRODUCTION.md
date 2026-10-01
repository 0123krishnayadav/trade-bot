# Production: build, run and log in

How to run trade-bot for real use: build once, run the built files, and do the two logins (the daily Upstox login and the one-time dashboard setup). For reading the code, see `docs/CODE_GUIDE.md`. For what's still planned, see `docs/ROADMAP.md`.

---

## 1. Build

```sh
bun run build        # everything into dist/ (takes about 0.1 s)
```

What it produces:
```
dist/
  index.js  login.js  run-all.js           the bot and small programs (+ .map source maps)
  scheduler/index.js  dashboard/server.js  dashboard/setup.js  reports/cli.js  calendar/cli.js
  chunks/                                  code shared between programs, stored once
  web/                                     the dashboard page (hashed assets + .br/.gz copies)
```

- **Self-contained backend:** no `node_modules` is needed at runtime. The only imports left are `bun:sqlite`, `crypto`, `fs` and `path`.
- **Source maps:** stack traces in the logs point at the original `.ts` lines.
- **Rebuild after every code change:** `bun run build` again. To rebuild only the dashboard page, use `bun run dashboard:build` (writes `dist/web`).
- **Development is unchanged:** run from source with `bun run start`, `bun run all` and `bun run dashboard:dev` (hot reload). Only production uses `dist/`.

---

## 2. Run

```sh
bun run start:prod   # the scheduler from dist/; it runs the built bot and dashboard
```

The scheduler is the one long-running process:
- **The dashboard** runs all the time on `http://127.0.0.1:4000`.
- **The bot** runs on **trading days only**, from the market calendar (holidays and special sessions come from Upstox):
  - **08:30:** if you're not logged in to Upstox, you get an alert
  - **08:55:** the bot starts (once you're logged in)
  - **15:35:** the bot stops, squaring off anything still open
- **Crashes:** a crashed bot is restarted, at most 3 times a day, with an alert each time.
- **Holidays:** one "market closed" alert, and the bot stays off.
- **Log files** older than `LOG_RETENTION_DAYS` (default 30) are deleted.

**Ctrl+C** stops everything. Press it **once** and wait: the bot squares off first, and a second Ctrl+C would stop it before it finishes.

Single programs can also be run from `dist/`:
```sh
bun dist/index.js               # the bot only
bun dist/dashboard/server.js    # the dashboard only
bun dist/reports/cli.js         # trade report
bun dist/calendar/cli.js        # download the holiday list now
```

### With Docker (a VPS)

```sh
docker compose -f Docker/compose.yml up -d --build
```
- **The image** builds `dist/` during `docker build` and contains only `dist/`.
- **Its main process** is the scheduler.
- **Data:** `db/` and `logs/` are volumes, so they survive restarts and rebuilds.
- **`network_mode: host` (Linux):** the dashboard (4000) and the login callback (5000) listen on the server's `127.0.0.1` only. They're reachable through an SSH tunnel, never from the internet.
- **Stopping:** `stop_grace_period: 90s` gives the bot time to square off.

---

## 3. Daily Upstox login (every trading morning)

Upstox tokens expire at **03:30 IST**, so you log in once each trading day. The bot can't do this for you: Upstox requires a login through their page, and storing your Upstox password and 2FA to automate it would be unsafe.
- **Reminder:** with the scheduler running, you get an alert at **08:30** if you haven't logged in yet (on Telegram, if it's set up).
- **After you log in:** the bot starts by itself.
- **Token pickup:** the bot reads the token on every call, so a new login takes effect straight away with no restart.

### If production runs on your Mac

```sh
bun dist/login.js            # same as `bun run login`
```
1. It opens the Upstox login page in your browser.
2. After you log in, Upstox redirects to `http://127.0.0.1:5000/callback` on your Mac.
3. The token is saved in `db/trade-bot.sqlite`. Done.

### If it runs on a VPS (Docker)

The catch is that the Upstox redirect goes to `127.0.0.1:5000` in **your laptop's** browser, while the program waiting for it runs on **the server**. An SSH tunnel connects the two.

```sh
# 1. On your laptop: open a tunnel (keep this terminal open)
ssh -L 5000:127.0.0.1:5000 -L 4000:127.0.0.1:4000 you@your-vps

# 2. In that SSH session: start the login inside the container
docker compose -f Docker/compose.yml exec trade-bot bun dist/login.js
#    → it prints a long Upstox link (the server has no browser to open)

# 3. Open that link in your laptop's browser and log in to Upstox
#    → Upstox redirects to 127.0.0.1:5000 → the tunnel → the server → token saved
```

- **Where the token goes:** the `db` volume, so it survives container restarts.
- **The same tunnel gives you the dashboard:** open `http://127.0.0.1:4000` on your laptop.
- **The redirect URL** in your Upstox developer app (https://account.upstox.com/developer/apps) must stay **exactly** `http://127.0.0.1:5000/callback`, the same as `UPSTOX_REDIRECT_URI` in `.env`.

### Checking the login
- **The dashboard's Upstox card** shows "connected" and "Token valid until … 03:30 IST".
- **The log** says `logged in` with `validUntil`.
- **If you're already logged in,** `bun dist/login.js` just says so. Use `bun dist/login.js --force` to log in again anyway.

---

## 4. Dashboard login (one-time setup)

The dashboard is protected by a strong password (keep it in your password manager) and a 6-digit PIN (you remember it).

### Generate the hashes

```sh
bun dist/dashboard/setup.js     # Mac (same as `bun run dashboard:setup`)
docker compose -f Docker/compose.yml exec -it trade-bot bun dist/dashboard/setup.js   # VPS
```
1. Paste your password, then type your PIN. Each is asked twice, and nothing shows on screen.
2. It prints three lines. Add them to the `.env` that production uses. On the VPS that's the project's `.env`, which compose loads.
   ```
   DASHBOARD_PASSWORD_HASH=...
   DASHBOARD_PIN_HASH=...
   DASHBOARD_SESSION_SECRET=...
   ```
3. Restart: `docker compose -f Docker/compose.yml restart`, or restart `bun run start:prod` on the Mac.

Only **hashes** are stored, never the password or PIN themselves. You can copy the same three lines from your Mac's `.env` to the server.

### How the dashboard login works
- **Two secrets:** both the password **and** the PIN are needed. A wrong one of either gives the same "invalid credentials" message.
- **Lockout:** after **5 failed attempts**, login is locked for **15 minutes**.
- **Session:** an HttpOnly cookie that lasts **24 hours** (`DASHBOARD_SESSION_HOURS`). **Log out** ends it on the server too.
- **Logging out everywhere:** change `DASHBOARD_SESSION_SECRET` and restart.
- **Not public:** the dashboard listens on `127.0.0.1` only. Open it on the same machine, or through the SSH tunnel above. Don't expose it to the internet; if you ever must, put it behind HTTPS and set `DASHBOARD_SECURE_COOKIE=true`.

---

## 5. A production morning (VPS)

1. **08:30:** alert: "Log in to the broker for today".
2. **On your laptop:**
   - open the tunnel: `ssh -L 5000:127.0.0.1:5000 -L 4000:127.0.0.1:4000 you@your-vps`
   - start the login: `docker compose -f Docker/compose.yml exec trade-bot bun dist/login.js`
   - open the printed link, log in to Upstox, and the token is saved
3. **08:55:** the scheduler starts the bot by itself.
4. **During the day:** watch `http://127.0.0.1:4000` (through the tunnel). Alerts arrive for entry, exit, errors and the kill switch.
5. **15:35:** the bot stops after squaring off. The day's summary alert arrives.

On a holiday you get one "market closed" alert, and there's nothing to do.

---

## 6. Settings checklist (`.env`)

All settings, with explanations, are in `.env.example`. For production, check these:

- **Upstox:** `UPSTOX_API_KEY`, `UPSTOX_API_SECRET`, `UPSTOX_REDIRECT_URI=http://127.0.0.1:5000/callback`
- **Mode:** `TRADING_MODE=paper`. For real orders: `TRADING_MODE=live` **and** `LIVE_TRADING_CONFIRM=yes`.
- **Capital and risk:** `CAPITAL`, plus optionally `RISK_MAX_DAILY_LOSS` (default 2% of capital), `RISK_MAX_LOTS_PER_ORDER`, `RISK_MAX_OPEN_POSITIONS`
- **Dashboard:** `DASHBOARD_PASSWORD_HASH`, `DASHBOARD_PIN_HASH`, `DASHBOARD_SESSION_SECRET` (from setup)
- **Alerts (optional):** `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`
- **Logs:** `LOG_RETENTION_DAYS` (default 30)

Never commit `.env`, and never paste secrets into chats or tickets.

---

## 7. Before going live with real money

- Run in **paper mode for 2–4 weeks**, and check `bun dist/reports/cli.js` and the History page: win rate, expectancy after costs, max drawdown.
- Do the one small **real-order test** (roadmap step 12) while watching it.
- Check **SEBI's retail algo rules** and **Upstox's current API requirements**, e.g. static IP registration for API orders from a VPS.
- Start with **1 lot**, with every risk limit on, and watch closely. Only scale up when live results match the paper results.
