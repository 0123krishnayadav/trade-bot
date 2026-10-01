// A full trading stack on fake market data: MarketEngine + StrategyEngine + PaperBroker + SQLite.
import type { Candle, Instrument, MarketData, SubscriptionMode, Tick, Timeframe } from "../src/core/types";
import { MarketEngine } from "../src/engine/market-engine";
import { StrategyEngine } from "../src/engine/strategy-engine";
import type { Strategy } from "../src/engine/strategy";
import { PaperBroker } from "../src/brokers/paper/paper-broker";
import { migrate, openDatabase } from "../src/store/database";
import { migrations } from "../src/store/migrations";
import { InstrumentStore } from "../src/store/instrument-store";
import { TradingStore } from "../src/store/trading-store";
import { createLogger, type LogLevel } from "../src/utils/logger";
import { istDateTime } from "../src/utils/time";
import { RiskManager, type RiskLimits } from "../src/risk/risk-manager";
import type { Notifier } from "../src/alerts/notifier";

export class FakeMarketData implements MarketData {
  private tickHandler?: (t: Tick) => void;
  async connect() {}
  disconnect() {}
  subscribe(_keys: string[], _mode?: SubscriptionMode) {}
  unsubscribe(_keys: string[]) {}
  onTick(h: (t: Tick) => void) {
    this.tickHandler = h;
  }
  onConnectionChange() {}
  async getCandles(_key: string, _tf: Timeframe): Promise<Candle[]> {
    return [];
  }
  push(tick: Tick) {
    this.tickHandler?.(tick);
  }
}

export const NIFTY = "NSE_INDEX|Nifty 50";
export const EXPIRY = "2026-10-06";
const option = (strike: number, type: "CE" | "PE", expiry = EXPIRY): Instrument => ({
  key: `NSE_FO|${strike}${type}${expiry}`,
  exchange: "NSE",
  segment: "NSE_FO",
  kind: "option",
  symbol: `NIFTY ${strike} ${type} ${expiry}`,
  name: "NIFTY",
  underlying: "NIFTY",
  underlyingKey: NIFTY,
  expiry,
  strike,
  optionType: type,
  lotSize: 65,
  tickSize: 0.05,
});
export const key = (strike: number, type: "CE" | "PE", expiry = EXPIRY) => option(strike, type, expiry).key;

const INSTRUMENTS: Instrument[] = [
  { key: NIFTY, exchange: "NSE", segment: "NSE_INDEX", kind: "index", symbol: "NIFTY", name: "Nifty 50", lotSize: 1, tickSize: 0.05 },
  ...[22300, 22700, 23100].flatMap((s) => [option(s, "CE"), option(s, "PE"), option(s, "CE", "2026-10-13"), option(s, "PE", "2026-10-13")]),
];

export function tradingHarness(
  opts: { mode?: "paper" | "live"; date?: string; logLevel?: LogLevel; db?: ReturnType<typeof openDatabase>; risk?: RiskLimits; notifier?: Notifier } = {},
) {
  const date = opts.date ?? "2026-10-05";
  let now = istDateTime(date, "09:00");
  const db = opts.db ?? openDatabase(":memory:");
  migrate(db, migrations);
  const instruments = new InstrumentStore(db, "paper");
  instruments.replaceAll(INSTRUMENTS);
  const logs: string[] = [];
  const logger = createLogger({ level: opts.logLevel ?? "debug", format: "pretty", clock: () => now, write: (line) => logs.push(line) });
  const md = new FakeMarketData();
  const market = new MarketEngine(md, { now: () => now, logger });
  const broker = new PaperBroker(market, instruments, { capital: 500_000, now: () => now });
  const store = new TradingStore(db, opts.mode ?? "paper");
  // With limits, orders go through the risk manager like in the real bot (checked by hand via risk.check()).
  const risk = opts.risk
    ? new RiskManager(broker, { limits: opts.risk, instruments, prices: market, store, logger, notifier: opts.notifier, now: () => now, checkIntervalMs: 3_600_000 })
    : undefined;
  const engine = new StrategyEngine({
    market,
    broker: risk ?? broker,
    instruments,
    store,
    mode: opts.mode ?? "paper",
    logger,
    notifier: opts.notifier,
    now: () => now,
    clockIntervalMs: 3_600_000,
  });

  const price = (instrumentKey: string, ltp: number, spread = 0.1) =>
    md.push({ instrumentKey, ltp, time: now, prevClose: 0, bestBid: ltp - spread / 2, bestAsk: ltp + spread / 2 });

  return {
    db,
    md,
    market,
    broker,
    risk,
    store,
    engine,
    instruments,
    logs,
    at(hhmm: string) {
      now = istDateTime(date, hhmm);
    },
    /** Prices for NIFTY and the iron butterfly legs around 22700. */
    prices(p: { spot?: number; ce?: number; pe?: number; wingCe?: number; wingPe?: number; expiry?: string }) {
      const e = p.expiry ?? EXPIRY;
      if (p.spot !== undefined) md.push({ instrumentKey: NIFTY, ltp: p.spot, time: now, prevClose: 0 });
      if (p.ce !== undefined) price(key(22700, "CE", e), p.ce);
      if (p.pe !== undefined) price(key(22700, "PE", e), p.pe);
      if (p.wingCe !== undefined) price(key(23100, "CE", e), p.wingCe);
      if (p.wingPe !== undefined) price(key(22300, "PE", e), p.wingPe);
    },
    async add(strategy: Strategy) {
      engine.add(strategy);
      await engine.start();
    },
    /** Sends a clock event and waits for the strategy to finish reacting (orders fill asynchronously). */
    async clock(hhmm?: string) {
      if (hhmm) now = istDateTime(date, hhmm);
      engine.tick(now);
      await settle();
    },
  };
}

export async function settle(ms = 30) {
  await Bun.sleep(ms);
}
