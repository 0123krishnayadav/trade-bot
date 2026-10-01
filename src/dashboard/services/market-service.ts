import type { Database } from "bun:sqlite";
import { MarketCalendar } from "../../calendar/market-calendar";
import { CalendarStore } from "../../store/calendar-store";
import { InstrumentStore } from "../../store/instrument-store";
import { ScripStore } from "../../store/scrip-store";
import { istDate, istDateTime, isWeekend, MARKET_CLOSE, MARKET_OPEN } from "../../utils/time";
import type { MarketResponse } from "../api/types";

/** The market strip: index price (from `scrips`), today's session, upcoming holidays, bot heartbeat. */
export class MarketService {
  constructor(
    private readonly db: Database,
    private readonly opts: { broker: string; underlying: string; now?: () => Date },
  ) {}

  market(): MarketResponse {
    const now = this.opts.now?.() ?? new Date();
    const today = istDate(now);
    // Only trust the calendar once the holiday list was downloaded; until then weekdays count as open.
    const store = this.hasTable("market_holidays") ? new CalendarStore(this.db) : undefined;
    const hasHolidays = store?.lastFetch() !== undefined;
    const calendar = hasHolidays ? new MarketCalendar(store!) : undefined;
    // Without the bot's holiday table yet: regular hours on weekdays.
    const session =
      calendar ? calendar.session(today) : isWeekend(today) ? undefined : { open: istDateTime(today, MARKET_OPEN), close: istDateTime(today, MARKET_CLOSE) };
    const holiday = calendar?.holiday(today);
    const status = !session || now >= session.close ? "closed" : now < session.open ? "pre-open" : "open";

    return {
      ...this.index(),
      today: {
        date: today,
        status,
        ...(session ? { session: { open: session.open.toISOString(), close: session.close.toISOString() } } : {}),
        ...(holiday ? { note: holiday.description } : {}),
      },
      ...(calendar?.nextTradingDay(today) ? { nextTradingDay: calendar.nextTradingDay(today) } : {}),
      holidaysMissing: !hasHolidays,
      upcoming: hasHolidays ? this.upcoming(today) : [],
      ...this.heartbeat(),
    };
  }

  private index(): Pick<MarketResponse, "index"> {
    if (!this.hasTable("scrips")) return {};
    const instrument = new InstrumentStore(this.db, this.opts.broker).findIndex(this.opts.underlying);
    if (!instrument) return {};
    const scrip = new ScripStore(this.db).get([instrument.key]).get(instrument.key);
    if (!scrip) return {};
    const change = scrip.ltp - scrip.cp;
    return {
      index: {
        symbol: instrument.name || instrument.symbol,
        ltp: scrip.ltp,
        cp: scrip.cp,
        change: Math.round(change * 100) / 100,
        changePct: scrip.cp ? Math.round((change / scrip.cp) * 10_000) / 100 : 0,
        updatedAt: scrip.updatedAt.toISOString(),
      },
    };
  }

  private upcoming(today: string): MarketResponse["upcoming"] {
    const rows = this.db
      .query("SELECT date, description, open_at FROM market_holidays WHERE date > $today ORDER BY date LIMIT 3")
      .all({ today }) as { date: string; description: string; open_at: string | null }[];
    return rows.map((r) => ({ date: r.date, description: r.description, special: r.open_at !== null }));
  }

  private heartbeat(): Pick<MarketResponse, "pricesUpdatedAt"> {
    if (!this.hasTable("scrips")) return {};
    const row = this.db.query("SELECT MAX(updated_at) AS at FROM scrips").get() as { at: string | null };
    return row.at ? { pricesUpdatedAt: row.at } : {};
  }

  private hasTable(name: string): boolean {
    return this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = $name").get({ name }) !== null;
  }
}
