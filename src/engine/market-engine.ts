import type { Candle, MarketData, SubscriptionMode, Tick, Timeframe } from "../core/types";
import type { Logger } from "../utils/logger";
import { addDays, istDate } from "../utils/time";
import { CandleSeries, NSE_SESSION, timeframeMinutes, type Session } from "./candle-series";

export interface MarketEngineOptions {
  logger?: Logger;
  now?: () => Date;
  session?: Session;
  /** Completed candles kept in memory per instrument and timeframe. */
  maxCandles?: number;
  /** How often to check for candles whose time is up (ms). */
  clockIntervalMs?: number;
}

/** "full" includes everything "greeks" has, which includes everything "ltp" has. */
const MODE_RANK: Record<SubscriptionMode, number> = { ltp: 0, greeks: 1, full: 2 };

/** Owner name used for subscriptions the engine makes itself to build candles. */
const CANDLES_OWNER = "market-engine:candles";

type Unsubscribe = () => void;

/**
 * Broker-agnostic market data hub for all strategies. One feed connection; subscriptions shared
 * and reference-counted by owner; latest tick per instrument; candles per instrument and
 * timeframe, loaded from history once and then built live from ticks.
 */
export class MarketEngine {
  private readonly now: () => Date;
  private readonly session: Session;
  /** instrumentKey -> owner -> mode */
  private readonly subscriptions = new Map<string, Map<string, SubscriptionMode>>();
  /** instrumentKey -> mode currently subscribed at the broker */
  private readonly subscribedMode = new Map<string, SubscriptionMode>();
  private readonly lastTicks = new Map<string, Tick>();
  private readonly tickHandlers = new Map<string, Set<(tick: Tick) => void>>();
  private readonly series = new Map<string, CandleSeries>();
  /** instrumentKey -> its candle series, one per timeframe */
  private readonly seriesByKey = new Map<string, CandleSeries[]>();
  private readonly seriesReady = new Map<string, Promise<void>>();
  /** Most candles requested so far per series; history is reloaded only when more are asked for. */
  private readonly historyRequested = new Map<string, number>();
  private readonly candleHandlers = new Map<string, Set<(candle: Candle) => void>>();
  private clock?: ReturnType<typeof setInterval>;
  private disconnectedAt?: Date;
  private isConnected = false;

  constructor(
    private readonly market: MarketData,
    private readonly opts: MarketEngineOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.session = opts.session ?? NSE_SESSION;
    market.onTick((tick) => this.handleTick(tick));
    market.onConnectionChange((connected) => this.handleConnection(connected));
  }

  async start(): Promise<void> {
    await this.market.connect();
    this.clock ??= setInterval(() => this.processTime(this.now()), this.opts.clockIntervalMs ?? 1000);
  }

  stop(): void {
    clearInterval(this.clock);
    this.clock = undefined;
    this.market.disconnect();
  }

  /** Whether the live feed is up. While it's down, ltp() and candles may be out of date. */
  get connected(): boolean {
    return this.isConnected;
  }

  // ---------- Subscriptions ----------

  /**
   * Starts live data for `instrumentKeys` on behalf of `owner` (e.g. a strategy id). An instrument
   * stays subscribed while any owner wants it, in the richest mode any owner asked for.
   */
  subscribe(owner: string, instrumentKeys: string[], mode: SubscriptionMode = "ltp"): void {
    for (const key of instrumentKeys) {
      const owners = this.subscriptions.get(key) ?? new Map<string, SubscriptionMode>();
      owners.set(owner, mode);
      this.subscriptions.set(key, owners);
    }
    this.syncBroker(instrumentKeys);
  }

  /** Stops `owner`'s interest in these instruments (all of its instruments when omitted). */
  unsubscribe(owner: string, instrumentKeys?: string[]): void {
    const keys = instrumentKeys ?? [...this.subscriptions].filter(([, owners]) => owners.has(owner)).map(([key]) => key);
    for (const key of keys) {
      const owners = this.subscriptions.get(key);
      owners?.delete(owner);
      if (owners?.size === 0) this.subscriptions.delete(key);
    }
    this.syncBroker(keys);
  }

  // ---------- Prices ----------

  ltp(instrumentKey: string): number | undefined {
    return this.lastTicks.get(instrumentKey)?.ltp;
  }

  /** The latest full tick (OI, IV, greeks, bid/ask depending on subscription mode). */
  lastTick(instrumentKey: string): Tick | undefined {
    return this.lastTicks.get(instrumentKey);
  }

  onTick(instrumentKey: string, handler: (tick: Tick) => void): Unsubscribe {
    return addHandler(this.tickHandlers, instrumentKey, handler);
  }

  // ---------- Candles ----------

  /**
   * The last `count` completed candles, oldest first. The first call for an instrument and
   * timeframe loads history from the broker and subscribes to live ticks to keep it current.
   */
  async candles(instrumentKey: string, timeframe: Timeframe, count: number): Promise<Candle[]> {
    const series = this.ensureSeries(instrumentKey, timeframe, count);
    await this.seriesReady.get(seriesId(instrumentKey, timeframe));
    return series.candles(count);
  }

  /** The candle still forming from live ticks, if any. */
  formingCandle(instrumentKey: string, timeframe: Timeframe): Candle | undefined {
    return this.series.get(seriesId(instrumentKey, timeframe))?.forming();
  }

  /** Called with each completed candle, at its close time. Starts live candles for the instrument if needed. */
  onCandleClose(instrumentKey: string, timeframe: Timeframe, handler: (candle: Candle) => void): Unsubscribe {
    this.ensureSeries(instrumentKey, timeframe, 0);
    return addHandler(this.candleHandlers, seriesId(instrumentKey, timeframe), handler);
  }

  /** Completes candles whose end time has passed. Runs every second after start(); exposed for tests and replays. */
  processTime(now: Date): void {
    for (const series of this.series.values()) {
      for (const candle of series.closeDue(now)) this.emitCandle(candle);
    }
  }

  // ---------- Internals ----------

  private handleTick(tick: Tick): void {
    this.lastTicks.set(tick.instrumentKey, tick);
    for (const series of this.seriesByKey.get(tick.instrumentKey) ?? []) {
      for (const candle of series.applyTick(tick)) this.emitCandle(candle);
    }
    for (const handler of this.tickHandlers.get(tick.instrumentKey) ?? []) this.safely("tick handler", () => handler(tick));
  }

  private emitCandle(candle: Candle): void {
    for (const handler of this.candleHandlers.get(seriesId(candle.instrumentKey, candle.timeframe)) ?? []) {
      this.safely("candle handler", () => handler(candle));
    }
  }

  private handleConnection(connected: boolean): void {
    this.isConnected = connected;
    if (!connected) {
      this.disconnectedAt ??= this.now();
      this.opts.logger?.warn("market data disconnected; prices may be stale until it reconnects");
      return;
    }
    const gapStart = this.disconnectedAt;
    this.disconnectedAt = undefined;
    if (gapStart) void this.refillAfterGap(gapStart);
  }

  /** Candles that closed while the feed was down are fetched from history so series have no holes. */
  private async refillAfterGap(since: Date): Promise<void> {
    const from = istDate(since);
    const to = istDate(this.now());
    for (const series of this.series.values()) {
      try {
        const history = await this.market.getCandles(series.instrumentKey, series.timeframe, from, to);
        for (const candle of series.closeDue(this.now())) this.emitCandle(candle);
        series.mergeHistory(history, this.now());
      } catch (err) {
        this.opts.logger?.warn("could not refill candles after reconnect", { instrumentKey: series.instrumentKey, error: String(err) });
      }
    }
    this.opts.logger?.info("candles refilled after reconnect", { series: this.series.size });
  }

  private ensureSeries(instrumentKey: string, timeframe: Timeframe, count: number): CandleSeries {
    const id = seriesId(instrumentKey, timeframe);
    let series = this.series.get(id);
    if (!series) {
      series = new CandleSeries(instrumentKey, timeframe, Math.max(this.opts.maxCandles ?? 1000, count), this.session);
      this.series.set(id, series);
      this.seriesByKey.set(instrumentKey, [...(this.seriesByKey.get(instrumentKey) ?? []), series]);
      // Live ticks keep candles current; "full" carries volume and OI.
      this.subscribe(CANDLES_OWNER, [instrumentKey], "full");
    }
    const needed = Math.max(count, 1);
    if (!this.seriesReady.has(id) || needed > (this.historyRequested.get(id) ?? 0)) {
      this.historyRequested.set(id, needed);
      const load = this.loadHistory(series, needed).catch((err) => {
        this.seriesReady.delete(id); // retry on the next call
        this.historyRequested.delete(id);
        throw err;
      });
      this.seriesReady.set(id, load);
    }
    return series;
  }

  private async loadHistory(series: CandleSeries, count: number): Promise<void> {
    const today = istDate(this.now());
    const tradingDays = Math.ceil((count * timeframeMinutes(series.timeframe)) / 375) + 1;
    const from = addDays(today, -Math.ceil(tradingDays * 1.5) - 5); // weekends and holidays
    const history = await this.market.getCandles(series.instrumentKey, series.timeframe, from, today);
    series.mergeHistory(history, this.now());
    this.opts.logger?.debug("candle history loaded", { instrumentKey: series.instrumentKey, timeframe: series.timeframe, candles: history.length });
  }

  private syncBroker(instrumentKeys: string[]): void {
    const toUnsubscribe: string[] = [];
    const toSubscribe = new Map<SubscriptionMode, string[]>();
    for (const key of new Set(instrumentKeys)) {
      const owners = this.subscriptions.get(key);
      const current = this.subscribedMode.get(key);
      if (!owners) {
        if (current) {
          toUnsubscribe.push(key);
          this.subscribedMode.delete(key);
        }
        continue;
      }
      const wanted = [...owners.values()].reduce((a, b) => (MODE_RANK[b] > MODE_RANK[a] ? b : a));
      if (wanted === current) continue;
      if (current) toUnsubscribe.push(key); // mode change: resubscribe in the new mode
      toSubscribe.set(wanted, [...(toSubscribe.get(wanted) ?? []), key]);
      this.subscribedMode.set(key, wanted);
    }
    if (toUnsubscribe.length) this.market.unsubscribe(toUnsubscribe);
    for (const [mode, keys] of toSubscribe) this.market.subscribe(keys, mode);
  }

  private safely(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.opts.logger?.error(`${what} failed`, { error: String(err) });
    }
  }
}

function seriesId(instrumentKey: string, timeframe: Timeframe): string {
  return `${instrumentKey}@${timeframe}`;
}

function addHandler<T>(map: Map<string, Set<(value: T) => void>>, key: string, handler: (value: T) => void): Unsubscribe {
  const handlers = map.get(key) ?? new Set();
  handlers.add(handler);
  map.set(key, handlers);
  return () => handlers.delete(handler);
}
