import type { Database } from "bun:sqlite";
import type { MarketHoliday } from "../core/types";

interface Row {
  date: string;
  description: string;
  open_at: string | null;
  close_at: string | null;
}

/** Market holidays and special sessions (the `market_holidays` table). */
export class CalendarStore {
  constructor(private readonly db: Database) {}

  /** Replaces the stored list with a freshly downloaded one, in one transaction. */
  replaceAll(holidays: MarketHoliday[], now: Date = new Date()): void {
    const insert = this.db.query(
      "INSERT INTO market_holidays (date, description, open_at, close_at, fetched_at) VALUES ($date, $description, $openAt, $closeAt, $fetchedAt)",
    );
    this.db.transaction(() => {
      this.db.run("DELETE FROM market_holidays");
      for (const h of holidays) {
        insert.run({
          date: h.date,
          description: h.description,
          openAt: h.session?.open.toISOString() ?? null,
          closeAt: h.session?.close.toISOString() ?? null,
          fetchedAt: now.toISOString(),
        });
      }
    })();
  }

  get(date: string): MarketHoliday | undefined {
    const row = this.db.query("SELECT date, description, open_at, close_at FROM market_holidays WHERE date = $date").get({ date }) as Row | null;
    if (!row) return undefined;
    return {
      date: row.date,
      description: row.description,
      ...(row.open_at && row.close_at ? { session: { open: new Date(row.open_at), close: new Date(row.close_at) } } : {}),
    };
  }

  /** When the list was last downloaded, and the latest date in it. */
  lastFetch(): { fetchedAt: Date; lastDate: string } | undefined {
    const row = this.db.query("SELECT MAX(fetched_at) AS fetched_at, MAX(date) AS last_date FROM market_holidays").get() as {
      fetched_at: string | null;
      last_date: string | null;
    };
    return row.fetched_at && row.last_date ? { fetchedAt: new Date(row.fetched_at), lastDate: row.last_date } : undefined;
  }
}
