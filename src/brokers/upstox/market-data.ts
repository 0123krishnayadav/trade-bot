import { UPSTOX_ENDPOINTS } from "./constants";
import type { UpstoxHttp } from "./http";
import type { CandleInterval, InstrumentKey, UpstoxCandle } from "./types";

/** [timestamp, open, high, low, close, volume, open interest] */
type RawCandle = [string, number, number, number, number, number, number];

const MAX_INTERVAL: Record<CandleInterval["unit"], number> = { minutes: 300, hours: 5, days: 1, weeks: 1, months: 1 };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Candle data. Upstox limits how much history one request may cover (e.g. about one month of
 * 1–15 minute candles, one quarter of hourly candles, ten years of daily candles); longer ranges
 * are rejected by Upstox with an explanatory error.
 */
export class UpstoxMarketDataApi {
  constructor(private readonly http: UpstoxHttp) {}

  /** Today's candles so far (the live session), oldest first. */
  async fetchTodayCandles(instrumentKey: InstrumentKey, interval: CandleInterval): Promise<UpstoxCandle[]> {
    checkInterval(interval);
    const path = `${UPSTOX_ENDPOINTS.intradayCandles}/${encodeURIComponent(instrumentKey)}/${interval.unit}/${interval.interval}`;
    return parseCandles(await this.http.call<{ candles: RawCandle[] }>("GET", path));
  }

  /** Completed candles between two IST dates (inclusive, "YYYY-MM-DD"), oldest first. Doesn't include today. */
  async fetchHistoricalCandles(
    instrumentKey: InstrumentKey,
    interval: CandleInterval,
    from: string,
    to: string,
  ): Promise<UpstoxCandle[]> {
    checkInterval(interval);
    if (!DATE.test(from) || !DATE.test(to)) throw new Error(`Dates must be YYYY-MM-DD (got ${from} to ${to})`);
    if (from > to) throw new Error(`from (${from}) is after to (${to})`);
    const path = `${UPSTOX_ENDPOINTS.historicalCandles}/${encodeURIComponent(instrumentKey)}/${interval.unit}/${interval.interval}/${to}/${from}`;
    return parseCandles(await this.http.call<{ candles: RawCandle[] }>("GET", path));
  }
}

function checkInterval({ unit, interval }: CandleInterval): void {
  const max = MAX_INTERVAL[unit];
  if (!Number.isInteger(interval) || interval < 1 || interval > max) {
    throw new Error(`Upstox ${unit} candles need an interval from 1 to ${max} (got ${interval})`);
  }
}

/** Upstox returns newest first; we return oldest first. */
function parseCandles(data: { candles?: RawCandle[] }): UpstoxCandle[] {
  return (data.candles ?? [])
    .map(([time, open, high, low, close, volume, oi]) => ({
      time: new Date(time),
      open,
      high,
      low,
      close,
      volume,
      oi: oi ?? 0,
    }))
    .sort((a, b) => a.time.getTime() - b.time.getTime());
}
