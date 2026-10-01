import type { Database } from "bun:sqlite";

export interface Scrip {
  instrumentKey: string;
  ltp: number;
  /** Previous day's close. */
  cp: number;
  /** When the bot last saved this price. */
  updatedAt: Date;
}

/** Latest price per instrument (the `scrips` table): one row each, overwritten as ticks arrive. */
export class ScripStore {
  constructor(private readonly db: Database) {}

  /** Upserts all scrips in one transaction. */
  saveMany(scrips: Omit<Scrip, "updatedAt">[]): void {
    if (scrips.length === 0) return;
    const upsert = this.db.query(
      `INSERT INTO scrips (instrument_key, ltp, cp, updated_at) VALUES ($instrumentKey, $ltp, $cp, $updatedAt)
       ON CONFLICT (instrument_key) DO UPDATE SET ltp = excluded.ltp, cp = excluded.cp, updated_at = excluded.updated_at`,
    );
    const updatedAt = new Date().toISOString();
    this.db.transaction(() => {
      for (const s of scrips) upsert.run({ instrumentKey: s.instrumentKey, ltp: s.ltp, cp: s.cp, updatedAt });
    })();
  }

  get(instrumentKeys: string[]): Map<string, Scrip> {
    const result = new Map<string, Scrip>();
    if (instrumentKeys.length === 0) return result;
    const rows = this.db
      .query("SELECT instrument_key, ltp, cp, updated_at FROM scrips WHERE instrument_key IN (SELECT value FROM json_each($keys))")
      .all({ keys: JSON.stringify(instrumentKeys) }) as { instrument_key: string; ltp: number; cp: number; updated_at: string }[];
    for (const r of rows) result.set(r.instrument_key, { instrumentKey: r.instrument_key, ltp: r.ltp, cp: r.cp, updatedAt: new Date(r.updated_at) });
    return result;
  }
}
