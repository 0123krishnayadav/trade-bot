import type { Migration } from "./database";

/**
 * The bot's schema, in order. Never edit a migration that has already run; add a new one instead.
 */
export const migrations: Migration[] = [
  {
    id: 1,
    name: "broker sessions",
    // One row per broker: the current access token and when it stops working.
    up: `CREATE TABLE broker_sessions (
      broker TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_name TEXT,
      access_token TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )`,
  },
  {
    id: 2,
    name: "instruments",
    // The broker's instrument master, replaced in full on each daily download.
    up: `CREATE TABLE instruments (
      broker TEXT NOT NULL,
      key TEXT NOT NULL,
      exchange TEXT NOT NULL,
      segment TEXT NOT NULL,
      kind TEXT NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      underlying TEXT,
      underlying_key TEXT,
      expiry TEXT,
      strike REAL,
      option_type TEXT,
      weekly INTEGER,
      lot_size INTEGER NOT NULL,
      tick_size REAL NOT NULL,
      freeze_quantity INTEGER,
      isin TEXT,
      series TEXT,
      PRIMARY KEY (broker, key)
    );
    CREATE INDEX instruments_derivatives ON instruments (broker, underlying, kind, expiry, strike);
    CREATE INDEX instruments_symbol ON instruments (broker, symbol);
    CREATE TABLE instrument_downloads (
      broker TEXT PRIMARY KEY,
      downloaded_at TEXT NOT NULL,
      count INTEGER NOT NULL
    );`,
  },
  {
    id: 3,
    name: "orders, strategy trades and strategy state",
    // Paper and live runs are kept apart by the mode column.
    up: `CREATE TABLE orders (
      mode TEXT NOT NULL,
      broker TEXT NOT NULL,
      id TEXT NOT NULL,
      strategy_id TEXT,
      instrument_key TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      type TEXT NOT NULL,
      product TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      price REAL NOT NULL,
      trigger_price REAL NOT NULL,
      status TEXT NOT NULL,
      filled_quantity INTEGER NOT NULL,
      average_price REAL NOT NULL,
      status_message TEXT,
      tag TEXT,
      placed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (mode, broker, id)
    );
    CREATE TABLE strategy_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL,
      strategy_id TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      closed_at TEXT NOT NULL,
      exit_reason TEXT NOT NULL,
      gross_pnl REAL NOT NULL,
      charges REAL NOT NULL,
      net_pnl REAL NOT NULL,
      details TEXT
    );
    CREATE INDEX strategy_trades_by_strategy ON strategy_trades (mode, strategy_id, trade_date);
    CREATE TABLE strategy_state (
      mode TEXT NOT NULL,
      strategy_id TEXT NOT NULL,
      state TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (mode, strategy_id)
    );`,
  },
];
