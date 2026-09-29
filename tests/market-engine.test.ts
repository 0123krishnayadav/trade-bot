import { expect, test } from "bun:test";
import type { Candle, MarketData, SubscriptionMode, Tick, Timeframe } from "../src/core/types";
import { MarketEngine } from "../src/engine/market-engine";
import { createLogger } from "../src/utils/logger";
import { istDateTime } from "../src/utils/time";

const DAY = "2026-10-05";
const at = (hhmm: string, sec = 0) => new Date(istDateTime(DAY, hhmm).getTime() + sec * 1000);

/** MarketData whose ticks, connection and history are driven by the test. */
class FakeMarketData implements MarketData {
  subscribed = new Map<string, SubscriptionMode>();
  calls: string[] = [];
  history: Candle[] = [];
  historyRequests: { key: string; tf: Timeframe; from: string; to: string }[] = [];
  failHistory = false;
  private tickHandler?: (t: Tick) => void;
  private connHandler?: (c: boolean) => void;

  async connect() {
    this.calls.push("connect");
    this.connHandler?.(true);
  }
  disconnect() {
    this.calls.push("disconnect");
  }
  subscribe(keys: string[], mode: SubscriptionMode = "ltp") {
    this.calls.push(`sub ${mode} ${keys.join(",")}`);
    for (const k of keys) this.subscribed.set(k, mode);
  }
  unsubscribe(keys: string[]) {
    this.calls.push(`unsub ${keys.join(",")}`);
    for (const k of keys) this.subscribed.delete(k);
  }
  onTick(h: (t: Tick) => void) {
    this.tickHandler = h;
  }
  onConnectionChange(h: (c: boolean) => void) {
    this.connHandler = h;
  }
  async getCandles(key: string, tf: Timeframe, from: string, to: string) {
    this.historyRequests.push({ key, tf, from, to });
    if (this.failHistory) throw new Error("history API down");
    return this.history.filter((c) => c.instrumentKey === key && c.timeframe === tf);
  }
  tick(key: string, ltp: number, time: Date, extra: Partial<Tick> = {}) {
    this.tickHandler?.({ instrumentKey: key, ltp, time, prevClose: 0, ...extra });
  }
  setConnected(c: boolean) {
    this.connHandler?.(c);
  }
}

const candle = (key: string, tf: Timeframe, time: Date, close: number): Candle => ({
  instrumentKey: key,
  timeframe: tf,
  time,
  open: close,
  high: close,
  low: close,
  close,
  volume: 0,
  oi: 0,
});

function setup(now = at("10:02")) {
  const md = new FakeMarketData();
  let clock = now;
  const quiet = createLogger({ level: "error", format: "pretty", write: () => {} });
  const engine = new MarketEngine(md, { now: () => clock, logger: quiet, clockIntervalMs: 60_000 });
  return { md, engine, setNow: (d: Date) => (clock = d) };
}

// ---------- Subscriptions ----------

test("shares subscriptions between owners and unsubscribes when the last one leaves", () => {
  const { md, engine } = setup();
  engine.subscribe("strategy-a", ["NIFTY"], "ltp");
  engine.subscribe("strategy-b", ["NIFTY"], "ltp");
  expect(md.calls).toEqual(["sub ltp NIFTY"]);
  engine.unsubscribe("strategy-a");
  expect(md.subscribed.has("NIFTY")).toBe(true);
  engine.unsubscribe("strategy-b", ["NIFTY"]);
  expect(md.calls).toEqual(["sub ltp NIFTY", "unsub NIFTY"]);
});

test("uses the richest mode any owner asked for, and steps back down", () => {
  const { md, engine } = setup();
  engine.subscribe("a", ["OPT"], "ltp");
  engine.subscribe("b", ["OPT"], "greeks");
  engine.subscribe("c", ["OPT"], "ltp");
  expect(md.subscribed.get("OPT")).toBe("greeks");
  engine.unsubscribe("b");
  expect(md.subscribed.get("OPT")).toBe("ltp");
  expect(md.calls).toEqual(["sub ltp OPT", "unsub OPT", "sub greeks OPT", "unsub OPT", "sub ltp OPT"]);
});

// ---------- Prices ----------

test("keeps the latest tick per instrument and notifies per-instrument handlers", () => {
  const { md, engine } = setup();
  const seen: number[] = [];
  const stop = engine.onTick("NIFTY", (t) => seen.push(t.ltp));
  engine.onTick("NIFTY", () => {
    throw new Error("buggy strategy");
  });
  md.tick("NIFTY", 25000, at("10:00"), { oi: 0 });
  md.tick("BANKNIFTY", 55000, at("10:00"));
  md.tick("NIFTY", 25010, at("10:00", 1));
  expect(engine.ltp("NIFTY")).toBe(25010);
  expect(engine.lastTick("BANKNIFTY")?.ltp).toBe(55000);
  expect(engine.ltp("UNKNOWN")).toBeUndefined();
  expect(seen).toEqual([25000, 25010]); // other instrument's ticks and the throwing handler didn't interfere
  stop();
  md.tick("NIFTY", 25020, at("10:00", 2));
  expect(seen).toEqual([25000, 25010]);
});

// ---------- Candles ----------

test("loads history on first use and subscribes for live candles", async () => {
  const { md, engine } = setup();
  md.history = [at("09:45"), at("09:50"), at("09:55"), at("10:00")].map((t, i) => candle("NIFTY", "5m", t, 100 + i));
  const candles = await engine.candles("NIFTY", "5m", 2);
  expect(candles.map((c) => c.close)).toEqual([101, 102]); // 10:00 candle is still forming at 10:02
  expect(engine.formingCandle("NIFTY", "5m")?.close).toBe(103);
  expect(md.subscribed.get("NIFTY")).toBe("full");
  expect(md.historyRequests[0]!.to).toBe(DAY);
  expect(md.historyRequests[0]!.from < DAY).toBe(true);

  await engine.candles("NIFTY", "5m", 2); // already loaded: no new request
  expect(md.historyRequests).toHaveLength(1);
  await engine.candles("NIFTY", "5m", 500); // more than before: reload with a longer range
  expect(md.historyRequests).toHaveLength(2);
  expect(md.historyRequests[1]!.from < md.historyRequests[0]!.from).toBe(true);
});

test("emits completed candles from ticks and from the clock", async () => {
  const { md, engine } = setup(at("10:00"));
  const closed: string[] = [];
  engine.onCandleClose("NIFTY", "1m", (c) => closed.push(`${c.time.toISOString()} ${c.close}`));
  md.tick("NIFTY", 100, at("10:00", 5));
  md.tick("NIFTY", 101, at("10:00", 40));
  md.tick("NIFTY", 102, at("10:01", 2)); // completes 10:00
  engine.processTime(at("10:01", 59));
  engine.processTime(at("10:02")); // completes 10:01 with no further tick
  expect(closed).toEqual([`${at("10:00").toISOString()} 101`, `${at("10:01").toISOString()} 102`]);
});

test("several timeframes for one instrument are built from the same ticks", async () => {
  const { md, engine } = setup(at("10:00"));
  const closed: string[] = [];
  engine.onCandleClose("NIFTY", "1m", (c) => closed.push(`1m ${c.close}`));
  engine.onCandleClose("NIFTY", "5m", (c) => closed.push(`5m ${c.close}`));
  for (let m = 0; m < 5; m++) md.tick("NIFTY", 100 + m, at(`10:0${m}`, 30));
  md.tick("NIFTY", 200, at("10:05", 1));
  expect(closed).toEqual(["1m 100", "1m 101", "1m 102", "1m 103", "1m 104", "5m 104"]);
});

test("a failed history load started by onCandleClose doesn't become an unhandled rejection", async () => {
  const { md, engine } = setup();
  md.failHistory = true;
  const unhandled: unknown[] = [];
  const onUnhandled = (err: unknown) => unhandled.push(err);
  process.on("unhandledRejection", onUnhandled);
  engine.onCandleClose("NIFTY", "5m", () => {}); // starts a history load nobody awaits
  await Bun.sleep(10);
  process.off("unhandledRejection", onUnhandled);
  expect(unhandled).toEqual([]);
  md.failHistory = false;
  md.history = [candle("NIFTY", "5m", at("09:55"), 1)];
  expect((await engine.candles("NIFTY", "5m", 10)).map((c) => c.close)).toEqual([1]); // and it's retried
});

test("a failed history load is retried on the next call", async () => {
  const { md, engine } = setup();
  md.failHistory = true;
  expect(engine.candles("NIFTY", "5m", 10)).rejects.toThrow("history API down");
  await Bun.sleep(1);
  md.failHistory = false;
  md.history = [candle("NIFTY", "5m", at("09:55"), 1)];
  expect((await engine.candles("NIFTY", "5m", 10)).map((c) => c.close)).toEqual([1]);
});

test("reports connection state and refills candles missed while disconnected", async () => {
  const { md, engine, setNow } = setup(at("10:00"));
  await engine.start();
  expect(engine.connected).toBe(true);
  await engine.candles("NIFTY", "1m", 5);
  md.tick("NIFTY", 100, at("10:00", 10));

  md.setConnected(false);
  expect(engine.connected).toBe(false);
  setNow(at("10:04", 5));
  md.history = [at("10:00"), at("10:01"), at("10:02"), at("10:03")].map((t, i) => candle("NIFTY", "1m", t, 100 + i));
  md.setConnected(true);
  await Bun.sleep(1);

  expect(engine.connected).toBe(true);
  expect(md.historyRequests.at(-1)).toMatchObject({ key: "NIFTY", tf: "1m", from: DAY, to: DAY });
  expect((await engine.candles("NIFTY", "1m", 5)).map((c) => c.close)).toEqual([100, 101, 102, 103]);
  engine.stop();
  expect(md.calls.at(-1)).toBe("disconnect");
});
