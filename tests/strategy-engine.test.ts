import { expect, test } from "bun:test";
import type { Broker, Order, PlaceOrderResult, Tick } from "../src/core/types";
import type { Strategy, StrategyContext } from "../src/engine/strategy";
import { StrategyEngine } from "../src/engine/strategy-engine";
import { MarketEngine } from "../src/engine/market-engine";
import { migrate, openDatabase } from "../src/store/database";
import { migrations } from "../src/store/migrations";
import { InstrumentStore } from "../src/store/instrument-store";
import { TradingStore } from "../src/store/trading-store";
import { createLogger } from "../src/utils/logger";
import { FakeMarketData, NIFTY } from "./trading-harness";

/** Broker whose order updates the test sends by hand. */
class ManualBroker implements Partial<Broker> {
  readonly name = "manual";
  handler?: (o: Order) => void;
  placed: string[] = [];
  beforeReturn?: (id: string) => void;
  async start() {}
  close() {}
  onOrderUpdate(h: (o: Order) => void) {
    this.handler = h;
  }
  onPositionUpdate() {}
  async placeOrder(): Promise<PlaceOrderResult> {
    const id = `O${this.placed.length + 1}`;
    this.placed.push(id);
    this.beforeReturn?.(id);
    return { orderIds: [id] };
  }
  update(id: string, status: Order["status"], tag = "test") {
    this.handler?.({
      id,
      instrumentKey: NIFTY,
      symbol: "NIFTY",
      side: "BUY",
      type: "MARKET",
      product: "MIS",
      validity: "DAY",
      quantity: 1,
      price: 0,
      triggerPrice: 0,
      status,
      filledQuantity: status === "FILLED" ? 1 : 0,
      pendingQuantity: status === "FILLED" ? 0 : 1,
      averagePrice: 0,
      placedAt: new Date(),
      tag,
    });
  }
}

function setup() {
  const db = openDatabase(":memory:");
  migrate(db, migrations);
  const logs: string[] = [];
  const logger = createLogger({ level: "debug", format: "pretty", write: (l) => logs.push(l) });
  const md = new FakeMarketData();
  const market = new MarketEngine(md, { logger });
  const broker = new ManualBroker();
  const engine = new StrategyEngine({
    market,
    broker: broker as unknown as Broker,
    instruments: new InstrumentStore(db, "manual"),
    store: new TradingStore(db, "paper"),
    mode: "paper",
    logger,
    clockIntervalMs: 3_600_000,
  });
  const tick = (ltp: number): Tick => ({ instrumentKey: NIFTY, ltp, time: new Date(), prevClose: 0 });
  return { md, market, broker, engine, logs, db, push: (ltp: number) => md.push(tick(ltp)) };
}

test("handles one event at a time and skips to the newest tick when behind", async () => {
  const { engine, push } = setup();
  const seen: number[] = [];
  let running = 0;
  let maxConcurrent = 0;
  const strategy: Strategy = {
    id: "test",
    start: (ctx) => ctx.subscribe([NIFTY]),
    async onTick(t) {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      seen.push(t.ltp);
      await Bun.sleep(20); // slow handler
      running--;
    },
  };
  engine.add(strategy);
  await engine.start();
  push(1);
  await Bun.sleep(5); // 1 is now being handled
  push(2); // queued behind 1
  push(3); // replaces 2 while it's still waiting
  push(4); // replaces 3
  await Bun.sleep(80);
  expect(seen).toEqual([1, 4]);
  expect(maxConcurrent).toBe(1);
});

test("a throwing handler is logged and the strategy keeps running", async () => {
  const { engine, push, logs } = setup();
  const seen: number[] = [];
  engine.add({
    id: "test",
    start: (ctx) => ctx.subscribe([NIFTY]),
    onTick(t) {
      if (t.ltp === 1) throw new Error("bug");
      seen.push(t.ltp);
    },
  });
  await engine.start();
  push(1);
  await Bun.sleep(5);
  push(2);
  await Bun.sleep(5);
  expect(seen).toEqual([2]);
  expect(logs.some((l) => l.includes("strategy handler failed") && l.includes("bug"))).toBe(true);
});

test("routes order updates to the strategy that placed them, including updates that beat placeOrder", async () => {
  const { engine, broker, db } = setup();
  const got: Record<string, string[]> = { a: [], b: [] };
  let ctxA!: StrategyContext;
  const make = (id: "a" | "b"): Strategy => ({
    id,
    start: (ctx) => {
      if (id === "a") ctxA = ctx;
    },
    onOrderUpdate: (o) => void got[id]!.push(`${o.id}:${o.status}`),
  });
  engine.add(make("a"));
  engine.add(make("b"));
  await engine.start();

  broker.beforeReturn = (id) => broker.update(id, "FILLED", ""); // untagged fill before the result (like an exit order)
  await ctxA.placeOrder({ instrumentKey: NIFTY, side: "BUY", quantity: 1, type: "MARKET", product: "MIS" });
  broker.beforeReturn = undefined;
  broker.update("X", "FILLED", "b"); // routed by tag
  broker.update("Y", "FILLED", "someone"); // not ours: stored only
  await Bun.sleep(5);

  expect(got).toEqual({ a: ["O1:FILLED"], b: ["X:FILLED"] });
  const stored = db.query("SELECT id, strategy_id FROM orders ORDER BY id").all();
  expect(stored).toEqual([
    { id: "O1", strategy_id: "a" },
    { id: "X", strategy_id: "b" },
    { id: "Y", strategy_id: null },
  ]);
});

test("waitForOrders resolves on final states, or with the latest state after the timeout", async () => {
  const { engine, broker } = setup();
  let ctx!: StrategyContext;
  engine.add({ id: "test", start: (c) => void (ctx = c) });
  await engine.start();
  const { orderIds } = await ctx.placeOrder({ instrumentKey: NIFTY, side: "BUY", quantity: 1, type: "MARKET", product: "MIS" });

  const waiting = ctx.waitForOrders(orderIds, 1_000);
  broker.update(orderIds[0]!, "OPEN");
  broker.update(orderIds[0]!, "FILLED");
  expect((await waiting).map((o) => o.status)).toEqual(["FILLED"]);

  const second = (await ctx.placeOrder({ instrumentKey: NIFTY, side: "BUY", quantity: 1, type: "MARKET", product: "MIS" })).orderIds;
  broker.update(second[0]!, "OPEN");
  const started = Date.now();
  expect((await ctx.waitForOrders(second, 30)).map((o) => o.status)).toEqual(["OPEN"]);
  expect(Date.now() - started).toBeGreaterThanOrEqual(25);
});

test("stop() lets queued events finish, runs the strategy's stop, and detaches it", async () => {
  const { engine, push } = setup();
  const events: string[] = [];
  engine.add({
    id: "test",
    start: (ctx) => ctx.subscribe([NIFTY]),
    async onTick(t) {
      await Bun.sleep(10);
      events.push(`tick ${t.ltp}`);
    },
    stop: () => void events.push("stop"),
  });
  await engine.start();
  push(1);
  await engine.stop();
  push(2); // after stop: ignored
  await Bun.sleep(20);
  expect(events).toEqual(["tick 1", "stop"]);
});

test("rejects ids that can't be used as order tags", () => {
  const { engine } = setup();
  expect(() => engine.add({ id: "a-very-long-strategy-name", start: () => {} })).toThrow("longer than 20");
  engine.add({ id: "dup", start: () => {} });
  expect(() => engine.add({ id: "dup", start: () => {} })).toThrow("Duplicate");
});
