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
];
