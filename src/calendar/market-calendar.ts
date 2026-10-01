import type { MarketHoliday } from "../core/types";
import type { CalendarStore } from "../store/calendar-store";
import type { Logger } from "../utils/logger";
import { addDays, formatIst, istDate, istDateTime, isWeekend, MARKET_CLOSE, MARKET_OPEN } from "../utils/time";

export interface Session {
  open: Date;
  close: Date;
}

/** Re-download the holiday list after this long, or when it doesn't cover today's year yet. */
const REFRESH_AFTER_DAYS = 7;

/**
 * When the F&O market is open: regular hours on weekdays, except holidays; special sessions
 * (a Sunday budget day, Diwali muhurat) from the broker's holiday list.
 */
export class MarketCalendar {
  constructor(private readonly store: CalendarStore) {}

  /** The day's session, or undefined when the market is closed. */
  session(date: string): Session | undefined {
    const holiday = this.store.get(date);
    if (holiday) return holiday.session;
    if (isWeekend(date)) return undefined;
    return { open: istDateTime(date, MARKET_OPEN), close: istDateTime(date, MARKET_CLOSE) };
  }

  /** The holiday or special session listed for that day, if any. */
  holiday(date: string): MarketHoliday | undefined {
    return this.store.get(date);
  }

  isTradingDay(date: string): boolean {
    return this.session(date) !== undefined;
  }

  /** The first trading day after `date` (within 30 days). */
  nextTradingDay(date: string): string | undefined {
    for (let d = addDays(date, 1), i = 0; i < 30; d = addDays(d, 1), i++) if (this.isTradingDay(d)) return d;
    return undefined;
  }

  /** Whether the stored holiday list should be downloaded again. */
  needsRefresh(now: Date): boolean {
    const last = this.store.lastFetch();
    if (!last) return true;
    const ageDays = (now.getTime() - last.fetchedAt.getTime()) / 86_400_000;
    return ageDays >= REFRESH_AFTER_DAYS || last.lastDate.slice(0, 4) < istDate(now).slice(0, 4);
  }
}

/** Downloads the holiday list when it's stale; on failure keeps the previous one (or weekends only). */
export async function refreshHolidaysIfStale(
  calendar: MarketCalendar,
  store: CalendarStore,
  download: () => Promise<MarketHoliday[]>,
  logger: Logger,
  now: Date = new Date(),
): Promise<void> {
  if (!calendar.needsRefresh(now)) return;
  try {
    const holidays = await download();
    store.replaceAll(holidays, now);
    logger.info("market holidays downloaded", { count: holidays.length });
  } catch (err) {
    const last = store.lastFetch();
    logger.warn("market holiday download failed; using the previous list", {
      error: String(err),
      ...(last ? { downloadedAt: formatIst(last.fetchedAt) + " IST" } : { fallback: "weekends only" }),
    });
  }
}
