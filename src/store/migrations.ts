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
];
