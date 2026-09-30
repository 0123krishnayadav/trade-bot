# Trade-bot roadmap

We build one step at a time. Each step is small, has tests where it makes sense, and ends in a
commit (`BOT-0xx: ...`). Tick the box when a step is merged.

## Design principle

All market data and orders come from the **broker**. For each broker we write one adapter
(`src/brokers/<name>/`) that implements two interfaces from `src/core`:

- **`Broker`**: orders, positions, funds
- **`MarketData`**: instruments, historical candles, live ticks, option chain

Strategies, the engine and risk code depend only on these interfaces, never on Upstox directly.
Adding a second broker later (Zerodha, Dhan, ...) means writing a new adapter, not changing
strategies. The paper broker reuses a real broker's live data and only fakes the fills.

```
Upstox API ──▶ brokers/upstox ──▶ MarketData ──▶ engine ──▶ strategy
                     ▲                              │
                     └──────── Broker ◀── risk ◀────┘ (orders)
```

---

## Phase 1: Foundation

- [x] **1. Config and secrets.** Typed config loaded from `.env` with validation, plus
      `.env.example` (no real secrets committed). Fails fast with a clear message when a
      variable is missing.
- [x] **2. Logger and IST time utilities.** Structured logger; IST helpers (date, minutes,
      market open/close checks). Tested.
- [x] **3. SQLite storage base.** `bun:sqlite` connection, simple migrations table, `db/`
      folder git-ignored. Tables are added by later steps as they're needed.

## Phase 2: Upstox integration

- [x] **4. Upstox app setup (you).** Create an app in the Upstox developer console, set the
      redirect URL (e.g. `http://127.0.0.1:5000/callback`), put API key and secret in `.env`.
- [x] **5. Login (OAuth).** Small `Bun.serve` callback server: open the login URL, receive the
      `code`, exchange it for an access token, save the token and its expiry in SQLite. Upstox
      tokens expire daily (early morning), so this is a once-a-day login.
- [x] **6. HTTP client.** One client for all Upstox REST calls: auth header, JSON parsing,
      Upstox error codes → typed errors, rate limiting, retry on network errors only. Verified
      by fetching the user profile and funds.
- [x] **7. Instrument master.** Download and cache Upstox's instrument file daily. Look up
      NIFTY index, stocks, and option contracts by underlying/expiry/strike/CE-PE. Map our
      symbols ↔ Upstox `instrument_key`.
- [x] **8. Historical candles.** Fetch historical and intraday candles for any instrument and
      timeframe, return our `Candle` type. (Caching in SQLite moved to step 22, where the
      backtester needs it.)
- [x] **9. Live market data (websocket).** Connect to the Upstox market data feed, decode its
      messages (protobuf), subscribe/unsubscribe, emit ticks, auto-reconnect and resubscribe.
- [ ] **10. Option chain.** Expiries and strikes for NIFTY, with LTP, OI and greeks from the
      option chain API. ATM strike lookup.
- [x] **11. Read-only account data.** Positions, holdings, funds and margin, order book and
      trade book mapped to our types.
- [x] **12. Orders.** Place, modify and cancel orders (MARKET, LIMIT, SL, SL-M). First tested
      read-only against the API docs and with mocked responses; one real test with a tiny,
      far-from-market order that is cancelled immediately. GTT orders too.
      *(Built and unit-tested; the real-order test is still to do once logged in.)*
- [x] **13. Order updates (websocket).** Upstox portfolio stream for live order and position
      updates, with reconnect.
- [x] **14. Adapter complete.** `UpstoxBroker` and `UpstoxMarketData` implement the core
      interfaces. Contract tests any future broker adapter must also pass.
      *(Order updates come only from the portfolio stream (step 13); no polling.)*

## Phase 3: Trading core

- [ ] **15. Market calendar.** Trading hours and NSE holidays (from Upstox), weekly expiry
      resolution including holiday shifts.
- [x] **16. Charges calculator.** Brokerage, STT, exchange, SEBI, stamp duty, GST for F&O,
      checked against Upstox's brokerage API.
      *(Checked against Upstox's brokerage API on 2026-09-30; tests/charges.test.ts pins the results.)*
- [x] **17. Paper broker.** Live Upstox prices, simulated fills with slippage and charges,
      positions and P&L. Same `Broker` interface as the real one.
- [x] **18a. MarketEngine.** One shared feed; subscriptions shared between strategies; latest
      tick per instrument; candles per instrument/timeframe from history + live ticks; refill after
      reconnects.
- [x] **18b. StrategyEngine.** Runs strategies with a context (prices, candles, orders); error
      isolation; clean shutdown that squares off.
- [ ] **19. Order manager.** Multi-leg (basket) execution: hedges first, wait for fill
      confirmation, handle rejections and partial fills, retry and unwind safely.
- [ ] **20. Risk manager.** Per-trade stop, daily max loss, max open positions, max lots,
      kill switch (square off everything and stop trading for the day).

## Phase 4: Strategy and testing

- [x] **21. Iron butterfly strategy.** 09:20 entry, 400-point wings, combined MTM target and
      stop, 15:15 exit, one trade per day. Unit tests with fake market data.
- [ ] **22. Backtester.** Replay historical candles through the same engine and strategy.
      Needs historical data for expired option contracts (check what our Upstox plan
      provides; otherwise a data vendor).
- [ ] **23. Reports.** Win rate, average win/loss, expectancy after costs, max drawdown, exit
      reasons, per-day P&L.
- [ ] **24. Paper forward test.** Run on live data with the paper broker for 2–4 weeks and
      review reports.

## Phase 5: Operations and going live

- [ ] **25. Daily scheduler.** Pre-market checks (token valid, instruments refreshed), start at
      market open, stop after close, one process that runs every trading day.
- [ ] **26. Alerts.** Telegram (or similar) messages for entries, exits, errors, kill switch
      and daily summary.
- [ ] **27. Dashboard.** Small `Bun.serve` page: open positions, live MTM, today's trades,
      manual kill-switch button.
- [ ] **28. Deployment.** Docker image on an India-region VPS; persistent volume for SQLite;
      restarts; log retention. Check SEBI's retail algo rules and Upstox's current requirements
      (e.g. static IP registration for API orders) before going live.
- [ ] **29. Go live, small.** 1 lot, real orders, all risk limits on, watched closely. Scale
      only after the live results match the paper results.
