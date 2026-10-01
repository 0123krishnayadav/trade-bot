# Code Guide: how to read and understand trade-bot

This guide takes you through the code in a sensible order: the big picture first, then one layer at a time, then a full trading day traced through the code. It covers **what** each part does and **why** it is built that way.

For what is planned next, see `docs/ROADMAP.md`. For setup and commands, see `README.md`.

---

## 1. The big picture in one minute

The bot does four things:

1. **Logs in** to a broker (Upstox) once a day and saves the access token in SQLite.
2. **Listens** to live market prices over a WebSocket.
3. **Runs strategies** (currently the NIFTY iron butterfly). They look at prices and decide when to buy or sell.
4. **Places orders**, either for real (live mode) or simulated against live prices (paper mode).

The most important idea: **strategies never talk to Upstox directly.** They talk to generic interfaces (`Broker`, `MarketData`). Upstox is one *adapter* that plugs into those interfaces, and the paper broker is another. Adding Zerodha later means writing a new adapter. Strategies don't change.

```
                     ┌──────────────────────────┐
                     │   src/index.ts           │  wires everything together
                     └────────────┬─────────────┘
                                  │
        ┌─────────────────────────┼──────────────────────────┐
        ▼                         ▼                          ▼
 ┌──────────────┐        ┌─────────────────┐        ┌──────────────────┐
 │ MarketEngine │──tick─▶│ StrategyEngine  │─order─▶│ Broker           │
 │ prices,      │        │ runs strategies │        │ (Paper or Upstox)│
 │ candles      │◀──sub──│ one at a time   │◀─fill──│                  │
 └──────┬───────┘        └────────┬────────┘        └────────┬─────────┘
        │                         │                          │
        ▼                         ▼                          ▼
 MarketData (Upstox         IronButterfly             Upstox REST +
 WebSocket adapter)         (your strategy)           portfolio WebSocket
                                  │
                                  ▼
                         SQLite (orders, trades, state)
```

---

## 2. Folder map

```
src/
  index.ts                 START HERE: the composition root (builds and connects everything)
  login.ts                 `bun run login`: daily broker login

  core/types.ts            The contracts: Instrument, Tick, Candle, Order, Broker, MarketData…
  config/                  Reads .env into one typed Config object (env.ts = parsing helpers)

  engine/
    market-engine.ts       Market data hub: shared subscriptions, latest ticks, candles
    candle-series.ts       Builds 1m/5m/… candles from ticks, aligned to 09:15
    strategy.ts            The Strategy interface and StrategyContext (what a strategy may use)
    strategy-engine.ts     Runs strategies: event queue, order routing, saving trades

  strategies/
    iron-butterfly/        The strategy itself (a state machine)

  brokers/
    index.ts               Factory: picks the adapter from config.broker
    charges.ts             Brokerage, STT, GST… per order
    order-checks.ts        Validates orders (lot size, tick size) before sending
    paper/paper-broker.ts  Fake broker: fills at live bid/ask, no real money
    upstox/                Everything Upstox-specific (see section 5)

  store/                   SQLite: database + migrations + one "store" class per area
  utils/                   logger (console + daily log file), time (IST helpers, dayjs)

tests/                     One test file per module; read these as examples
docs/                      ROADMAP.md, this guide
Docker/                    Dockerfile
```

Empty folders with `.gitkeep` (`backtest/`, `risk/`, `data/`) are placeholders for roadmap steps that haven't been built yet.

---

## 3. Design patterns used (and where)

You'll see these patterns throughout the code. Once you recognise them, most files become predictable.

**Ports and adapters (hexagonal architecture)**
- *Ports* are the interfaces in `src/core/types.ts`: `Broker`, `MarketData`, `BrokerLogin`, `InstrumentLookup`.
- *Adapters* implement them: `UpstoxBroker`, `UpstoxMarketData`, `PaperBroker`, `InstrumentStore`.
- Why: the engine and strategies depend only on the interfaces, so brokers are swappable.

**Factory**: `src/brokers/index.ts`
- `createBrokerAdapters(config, …)` and `createBrokerLogin(config)` switch on `config.broker`.
- This is the only place outside `brokers/upstox/` that knows the word "upstox".

**Dependency injection and the composition root**: `src/index.ts`
- Classes receive what they need through their constructor (`new MarketEngine(marketData, …)`). They don't import and create their own dependencies.
- `index.ts` is the one place where all objects are created and connected.
- Why: tests can pass fakes (see `FakeMarketData` in `tests/market-engine.test.ts`).

**Observer (callbacks)**
- `onTick`, `onCandleClose`, `onOrderUpdate`, `onPositionUpdate`, `onConnectionChange`.
- Data is *pushed* to whoever registered. There is **no polling** anywhere.

**Strategy pattern**: `src/engine/strategy.ts`
- Every strategy implements the same `Strategy` interface (`start`, `onTick`, `onClock`, `onOrderUpdate`, `stop`), so the engine can run any of them.

**State machine**: `src/strategies/iron-butterfly/index.ts`
- `idle → entering → open → exiting → done`. The phase is saved to SQLite after every change, so a restart can resume.

**Repository**: `src/store/*-store.ts`
- Each store class hides the SQL for one area (sessions, instruments, trading). The rest of the code never writes SQL.

**Mapper**: `src/brokers/upstox/mappers.ts`
- Converts Upstox's JSON shapes into the generic types in `core/types.ts` and back. Upstox field names never leak out of `brokers/upstox/`.

**Serial event queue**: `StrategyRunner` in `strategy-engine.ts`
- Each strategy's events are handled one at a time, so a strategy never needs locks. If ticks arrive faster than the strategy can handle them, only the latest tick is delivered (*tick coalescing*).

---

## 4. Suggested reading order

Read in this order. Each step builds on the previous one. The time estimates assume careful reading.

### Step 1: The contracts, `src/core/types.ts` (30 min)
Read it top to bottom. It is the vocabulary of the whole project.
- `Instrument`: what a tradable thing is (key, symbol, lot size, tick size, strike, expiry).
- `Tick` and `Candle`: price data.
- `OrderRequest`, `Order`, `OrderStatus`, `Position`: trading data.
- The `MarketData` and `Broker` interfaces: the two big "ports".

**Check yourself:** can you explain the difference between `placeOrder`, `closePosition` and `exitPositions`?

### Step 2: The composition root, `src/index.ts` (15 min)
Read `run()` line by line. It is the bot's whole life:
1. Load config, create logger.
2. Open SQLite and run migrations.
3. Check there's a login session (otherwise tell you to run `bun run login`).
4. Refresh the instrument master if it's stale.
5. Create the broker adapters (factory), then start `MarketEngine`.
6. Pick the broker: real Upstox if `live`, otherwise `PaperBroker`.
7. Create `StrategyEngine`, add `IronButterfly`, start.
8. Wait for Ctrl+C, then shut down in reverse order (square off first).

**Check yourself:** which object would you replace to switch to a different broker?

### Step 3: Config and utilities (20 min)
- `src/config/index.ts`: how `.env` becomes a typed `Config`. Note the live-trading gate: `TRADING_MODE=live` alone is not enough, `LIVE_TRADING_CONFIRM=yes` is also required.
- `src/utils/time.ts`: all IST handling goes through here (dayjs). The key helpers are `istDate`, `istMinutes`, `parseHHMM` and `istDateTime`.
- `src/utils/logger.ts`: `createLogger`, `logger.child("name")` and daily files in `logs/`.

### Step 4: Storage, `src/store/` (20 min)
- `database.ts`: opens SQLite in WAL mode; `migrate()` applies numbered migrations once.
- `migrations.ts`: every table in one place. Read the SQL: `broker_sessions`, `instruments`, `instrument_downloads`, `orders`, `strategy_trades`, `strategy_state`.
- `session-store.ts`, `instrument-store.ts` and `trading-store.ts` are the repositories. `InstrumentStore.findOption(...)` is how a strategy finds, say, "NIFTY 23800 CE for the nearest expiry".

Rule: timestamps are stored in **UTC**; expiry dates are stored as **IST dates** (`YYYY-MM-DD`).

### Step 5: Market data, `src/engine/` (45 min)
- `candle-series.ts`: `candleBounds()` works out which candle a time belongs to (aligned to 09:15). `CandleSeries` updates the forming candle with each tick and emits it when it completes.
- `market-engine.ts`: the hub. It does four jobs:
  - **Shared subscriptions:** two strategies can watch NIFTY while only one WebSocket subscription is made. The richest mode anyone asked for wins.
  - **Latest tick** per instrument (`ltp`, `lastTick`).
  - **Candles:** loads history on first use, then keeps them live from ticks, and refills them after a reconnect.
  - **Clock:** closes candles on time even when no tick arrives.

Read `tests/market-engine.test.ts` alongside it. Each test is a short story of one behaviour.

### Step 6: The strategy framework (45 min)
- `src/engine/strategy.ts`: the `Strategy` interface and `StrategyContext`. **This is the complete list of things a strategy is allowed to do.** Read every comment.
- `src/engine/strategy-engine.ts`: `StrategyEngine` owns one `StrategyRunner` per strategy. Look for:
  - the serial queue (events handled one at a time)
  - tick coalescing
  - `onClock` every second
  - how orders are tagged with the strategy id and routed back to the strategy that placed them
  - `waitForOrders` (waits for fills through events, not polling)
  - how trades and state are saved through `TradingStore`

### Step 7: The iron butterfly, `src/strategies/iron-butterfly/index.ts` (1 hour)
Read it in this order:
1. `IronButterflyConfig` and `DEFAULT_IRON_BUTTERFLY`: every knob (times, wing distance, stop loss, target).
2. The `Leg` type: how fills are tracked (`filledIn/valueIn/filledOut/valueOut`, `pending` order IDs).
3. `start()`: finds the NIFTY index, subscribes, and restores saved state. In live mode it resumes an open trade; in paper mode it discards one.
4. `evaluate()`: **the heart**, a `switch` on the phase:
   - `idle`: at the entry time, calls `enter()`.
   - `open`: checks time exit, stop loss (MTM ≤ −stop loss) and target (MTM ≥ target).
   - `entering`/`exiting`: retries the exit every few seconds.
5. `enter()`: picks the ATM strike from spot, finds 4 options, waits for quotes, **buys the wings first** (so the position is never naked), then sells the ATM straddle.
6. `exitTrade()`: **buys back the shorts first**, then sells the wings.
7. `mtm()`: live P&L from leg fills and current prices.

**Check yourself:** why does entry buy the wings first while exit closes the shorts first? (Answer: both orders keep you *hedged* at every moment, so you never hold an uncovered short option.)

### Step 8: Brokers (1 hour)
- `src/brokers/index.ts`: the factory.
- `src/brokers/order-checks.ts`: every order is validated (quantity is a multiple of the lot size, price is on the tick size).
- `src/brokers/charges.ts`: charges per order. `tests/charges.test.ts` pins the numbers against Upstox's own calculator.
- `src/brokers/paper/paper-broker.ts`: simulates a broker. A BUY fills at the ask, a SELL at the bid, both from live ticks. Fill events are sent with `setTimeout(0)`, so `placeOrder` returns before its fill arrives, just like a real broker.

### Step 9: Upstox adapter, `src/brokers/upstox/` (1–2 hours, optional depth)
You only need this when debugging broker issues. The layers, from bottom to top:
- `constants.ts`: every URL and endpoint.
- `http.ts`: one place for REST calls, auth header and error handling (`errors.ts`).
- `auth.ts` + `login-server.ts`: OAuth login. A small local server catches the redirect.
- `instruments.ts`: downloads and parses `complete.json.gz`. **Tick size there is in paise.**
- `orders.ts`, `account.ts`, `market-data.ts`: thin REST wrappers.
- `reconnecting-socket.ts`: a WebSocket that reconnects by itself.
- `market-feed.ts` + `feed-decoder.ts` + `MarketDataFeedV3.proto`: the live price feed (protobuf).
- `portfolio-feed.ts`: live order and position updates (JSON).
- `mappers.ts`: Upstox shapes ↔ core types.
- `broker-adapter.ts` (`UpstoxBroker`) and `market-data-adapter.ts` (`UpstoxMarketData`): implement the core interfaces using everything above.
- `cli.ts`: `bun run upstox …`, read-only helpers for poking at the API.

---

## 5. Trace a trading day through the code

Follow this story with the files open. It is the best way to see how the pieces connect.

**08:00. Start**
- `bun run start` → `src/index.ts` `main()` → `run()`.
- `SessionStore.get("upstox")` finds today's token (you ran `bun run login`).
- `refreshInstrumentsIfStale` downloads the day's instrument master once it's published after 08:00.
- `market.start()` → `UpstoxMarketData.connect()` → WebSocket opens.
- `engine.start()` → `IronButterfly.start(ctx)` → `ctx.subscribe([NIFTY index], "ltp")`.

**09:15–09:20. Ticks arrive**
- WebSocket bytes → `market-feed.ts` `handleMessage` → `decodeFeed` → `Tick`.
- → `UpstoxMarketData` → `MarketEngine` (stores the latest tick) → `StrategyEngine` → queue → `IronButterfly.onTick` → `evaluate()`.
- The phase is `idle` and the time is before 09:20, so it returns and does nothing.

**09:20. Entry**
- `evaluate()` sees `idle` and minute ≥ entry, so it calls `enter()`.
- It computes ATM = spot rounded to 50 and finds 4 options via `ctx.instruments`, then subscribes to them in `full` mode.
- `waitForQuotes`: waits up to 5s for bid/ask.
- `ctx.placeOrder(...)` → `StrategyEngine` tags the order → `PaperBroker.placeOrder` (paper) or `UpstoxBroker.placeOrder` (live).
- The fill comes back through `onOrderUpdate` → the engine routes it to the strategy → `waitForOrders` resolves.
- Phase becomes `open`, and `saveState` writes it to `strategy_state`.

**09:20–15:15. Watching**
- Every tick and every second: `evaluate()` → `mtm()`. Exit if MTM ≤ −stop loss or ≥ target.

**Exit (target, stop loss, or 15:15)**
- `exitTrade()`: buys back the shorts, then sells the wings. Retries every 5s if something fails.
- Each fill is saved to `orders`, and the finished trade is saved to `strategy_trades` with charges from `charges.ts`.
- Phase becomes `done`, so there is no second trade today.

**Ctrl+C**
- `engine.stop()` → `IronButterfly.stop()` squares off anything still open, then everything closes in reverse order.

---

## 6. Tests are the best documentation

Every module has a test file in `tests/` with the same name. Each test is a small, runnable example.

- `tests/iron-butterfly.test.ts`: full trades end to end, using `tests/trading-harness.ts` (fake market + paper broker).
- `tests/market-engine.test.ts`: subscriptions, candles, reconnects.
- `tests/strategy-engine.test.ts`: queueing and order routing.
- `tests/charges.test.ts`: charges vs. Upstox.
- `tests/upstox-*.test.ts`: the adapter against recorded or fake responses.

Useful commands:
```sh
bun test                                  # everything
bun test tests/iron-butterfly.test.ts     # one file
bun test -t "stop loss"                   # tests whose name matches
bun run typecheck                         # types only
```

**Learning trick:** change one number in the code (e.g. the wing distance, or an STT rate) and run the tests. The failures show exactly which behaviour depends on it.

---

## 7. Where do I change…?

- **Strategy settings** (lots, wing distance, times, stop loss, target): `.env` (`IB_*` variables), read in `src/config/index.ts`. The defaults are in `DEFAULT_IRON_BUTTERFLY`.
- **Paper vs. live:** `TRADING_MODE` in `.env`. Live also needs `LIVE_TRADING_CONFIRM=yes`.
- **Charges/brokerage:** `src/brokers/charges.ts`, and update `tests/charges.test.ts` too.
- **Add a new strategy:**
  1. Create `src/strategies/<name>/index.ts` implementing `Strategy`.
  2. `engine.add(new MyStrategy(...))` in `src/index.ts`.
  3. Copy the style of `tests/iron-butterfly.test.ts`.
- **Add a new broker:**
  1. Create `src/brokers/<name>/` with adapters implementing `Broker`, `MarketData` and `BrokerLogin`.
  2. Add a case to the factory in `src/brokers/index.ts` and the name to `BROKERS` in config.
- **Add a table/column:** append a **new** migration to `src/store/migrations.ts`. Never edit an old one.
- **Logs:** `logs/YYYY-MM-DD.log`.
- **Data:** open `./db/trade-bot.sqlite` (or `DB_PATH` from `.env`) in TablePlus or `sqlite3`.

---

## 8. Glossary

- **ATM:** at-the-money strike, the strike nearest the current spot price.
- **Wing:** the far OTM options bought for protection (here ±400 points).
- **Iron butterfly:** sell ATM CE + PE, buy OTM CE + PE wings. Profits if NIFTY stays near the ATM strike.
- **Credit:** premium received minus premium paid at entry. This is the maximum profit.
- **MTM:** mark-to-market, the live profit or loss of the open position.
- **MIS / NRML / CNC:** intraday / overnight F&O / delivery products.
- **LTP:** last traded price.
- **Instrument key:** Upstox's ID for an instrument, e.g. `NSE_INDEX|Nifty 50`.
- **Lot size:** the minimum tradable quantity (NIFTY = 65).
- **Tick size:** the smallest price step (₹0.05 for options).
- **Paper trading:** real live prices, simulated orders, no money at risk.
