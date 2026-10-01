# Code Guide: how to read and understand trade-bot

This guide takes you through the code in a sensible order: the big picture first, then one layer at a time, then a full trading day traced through the code. It covers **what** each part does and **why** it is built that way.

For what is planned next, see `docs/ROADMAP.md`. For setup and commands, see `README.md`.

---

## 1. The big picture in one minute

Three programs work together. They share one SQLite file and nothing else.

1. **The bot** (`bun run start`, `src/index.ts`)
   - Logs in once a day with the saved Upstox token.
   - Listens to live prices.
   - Runs strategies (the NIFTY iron butterfly) and places orders, real or paper.
   - Every order passes through the **risk manager**.
2. **The dashboard** (`bun run dashboard`, `src/dashboard/`)
   - A React page behind a password and PIN.
   - Shows positions, live P&L, history and reports.
   - Has a kill switch button.
   - It reads the database. Its only write is the kill switch row.
3. **The scheduler** (`bun run scheduler`, `src/scheduler/`)
   - The one long-running process. Keeps the dashboard up.
   - Starts the bot before the open and stops it after the close, on trading days only (from the market calendar).
   - Sends alerts: login needed, crashes, holidays.

The most important idea: **strategies never talk to Upstox directly.** They talk to generic interfaces (`Broker`, `MarketData`). Upstox is one *adapter* that plugs into those interfaces, and the paper broker is another. Adding Zerodha later means writing a new adapter. Strategies don't change.

```
                         ┌─────────────────────────────┐
                         │ scheduler (trading days)    │──starts/stops──┐
                         └─────────────────────────────┘                │
                                                                        ▼
 ┌──────────────┐  tick   ┌─────────────────┐  order  ┌──────────────┐  ┌──────────────────┐
 │ MarketEngine │───────▶ │ StrategyEngine  │───────▶ │ RiskManager  │─▶│ Broker           │
 │ prices,      │         │ runs strategies │◀─fill───│ limits, P&L  │◀─│ (Paper or Upstox)│
 │ candles      │◀──sub───│ one at a time   │         └──────┬───────┘  └──────────────────┘
 └──────┬───────┘         └────────┬────────┘                │ daily loss → kill switch row
        │ ScripRecorder            │ orders, trades, state   │
        ▼                          ▼                         ▼
 ┌──────────────────────────────── SQLite (db/trade-bot.sqlite) ───────────────────────────┐
 │ scrips · orders · strategy_trades · strategy_state · kill_switch · market_holidays · …  │
 └─────────────────────────────────────────────────────────────────────────────────────────┘
        ▲ reads everything; writes only kill_switch
 ┌──────┴───────┐
 │  dashboard   │  React + Mantine, /api layer, password + PIN
 └──────────────┘
```

**Why the processes share only the database:**
- You can restart the dashboard while the bot is trading.
- The dashboard needs no broker connection.
- A crash in one doesn't take down the other.

---

## 2. Folder map

```
src/
  index.ts                 THE BOT: composition root (builds and connects everything)
  login.ts                 `bun run login`: daily broker login
  run-all.ts               `bun run all`: bot + dashboard in one terminal
  scheduler/               `bun run scheduler`: runs the bot on trading days
    plan.ts                  when to check login / start / stop for a day (pure functions)
    scheduler.ts             the decisions, tick() every 30 s (testable, no I/O of its own)
    index.ts                 wiring: config, DB, child processes, signals

  core/types.ts            The contracts: Instrument, Tick, Candle, Order, Broker, MarketData, MarketHoliday…
  config/                  Reads .env into one typed Config object (env.ts = parsing helpers)

  engine/
    market-engine.ts       Market data hub: shared subscriptions, latest ticks, candles
    candle-series.ts       Builds 1m/5m/… candles from ticks, aligned to 09:15
    scrip-recorder.ts      Saves the latest price of every subscribed instrument to `scrips`
    strategy.ts            The Strategy interface and StrategyContext (what a strategy may use)
    strategy-engine.ts     Runs strategies: event queue, order routing, kill switch check

  strategies/
    iron-butterfly/        The strategy itself (a state machine)

  risk/risk-manager.ts     Wraps the broker: per-order limits, daily loss → kill switch
  calendar/                MarketCalendar: trading days and special sessions
  alerts/notifier.ts       Telegram alerts (or just the log)
  reports/                 Win rate, expectancy, drawdown… (`bun run report` + dashboard)
  process/child.ts         Starts a script as a child process with prefixed output

  brokers/
    index.ts               Factory: picks the adapter from config.broker
    charges.ts             Brokerage, STT, GST… per order
    order-checks.ts        Validates orders (lot size, tick size) before sending
    paper/paper-broker.ts  Fake broker: fills at live bid/ask, no real money
    upstox/                Everything Upstox-specific (see step 10 below)

  store/                   SQLite: database + migrations + one "store" class per area
  utils/                   logger (console + daily log file, pruning), time (IST helpers, dayjs)

  dashboard/               The web dashboard (separate process)
    server.ts                Bun.serve: /api routes + the React page
    config.ts, setup.ts      settings; `bun run dashboard:setup` (password + PIN hashes)
    auth/                    password/PIN check, signed session cookie, login lockout
    api/                     router.ts (routes, auth guard) and types.ts (shared with the page)
    services/                read-only queries: status, positions, history; kill-switch write
    web/                     React app: main.tsx, App.tsx (routes), api-client.ts, pages/, components/

tests/                     One test file per module; read these as examples
docs/                      ROADMAP.md, this guide
Docker/                    Dockerfile + compose.yml (runs the scheduler)
```

Empty folders with `.gitkeep` (`backtest/`, `data/`) are placeholders for roadmap steps that haven't been built yet.

---

## 3. Design patterns used (and where)

You'll see these patterns throughout the code. Once you recognise them, most files become predictable.

**Ports and adapters (hexagonal architecture)**
- *Ports* are the interfaces in `src/core/types.ts`: `Broker`, `MarketData`, `BrokerLogin`, `InstrumentLookup`.
- *Adapters* implement them: `UpstoxBroker`, `UpstoxMarketData`, `PaperBroker`, `InstrumentStore`.
- Why: the engine and strategies depend only on the interfaces, so brokers are swappable.

**Factory**: `src/brokers/index.ts`
- `createBrokerAdapters`, `createBrokerLogin`, `downloadInstruments` and `downloadHolidays` all switch on the broker name.
- This is the only place outside `brokers/upstox/` that knows the word "upstox".

**Decorator**: `src/risk/risk-manager.ts`
- `RiskManager` *is* a `Broker` and *wraps* a `Broker`. It checks `placeOrder` and passes everything else through.
- The engine can't tell the difference, and the paper and real brokers need no risk code.

**Dependency injection and the composition root**: `src/index.ts`
- Classes receive what they need through their constructor (`new MarketEngine(marketData, …)`). They don't create their own dependencies.
- `index.ts` is the one place where the bot's objects are created and connected. `dashboard/server.ts` and `scheduler/index.ts` play the same role for their processes.
- Why: tests can pass fakes (e.g. `FakeMarketData`, `FakeBot`, a fake `Notifier`).

**Observer (callbacks)**
- `onTick`, `onAnyTick`, `onCandleClose`, `onOrderUpdate`, `onPositionUpdate`, `onConnectionChange`.
- Data is *pushed* to whoever registered. There is **no polling of the broker** anywhere.
- The only timers check local state: the engine's 1-second clock (strategies, kill switch row), the risk check every second, and the scheduler's tick every 30 seconds.

**Strategy pattern**: `src/engine/strategy.ts`
- Every strategy implements the same `Strategy` interface (`start`, `onTick`, `onClock`, `onOrderUpdate`, `squareOff`, `stop`), so the engine can run any of them.

**State machine**: `src/strategies/iron-butterfly/index.ts`
- `idle → entering → open → exiting → done`. The phase is saved to SQLite after every change, so a restart can resume.

**Repository**: `src/store/*-store.ts`
- Each store class hides the SQL for one area: sessions, instruments, trading (orders, trades, state, kill switch), scrips, calendar.
- Dashboard services may run small read-only queries of their own.

**Mapper**: `src/brokers/upstox/mappers.ts` (and `calendar.ts`)
- Converts Upstox's JSON shapes into the generic types in `core/types.ts` and back. Upstox field names never leak out of `brokers/upstox/`.

**Serial event queue**: `StrategyRunner` in `strategy-engine.ts`
- Each strategy's events are handled one at a time, so a strategy never needs locks.
- If ticks arrive faster than the strategy can handle them, only the latest tick is delivered (*tick coalescing*).
- The kill switch's `squareOff()` goes through the same queue, so it can't run in the middle of an entry.

**Pure core, thin shell**: `scheduler/plan.ts`, `reports/report.ts`
- The decisions ("what phase is it?", "what's the drawdown?") are plain functions with no I/O. They're easy to test.
- A thin file around them does the I/O (`scheduler/index.ts`, `reports/cli.ts`, the dashboard's history service).

---

## 4. Suggested reading order

Read in this order. Each step builds on the previous one. The time estimates assume careful reading.

### Step 1: The contracts, `src/core/types.ts` (30 min)
Read it top to bottom. It is the vocabulary of the whole project.
- `Instrument`: what a tradable thing is (key, symbol, lot size, tick size, strike, expiry).
- `Tick` and `Candle`: price data.
- `MarketHoliday`: a closed day or a special session.
- `OrderRequest`, `Order`, `OrderStatus`, `Position`: trading data.
- The `MarketData` and `Broker` interfaces: the two big "ports".

**Check yourself:** can you explain the difference between `placeOrder`, `closePosition` and `exitPositions`?

### Step 2: The composition root, `src/index.ts` (15 min)
Read `run()` line by line. It is the bot's whole life:
1. Load config, create the logger and the notifier (alerts).
2. Open SQLite and run migrations.
3. Check there's a login session (otherwise tell you to run `bun run login`).
4. Refresh the instrument master if it's stale.
5. Create the broker adapters (factory), start `MarketEngine`, start `ScripRecorder` (prices → `scrips`).
6. Pick the broker: real Upstox if `live`, otherwise `PaperBroker`. Wrap it in `RiskManager`.
7. Create `StrategyEngine`, add `IronButterfly`, start.
8. Wait for Ctrl+C (or SIGTERM from the scheduler), then shut down in reverse order (square off first) and send the day's summary alert.

**Check yourself:** which object would you replace to switch to a different broker? Where would a second strategy be added?

### Step 3: Config and utilities (20 min)
- `src/config/index.ts`: how `.env` becomes a typed `Config`.
  - The live-trading gate: `TRADING_MODE=live` alone is not enough; `LIVE_TRADING_CONFIRM=yes` is also required.
  - Risk limits default from your capital (daily loss = 2%).
- `src/utils/time.ts`: all IST handling goes through here (dayjs). The key helpers are `istDate`, `istMinutes`, `parseHHMM` and `istDateTime`.
- `src/utils/logger.ts`:
  - `createLogger` and `logger.child("name")`.
  - Daily files in `logs/`; `pruneLogs` deletes old ones.
  - Secrets (`token`, `password`, …) are redacted automatically.

### Step 4: Storage, `src/store/` (20 min)
- `database.ts`: opens SQLite in WAL mode; `migrate()` applies numbered migrations once.
- `migrations.ts`: every table in one place. Read the SQL:
  1. `broker_sessions`
  2. `instruments`, `instrument_downloads`
  3. `orders`, `strategy_trades`, `strategy_state`
  4. `scrips` (latest price per instrument)
  5. `kill_switch` (one row per day it was pressed)
  6. `market_holidays`
- The repositories:
  - `session-store.ts`
  - `instrument-store.ts`
  - `trading-store.ts`: orders, trades, state and the kill switch
  - `scrip-store.ts`
  - `calendar-store.ts`
- `InstrumentStore.findOption(...)` is how a strategy finds, say, "NIFTY 23800 CE for the nearest expiry".

Rule: timestamps are stored in **UTC**; trade dates and expiry dates are **IST dates** (`YYYY-MM-DD`).

### Step 5: Market data, `src/engine/` (45 min)
- `candle-series.ts`: `candleBounds()` works out which candle a time belongs to (aligned to 09:15). `CandleSeries` updates the forming candle with each tick and emits it when it completes.
- `market-engine.ts`: the hub. It does four jobs:
  - **Shared subscriptions:** two strategies can watch NIFTY while only one WebSocket subscription is made. The richest mode anyone asked for wins.
  - **Latest tick** per instrument (`ltp`, `lastTick`), plus `onAnyTick` for listeners that want every tick.
  - **Candles:** loads history on first use, then keeps them live from ticks, and refills them after a reconnect.
  - **Clock:** closes candles on time even when no tick arrives.
- `scrip-recorder.ts`: listens to `onAnyTick` and writes the latest `ltp`/`cp` per instrument to `scrips`, batched once a second. This is how the dashboard gets live prices without its own broker connection.
  - Only *subscribed* instruments get rows. Before entry that's just the NIFTY index; the option legs appear once the strategy subscribes at 09:20.

Read `tests/market-engine.test.ts` and `tests/scrip-recorder.test.ts` alongside. Each test is a short story of one behaviour.

### Step 6: The strategy framework (45 min)
- `src/engine/strategy.ts`: the `Strategy` interface and `StrategyContext`. **This is the complete list of things a strategy is allowed to do.** Read every comment.
- `src/engine/strategy-engine.ts`: `StrategyEngine` owns one `StrategyRunner` per strategy. Look for:
  - the serial queue (events handled one at a time)
  - tick coalescing
  - `tick()`: every second, `checkKillSwitch()` and then `onClock` for each strategy
  - `checkKillSwitch()`: one primary-key lookup in `kill_switch`; when today's row appears, `killSwitch()` runs every strategy's `squareOff()`, once a day
  - how orders are tagged with the strategy id and routed back to the strategy that placed them
  - `waitForOrders` (waits for fills through events, not polling)
  - how trades and state are saved through `TradingStore`, and how errors become alerts

### Step 7: The iron butterfly, `src/strategies/iron-butterfly/index.ts` (1 hour)
Read it in this order:
1. `IronButterflyConfig` and `DEFAULT_IRON_BUTTERFLY`: every knob (times, wing distance, stop loss, target).
2. The `Leg` type: how fills are tracked (`filledIn/valueIn/filledOut/valueOut`, `pending` order IDs).
3. `start()`: finds the NIFTY index, subscribes, and restores saved state. In live mode it resumes an open trade; in paper mode it discards one.
4. `squareOff()`: the kill switch. Exits if a trade is on; either way, marks the day `done`.
5. `evaluate()`: **the heart**, a `switch` on the phase:
   - `idle`: at the entry time, calls `enter()`.
   - `open`: checks time exit, stop loss (MTM ≤ −stop loss) and target (MTM ≥ target).
   - `entering`/`exiting`: retries the exit every few seconds.
6. `enter()`: picks the ATM strike from spot, finds 4 options, waits for quotes, **buys the wings first** (so the position is never naked), then sells the ATM straddle.
7. `exitTrade()`: **buys back the shorts first**, then sells the wings.
8. `mtm()`: live P&L from leg fills and current prices.

**Check yourself:** why does entry buy the wings first while exit closes the shorts first? (Answer: both orders keep you *hedged* at every moment, so you never hold an uncovered short option.)

### Step 8: Risk, `src/risk/risk-manager.ts` (30 min)
`RiskManager` wraps the broker (the decorator pattern).
- **`placeOrder` → `vet()`:**
  - Too many lots in one order → refused.
  - An order that **adds exposure** is refused when:
    - the kill switch is on today
    - the daily loss limit was hit
    - it would open more positions than `maxOpenPositions`
  - Orders that **reduce** a position always go through, so exits can never be blocked.
- **`applyOrder()`:** follows every fill (from `getOrders()` at start, then `onOrderUpdate`) to keep a book per instrument: net quantity, cash, estimated charges.
- **`check()`:** runs every second. When `dayPnl()` ≤ −`maxDailyLoss`, it writes the kill switch row with source `risk: daily loss …`. From there it's the same path as the dashboard button.
- A refused order throws `RiskRejection`. The strategy treats it like any failed order (e.g. a failed entry unwinds what filled).

### Step 9: Brokers (1 hour)
- `src/brokers/index.ts`: the factory.
- `src/brokers/order-checks.ts`: every order is validated (quantity is a multiple of the lot size, price is on the tick size).
- `src/brokers/charges.ts`: charges per order. `tests/charges.test.ts` pins the numbers against Upstox's own calculator.
- `src/brokers/paper/paper-broker.ts`: simulates a broker. A BUY fills at the ask, a SELL at the bid, both from live ticks. Fill events are sent with `setTimeout(0)`, so `placeOrder` returns before its fill arrives, just like a real broker.

### Step 10: Upstox adapter, `src/brokers/upstox/` (1–2 hours, optional depth)
You only need this when debugging broker issues. The layers, from bottom to top:
- `constants.ts`: every URL and endpoint.
- `http.ts`: one place for REST calls, auth header, rate limiting and error handling (`errors.ts`).
- `auth.ts` + `login-server.ts`: OAuth login. A small local server catches the redirect.
- `instruments.ts`: downloads and parses `complete.json.gz`. **Tick size there is in paise.**
- `orders.ts`, `account.ts`, `market-data.ts`, `calendar.ts`: thin REST wrappers. `calendar.ts` maps the holiday list to F&O (`NFO`) closures and special sessions.
- `reconnecting-socket.ts`: a WebSocket that reconnects by itself.
- `market-feed.ts` + `feed-decoder.ts` + `MarketDataFeedV3.proto`: the live price feed (protobuf).
- `portfolio-feed.ts`: live order and position updates (JSON).
- `mappers.ts`: Upstox shapes ↔ core types.
- `broker-adapter.ts` (`UpstoxBroker`) and `market-data-adapter.ts` (`UpstoxMarketData`): implement the core interfaces using everything above.
- `cli.ts`: `bun run upstox …`, read-only helpers for poking at the API.

### Step 11: Calendar, alerts and the scheduler (45 min)
- `src/calendar/market-calendar.ts`:
  - `session(date)` is regular hours on weekdays, nothing on holidays, and the broker's hours on special days (Sunday budget session, Diwali muhurat).
  - `refreshHolidaysIfStale` re-downloads weekly, or when the year changes, and keeps the old list if a download fails.
- `src/alerts/notifier.ts`:
  - `Notifier` has two methods: `notify(text)` (never throws) and `flush()`.
  - `TelegramNotifier` queues messages, sends about one per second, and drops repeats of the same text for 10 minutes.
  - Without Telegram settings, `LogNotifier` just logs.
- `src/scheduler/`:
  - `plan.ts`: for a date, `planDay` gives login check (open −45 min), start (open −20 min) and stop (close +5 min). `phaseAt` turns a time into `closed / waiting / login-check / trading / after`.
  - `scheduler.ts`: `tick()` acts on the phase:
    - alerts once if you're not logged in
    - starts the bot when logged in
    - restarts it after a crash, at most 3 times a day
    - sends SIGINT after the close
    - sends a holiday notice
  - `index.ts`: wiring. It keeps the dashboard running too.
  - Signals work as in `run-all.ts`: **Ctrl+C reaches the children directly and isn't forwarded again** (the bot would die on a second SIGINT before squaring off). SIGTERM is forwarded once.

### Step 12: Reports, `src/reports/report.ts` (15 min)
`buildReport(trades)` is a pure function:
- win rate, average win and loss
- **expectancy** (average net P&L per trade, after costs)
- profit factor
- **max drawdown** (the biggest fall of cumulative P&L from a previous high)
- best and worst trade
- exit reasons, and per-day P&L with a running total

The same report feeds `bun run report` (via `formatReport`) and the dashboard's History page.

### Step 13: The dashboard, `src/dashboard/` (1 hour)
Read it as three layers:
1. **Server, `server.ts`:** `Bun.serve` with the `/api/*` routes and `"/*"` → the React page (Bun bundles `web/index.html` itself). Two DB connections: a **read-only** one for everything shown, and a write one used only by `KillSwitchService`.
2. **API, `api/router.ts`:** each route is a small handler.
   - `authed()` checks the session cookie.
   - `jsonOnly()` makes POSTs require JSON, which with `SameSite=Strict` blocks cross-site requests.
   - Endpoints:
     - `POST /api/auth/login`, `POST /api/auth/logout` and `GET /api/auth/me`
     - `GET /api/status`, `GET /api/positions`, `GET /api/market`, `GET /api/orders`, `GET /api/history/summary` and `GET /api/history`
     - `POST /api/kill-switch`
   - `api/types.ts` holds the request/response shapes, shared by the server and the page.
3. **Services, `services/`:**
   - `status-service` (broker session, mode, strategy phases and today's trade plan, today's P&L, kill switch, risk limits)
   - `positions-service` (open positions from today's fills + prices from `scrips`)
   - `market-service` (the NIFTY price and change from `scrips`, today's session from the calendar, upcoming holidays, and the bot's heartbeat = when it last wrote a price)
   - `orders-service` (today's orders, newest first)
   - `history-service` (closed trades, what was bought/sold, the report)
   - `kill-switch-service` (the one write)

**Auth** (`auth/`):
- The password and PIN are checked against argon2 hashes from `bun run dashboard:setup`.
- A wrong password and a wrong PIN give the same error.
- After 5 failures, login locks for 15 minutes.
- The session is a signed HttpOnly cookie that lasts 24 hours.
- Logging out revokes it on the server too.

**The page** (`web/`):
- `main.tsx`: Mantine, dark only.
- `App.tsx`: routes `/login`, `/` and `/history`, with a login guard.
- `api-client.ts`: **the only file that calls `fetch`**.
- `pages/`: one file per screen.
- `components/`: the shared header (`Layout`) and `KillSwitchButton`.
- `components/cards/`: the overview's newer cards:
  - `MarketStrip`
  - `TradePlanCard`, with `MtmMeter` (live MTM between the stop and the target)
  - `RiskCard`
  - `PnlChartCard`: a hand-drawn SVG line chart with a crosshair tooltip, no chart library
  - `RecentTradesCard`
  - `OrdersCard`

---

## 5. Trace a trading day through the code

Follow this story with the files open. It is the best way to see how the pieces connect. Times are IST, and this assumes `bun run scheduler` is running.

**08:30. Login check** (`scheduler.ts` → `checkLogin`)
- The scheduler's `tick()` sees phase `login-check`.
- If `broker_sessions` has no valid token, you get one alert: "Log in… run `bun run login`".
- The holiday list is refreshed if it's a week old (`refreshHolidaysIfStale`).
- On a holiday the phase is `closed` instead: one "Market closed today" alert, and no bot.

**08:55. The bot starts** (`scheduler.ts` → `startBot` → `src/index.ts`)
- `refreshInstrumentsIfStale` downloads the day's instrument master.
- `market.start()` connects the WebSocket. `ScripRecorder` starts writing `scrips`.
- `RiskManager.start()` loads today's orders. `engine.start()` → `IronButterfly.start(ctx)` subscribes to the NIFTY index, and `checkKillSwitch()` runs once (pressed earlier today? then no trading).

**09:15–09:20. Ticks arrive**
- WebSocket bytes → `market-feed.ts` `handleMessage` → `decodeFeed` → `Tick`.
- → `MarketEngine` (latest tick; `scrips` row for NIFTY) → `StrategyEngine` → queue → `IronButterfly.onTick` → `evaluate()`.
- The phase is `idle` and the time is before 09:20, so it does nothing.

**09:20. Entry**
- `enter()` computes ATM = spot rounded to 50, finds 4 options, subscribes (their `scrips` rows appear), and waits for quotes.
- `ctx.placeOrder(...)` → `StrategyEngine` tags it → **`RiskManager.vet()`** (lots, open positions, kill switch, daily loss) → `PaperBroker` / `UpstoxBroker`.
- Fills come back through `onOrderUpdate`:
  - `RiskManager.applyOrder` updates the day's book.
  - The engine saves them to `orders` and routes them to the strategy.
  - `waitForOrders` resolves.
- Phase becomes `open`, `saveState` writes it, and `ctx.notify` sends "entered … credit …".

**09:20–15:15. Watching**
- Every tick and every second: `evaluate()` → `mtm()`. Exit if MTM ≤ −stop loss or ≥ target.
- Every second: `RiskManager.check()` compares the day's P&L with the daily loss limit, and `checkKillSwitch()` looks for today's `kill_switch` row.
- The dashboard's Open P&L = today's fills (`orders`) × the latest prices (`scrips`).

**Kill switch** (dashboard button, or the daily loss limit)
- A row is written to `kill_switch` for today.
- Within a second, `checkKillSwitch()` sees it and queues `squareOff()` for each strategy.
- The strategy exits (shorts first). The trade is recorded as `KILL_SWITCH` and the phase becomes `done`. You get an alert.
- New entries are refused by both the strategy (done for the day) and the risk manager. Tomorrow has no row, so trading resumes on its own.

**Exit (target, stop loss, or 15:15)**
- `exitTrade()`: buys back the shorts, then sells the wings. Retries every 5s if something fails.
- Fills are saved to `orders`, and the finished trade to `strategy_trades` with charges from `charges.ts`.
- Phase becomes `done`, so there is no second trade today. An alert says "exited (…): net ₹…".

**15:35. The bot stops** (`scheduler.ts` → `stopBot` → SIGINT)
- `engine.stop()` → `IronButterfly.stop()` squares off anything still open, and everything closes in reverse order.
- The bot sends the day's summary alert ("Today: 1 trade, net ₹…") and exits.
- On the next day, `onNewDay` deletes log files older than `LOG_RETENTION_DAYS`.

---

## 6. Tests are the best documentation

Every module has a test file in `tests/` with the same name. Each test is a small, runnable example.

- `tests/iron-butterfly.test.ts`: full trades end to end, including the kill switch row, using `tests/trading-harness.ts` (fake market + paper broker; pass `risk` to wrap it in the risk manager).
- `tests/risk-manager.test.ts`: each limit, plus the daily loss limit squaring off a real iron butterfly through the kill switch.
- `tests/scheduler.test.ts`: a whole day, a holiday, crashes and restarts, with a fake clock and a `FakeBot`.
- `tests/calendar.test.ts`: real Upstox holiday rows → sessions.
- `tests/report.test.ts`: every statistic on a small, hand-checked list of trades.
- `tests/dashboard.test.ts`: auth, sessions, lockout, status/positions/history services, and the API through a real `Bun.serve`.
- `tests/market-engine.test.ts`, `tests/strategy-engine.test.ts`, `tests/charges.test.ts`, `tests/upstox-*.test.ts`: the foundations.

Useful commands:
```sh
bun test                                  # everything
bun test tests/iron-butterfly.test.ts     # one file
bun test -t "kill switch"                 # tests whose name matches
bun run typecheck                         # types only
```

**Learning trick:** change one number in the code (e.g. the wing distance, an STT rate, or `SCHEDULE.startBeforeOpen`) and run the tests. The failures show exactly which behaviour depends on it.

---

## 7. Where do I change…?

- **Strategy settings** (lots, wing distance, times, stop loss, target): `.env` (`IB_*`), read in `src/config/index.ts`. The defaults are in `DEFAULT_IRON_BUTTERFLY`.
- **Risk limits:** `.env` (`RISK_MAX_DAILY_LOSS`, `RISK_MAX_LOTS_PER_ORDER`, `RISK_MAX_OPEN_POSITIONS`). The checks are in `RiskManager.vet()` and `check()`.
- **Alerts:** `.env` (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`). The message texts are at the `notify(...)` calls (grep for `notify(`).
- **Scheduler times:** `SCHEDULE` in `src/scheduler/plan.ts`.
- **Paper vs. live:** `TRADING_MODE` in `.env`. Live also needs `LIVE_TRADING_CONFIRM=yes`.
- **Charges/brokerage:** `src/brokers/charges.ts`, and update `tests/charges.test.ts` too.
- **Dashboard:**
  - A new card: a component in `web/pages/HomePage.tsx`.
  - New data: a method in a service, plus a route in `api/router.ts`, a type in `api/types.ts` and a call in `web/api-client.ts`.
- **Add a new strategy:**
  1. Create `src/strategies/<name>/index.ts` implementing `Strategy`, including `squareOff()` for the kill switch.
  2. `engine.add(new MyStrategy(...))` in `src/index.ts`.
  3. Copy the style of `tests/iron-butterfly.test.ts`.
- **Add a new broker:**
  1. Create `src/brokers/<name>/` with adapters implementing `Broker`, `MarketData` and `BrokerLogin`, plus holidays.
  2. Add a case to each factory in `src/brokers/index.ts` and the name to `BROKERS` in config.
- **Add a table/column:** append a **new** migration to `src/store/migrations.ts`. Never edit an old one.
- **Logs:** `logs/YYYY-MM-DD.log`.
- **Data:** open `./db/trade-bot.sqlite` (or `DB_PATH` from `.env`) in TablePlus or `sqlite3`. List tables with `.tables`.

---

## 8. Glossary

- **ATM:** at-the-money strike, the strike nearest the current spot price.
- **Wing:** the far OTM options bought for protection (here ±400 points).
- **Iron butterfly:** sell ATM CE + PE, buy OTM CE + PE wings. Profits if NIFTY stays near the ATM strike.
- **Credit:** premium received minus premium paid at entry. This is the maximum profit.
- **MTM:** mark-to-market, the live profit or loss of the open position.
- **Kill switch:** square off everything now and make no new trades for the rest of the day. It's a row in `kill_switch`.
- **Expectancy:** average net P&L per trade after costs, i.e. what one more trade is expected to make.
- **Max drawdown:** the largest fall of cumulative P&L from a previous high.
- **Profit factor:** total winnings ÷ total losses.
- **MIS / NRML / CNC:** intraday / overnight F&O / delivery products.
- **LTP / cp:** last traded price / previous day's close.
- **Instrument key:** Upstox's ID for an instrument, e.g. `NSE_INDEX|Nifty 50`.
- **Lot size:** the minimum tradable quantity (NIFTY = 65).
- **Tick size:** the smallest price step (₹0.05 for options).
- **Paper trading:** real live prices, simulated orders, no money at risk.
- **Special session:** the market open on an unusual day or at unusual hours (Sunday budget day, Diwali muhurat).
