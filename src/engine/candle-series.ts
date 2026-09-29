import type { Candle, Tick, Timeframe } from "../core/types";
import { istDate, istDateTime, istMinutes, parseHHMM } from "../utils/time";

const TIMEFRAME_MINUTES: Record<Timeframe, number> = { "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "1d": 375 };

export interface Session {
  /** HH:MM IST, e.g. "09:15" */
  open: string;
  /** HH:MM IST, e.g. "15:30" */
  close: string;
}

export const NSE_SESSION: Session = { open: "09:15", close: "15:30" };

export function timeframeMinutes(tf: Timeframe): number {
  return TIMEFRAME_MINUTES[tf];
}

/**
 * The candle a moment belongs to, or undefined outside the session. Intraday candles are aligned
 * to the session open (09:15, 09:20, ... for 5m; 09:15, 10:15, ... for 1h) and the last one is cut
 * short at the close. Daily candles are stamped 00:00 IST, as brokers report them.
 */
export function candleBounds(time: Date, tf: Timeframe, session: Session = NSE_SESSION): { start: Date; end: Date } | undefined {
  const minute = istMinutes(time);
  const open = parseHHMM(session.open);
  const close = parseHHMM(session.close);
  if (minute < open || minute >= close) return undefined;
  const date = istDate(time);
  const sessionClose = istDateTime(date, session.close);
  if (tf === "1d") return { start: istDateTime(date, "00:00"), end: sessionClose };
  const size = TIMEFRAME_MINUTES[tf];
  const startMinute = open + Math.floor((minute - open) / size) * size;
  const start = new Date(istDateTime(date, "00:00").getTime() + startMinute * 60_000);
  const end = new Date(Math.min(start.getTime() + size * 60_000, sessionClose.getTime()));
  return { start, end };
}

/**
 * Candles for one instrument and timeframe: completed history plus the candle being formed from
 * live ticks. Pure logic, no I/O; the MarketEngine feeds it ticks, the clock and history.
 */
export class CandleSeries {
  private readonly closed: Candle[] = [];
  private current?: Candle;
  private currentEnd?: Date;
  // Brokers send volume as a running total for the day. A candle's volume is how much that total
  // grew while the candle was forming, plus any volume history already reported for it.
  private lastVolumeTotal?: number;
  private volumeTotalAtStart?: number;
  private volumeFromHistory = 0;

  constructor(
    readonly instrumentKey: string,
    readonly timeframe: Timeframe,
    private readonly maxLength = 1000,
    private readonly session: Session = NSE_SESSION,
  ) {}

  /** Completed candles, oldest first. */
  candles(count?: number): Candle[] {
    return count === undefined ? [...this.closed] : this.closed.slice(-count);
  }

  /** The candle still being formed, if any. */
  forming(): Candle | undefined {
    return this.current ? { ...this.current } : undefined;
  }

  /**
   * Applies a tick and returns candles it completed (a tick in a later candle completes the
   * current one). Ticks outside the session or older than the current candle are ignored for
   * candles, e.g. the previous day's last trade that brokers send on connect.
   */
  applyTick(tick: Tick): Candle[] {
    const bounds = candleBounds(tick.time, this.timeframe, this.session);
    if (!bounds) return [];
    if (this.current && bounds.start < this.current.time) return [];

    const done: Candle[] = [];
    if (this.current && bounds.start > this.current.time) done.push(...this.closeCurrent());
    if (this.closed.length && bounds.start <= this.closed.at(-1)!.time) return done; // already completed

    if (!this.current) {
      this.current = {
        instrumentKey: this.instrumentKey,
        timeframe: this.timeframe,
        time: bounds.start,
        open: tick.ltp,
        high: tick.ltp,
        low: tick.ltp,
        close: tick.ltp,
        volume: 0,
        oi: tick.oi ?? 0,
      };
      this.currentEnd = bounds.end;
      this.volumeTotalAtStart = this.lastVolumeTotal;
      this.volumeFromHistory = 0;
    } else {
      this.current.high = Math.max(this.current.high, tick.ltp);
      this.current.low = Math.min(this.current.low, tick.ltp);
      this.current.close = tick.ltp;
      if (tick.oi !== undefined) this.current.oi = tick.oi;
    }

    if (tick.volume !== undefined) {
      if (this.lastVolumeTotal !== undefined && tick.volume < this.lastVolumeTotal) this.volumeTotalAtStart = 0; // new day
      this.volumeTotalAtStart ??= tick.volume; // first volume we've seen: count from here
      this.lastVolumeTotal = tick.volume;
      // The day's running total is exactly the daily candle's volume, including the pre-open
      // and closing sessions that no intraday candle covers.
      this.current.volume =
        this.timeframe === "1d" ? tick.volume : this.volumeFromHistory + Math.max(0, tick.volume - this.volumeTotalAtStart);
    }
    return done;
  }

  /** Completes the current candle once its end time has passed, even if no further tick arrives. */
  closeDue(now: Date): Candle[] {
    return this.current && this.currentEnd && now >= this.currentEnd ? this.closeCurrent() : [];
  }

  /**
   * Merges candles from the broker's history API. Completed history fills in or corrects closed
   * candles; an unfinished last candle (the current one, when loading mid-candle) seeds or
   * corrects the forming candle so its open/high/low cover the time before we started listening.
   */
  mergeHistory(history: Candle[], now: Date): void {
    // A forming candle whose time is over (e.g. the feed dropped mid-candle) is complete; history
    // below replaces it with the broker's full version.
    this.closeDue(now);
    const byTime = new Map(this.closed.map((c) => [c.time.getTime(), c]));
    for (const h of history) {
      const bounds = candleBounds(h.time, this.timeframe, this.session) ?? { start: h.time, end: endOfDaily(h.time, this.session) };
      if (this.current && h.time.getTime() === this.current.time.getTime()) {
        this.current.open = h.open;
        this.current.high = Math.max(this.current.high, h.high);
        this.current.low = Math.min(this.current.low, h.low);
        if (h.volume > this.current.volume) {
          this.volumeFromHistory += h.volume - this.current.volume;
          this.current.volume = h.volume;
        }
      } else if (bounds.end <= now) {
        if (!this.current || h.time < this.current.time) byTime.set(h.time.getTime(), { ...h });
      } else if (!this.current) {
        this.current = { ...h };
        this.currentEnd = bounds.end;
        this.volumeFromHistory = h.volume;
        this.volumeTotalAtStart = this.lastVolumeTotal;
      }
    }
    const merged = [...byTime.values()].sort((a, b) => a.time.getTime() - b.time.getTime());
    this.closed.splice(0, this.closed.length, ...merged.slice(-this.maxLength));
  }

  private closeCurrent(): Candle[] {
    const candle = this.current!;
    this.current = undefined;
    this.currentEnd = undefined;
    this.volumeTotalAtStart = this.lastVolumeTotal;
    this.volumeFromHistory = 0;
    this.closed.push(candle);
    if (this.closed.length > this.maxLength) this.closed.shift();
    return [{ ...candle }];
  }
}

function endOfDaily(time: Date, session: Session): Date {
  return istDateTime(istDate(time), session.close);
}
