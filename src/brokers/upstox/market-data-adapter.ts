import type { Candle, MarketData, SubscriptionMode, Tick, Timeframe } from "../../core/types";
import { addDays, istDate } from "../../utils/time";
import type { UpstoxMarketDataApi } from "./market-data";
import type { UpstoxMarketFeed } from "./market-feed";
import { FEED_MODES, TIMEFRAMES, toTick } from "./mappers";

/**
 * Days of history Upstox serves per request, by timeframe. Their documented limits are one month
 * for 1–15 minute candles, a quarter for longer minute/hour candles and a decade for daily ones;
 * we stay a little under each.
 */
const MAX_DAYS_PER_REQUEST: Record<Timeframe, number> = {
  "1m": 28,
  "3m": 28,
  "5m": 28,
  "15m": 28,
  "30m": 85,
  "1h": 85,
  "1d": 3600,
};

/** Upstox behind the broker-agnostic MarketData interface. */
export class UpstoxMarketData implements MarketData {
  constructor(
    private readonly api: UpstoxMarketDataApi,
    private readonly feed: UpstoxMarketFeed,
    private readonly now: () => Date = () => new Date(),
  ) {}

  connect(): Promise<void> {
    return this.feed.connect();
  }

  disconnect(): void {
    this.feed.close();
  }

  subscribe(instrumentKeys: string[], mode: SubscriptionMode = "ltp"): void {
    this.feed.subscribe(instrumentKeys, FEED_MODES[mode]);
  }

  unsubscribe(instrumentKeys: string[]): void {
    this.feed.unsubscribe(instrumentKeys);
  }

  onTick(handler: (tick: Tick) => void): void {
    this.feed.onTick((t) => handler(toTick(t)));
  }

  onConnectionChange(handler: (connected: boolean) => void): void {
    this.feed.onConnectionChange(handler);
  }

  async getCandles(instrumentKey: string, timeframe: Timeframe, from: string, to: string): Promise<Candle[]> {
    if (from > to) throw new Error(`from (${from}) is after to (${to})`);
    const interval = TIMEFRAMES[timeframe];
    const today = istDate(this.now());
    const yesterday = addDays(today, -1);
    const raw = [];

    // Completed days come from the historical API, in chunks Upstox accepts.
    const historicalTo = to < today ? to : yesterday;
    for (let start = from; start <= historicalTo; ) {
      const end = minDate(addDays(start, MAX_DAYS_PER_REQUEST[timeframe] - 1), historicalTo);
      raw.push(...(await this.api.fetchHistoricalCandles(instrumentKey, interval, start, end)));
      start = addDays(end, 1);
    }
    // Today's candles so far come from the intraday API.
    if (from <= today && to >= today) raw.push(...(await this.api.fetchTodayCandles(instrumentKey, interval)));

    const byTime = new Map<number, Candle>();
    for (const c of raw) byTime.set(c.time.getTime(), { instrumentKey, timeframe, ...c });
    return [...byTime.values()].sort((a, b) => a.time.getTime() - b.time.getTime());
  }
}

function minDate(a: string, b: string): string {
  return a < b ? a : b;
}
