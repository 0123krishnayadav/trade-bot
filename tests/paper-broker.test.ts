import { expect, test } from "bun:test";
import type { Instrument, InstrumentLookup, Order, PositionUpdate, Tick } from "../src/core/types";
import { PaperBroker, type PriceSource } from "../src/brokers/paper/paper-broker";
import { estimateCharges } from "../src/brokers/charges";

class FakePrices implements PriceSource {
  ticks = new Map<string, Tick>();
  handlers = new Map<string, Set<(t: Tick) => void>>();
  subscriptions: string[] = [];
  lastTick(key: string) {
    return this.ticks.get(key);
  }
  onTick(key: string, h: (t: Tick) => void) {
    const set = this.handlers.get(key) ?? new Set();
    set.add(h);
    this.handlers.set(key, set);
    return () => set.delete(h);
  }
  subscribe(owner: string, keys: string[]) {
    this.subscriptions.push(`${owner}:${keys.join(",")}`);
  }
  unsubscribe() {}
  set(key: string, ltp: number, bid?: number, ask?: number) {
    const tick: Tick = { instrumentKey: key, ltp, time: new Date(), prevClose: 0, ...(bid ? { bestBid: bid } : {}), ...(ask ? { bestAsk: ask } : {}) };
    this.ticks.set(key, tick);
    for (const h of [...(this.handlers.get(key) ?? [])]) h(tick);
  }
}

const OPT: Instrument = { key: "NSE_FO|1", exchange: "NSE", segment: "NSE_FO", kind: "option", symbol: "NIFTY 22700 CE", name: "NIFTY", lotSize: 65, tickSize: 0.05 };
const OPT2: Instrument = { ...OPT, key: "NSE_FO|2", symbol: "NIFTY 22700 PE" };
const EQ: Instrument = { key: "NSE_EQ|R", exchange: "NSE", segment: "NSE_EQ", kind: "equity", symbol: "RELIANCE", name: "RELIANCE", lotSize: 1, tickSize: 0.1 };
const all = [OPT, OPT2, EQ];
const lookup = { get: (k: string) => all.find((i) => i.key === k) } as InstrumentLookup;

function setup() {
  const prices = new FakePrices();
  const broker = new PaperBroker(prices, lookup, { capital: 500_000 });
  const updates: Order[] = [];
  const positions: PositionUpdate[] = [];
  broker.onOrderUpdate((o) => updates.push(o));
  broker.onPositionUpdate((p) => positions.push(p));
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { prices, broker, updates, positions, flush, statuses: () => updates.map((o) => `${o.id.split("-").pop()}:${o.status}`) };
}

const buy = { instrumentKey: OPT.key, side: "BUY" as const, quantity: 65, type: "MARKET" as const, product: "MIS" as const };

test("MARKET orders fill at the ask (buy) and bid (sell), after placeOrder returns", async () => {
  const { prices, broker, updates, flush } = setup();
  prices.set(OPT.key, 219.5, 219.0, 220.0);
  const { orderIds } = await broker.placeOrder(buy);
  expect(updates).toHaveLength(0); // result first, updates after
  await flush();
  expect(updates.map((o) => o.status)).toEqual(["OPEN", "FILLED"]);
  expect(updates.at(-1)).toMatchObject({ id: orderIds[0], averagePrice: 220, filledQuantity: 65, pendingQuantity: 0 });

  await broker.placeOrder({ ...buy, side: "SELL" });
  await flush();
  expect(updates.at(-1)!.averagePrice).toBe(219);
});

test("without bid/ask, MARKET fills at last price plus a tick of slippage", async () => {
  const { prices, broker, updates, flush } = setup();
  prices.set(OPT.key, 100);
  await broker.placeOrder(buy);
  await broker.placeOrder({ ...buy, side: "SELL" });
  await flush();
  expect(updates.filter((o) => o.status === "FILLED").map((o) => o.averagePrice)).toEqual([100.05, 99.95]);
});

test("MARKET with no price at all is rejected", async () => {
  const { broker, updates, flush } = setup();
  await broker.placeOrder(buy);
  await flush();
  expect(updates.at(-1)).toMatchObject({ status: "REJECTED", statusMessage: "no market price available for a paper fill" });
});

test("LIMIT rests until the market reaches it, then fills at the better of limit and market", async () => {
  const { prices, broker, statuses, updates, flush } = setup();
  prices.set(OPT.key, 105, 104.9, 105.1);
  await broker.placeOrder({ ...buy, type: "LIMIT", price: 100 });
  await flush();
  expect(statuses()).toEqual(["1:OPEN"]);
  prices.set(OPT.key, 101, 100.9, 101.1);
  expect(statuses()).toEqual(["1:OPEN"]);
  prices.set(OPT.key, 99, 98.9, 99.1); // gapped through
  expect(statuses()).toEqual(["1:OPEN", "1:FILLED"]);
  expect(updates.at(-1)!.averagePrice).toBe(99.1);
});

test("SL-M triggers on the last price and fills like a market order", async () => {
  const { prices, broker, statuses, updates, flush } = setup();
  prices.set(OPT.key, 150, 149.9, 150.1);
  await broker.placeOrder({ ...buy, type: "SL-M", triggerPrice: 160 }); // stop-loss on a short
  await flush();
  expect(statuses()).toEqual(["1:TRIGGER_PENDING"]);
  prices.set(OPT.key, 159, 158.9, 159.1);
  prices.set(OPT.key, 161, 160.9, 161.1);
  expect(statuses()).toEqual(["1:TRIGGER_PENDING", "1:OPEN", "1:FILLED"]);
  expect(updates.at(-1)!.averagePrice).toBe(161.1);
});

test("SL becomes a limit order once triggered", async () => {
  const { prices, broker, statuses, flush } = setup();
  prices.set(OPT.key, 150);
  await broker.placeOrder({ ...buy, side: "SELL", type: "SL", triggerPrice: 140, price: 139 });
  await flush();
  prices.set(OPT.key, 139.5, 138, 140); // triggered, but bid 138 is below the 139 limit
  expect(statuses()).toEqual(["1:TRIGGER_PENDING", "1:OPEN"]);
  prices.set(OPT.key, 139.5, 139.5, 140);
  expect(statuses().at(-1)).toBe("1:FILLED");
});

test("cancel and modify resting orders; final orders can't be changed", async () => {
  const { prices, broker, statuses, updates, flush } = setup();
  prices.set(OPT.key, 105, 104.9, 105.1);
  const a = (await broker.placeOrder({ ...buy, type: "LIMIT", price: 100 })).orderIds[0]!;
  const b = (await broker.placeOrder({ ...buy, type: "LIMIT", price: 100 })).orderIds[0]!;
  await flush();
  await broker.cancelOrder(a);
  await broker.modifyOrder(b, { price: 105.1 }); // now marketable
  expect(statuses()).toEqual(["1:OPEN", "2:OPEN", "1:CANCELLED", "2:FILLED"]);
  expect(updates.at(-1)!.averagePrice).toBe(105.1);
  prices.set(OPT.key, 90, 89.9, 90.1);
  expect(statuses()).toHaveLength(4); // the cancelled order stays cancelled
  expect(broker.cancelOrder(b)).rejects.toThrow("already FILLED");
});

test("applies the same lot and tick checks as the real broker", async () => {
  const { broker } = setup();
  expect(broker.placeOrder({ ...buy, quantity: 75 })).rejects.toThrow("lot size 65");
  expect(broker.placeOrder({ ...buy, type: "LIMIT", price: 100.03 })).rejects.toThrow("tick size");
  expect(broker.placeOrder({ ...buy, type: "LIMIT" })).rejects.toThrow("need a price");
});

test("positions, realised P&L, charges and funds", async () => {
  const { prices, broker, positions, flush } = setup();
  prices.set(OPT.key, 200, 199.95, 200.05);
  await broker.placeOrder({ ...buy, side: "SELL", quantity: 130 }); // short 130 @ 199.95
  await flush();
  prices.set(OPT.key, 150, 149.95, 150.05);
  await broker.placeOrder({ ...buy, quantity: 65 }); // cover half @ 150.05
  await flush();

  const [p] = await broker.getPositions();
  expect(p).toMatchObject({ quantity: -65, averagePrice: 199.95, lastPrice: 150, product: "MIS" });
  expect(p!.realizedPnl).toBeCloseTo(65 * (199.95 - 150.05), 2);
  expect(p!.unrealizedPnl).toBeCloseTo(-65 * (150 - 199.95), 2);
  expect(positions.map((u) => u.quantity)).toEqual([-130, -65]);

  const charges =
    estimateCharges(OPT, "SELL", "MIS", 199.95, 130).total + estimateCharges(OPT, "BUY", "MIS", 150.05, 65).total;
  expect((await broker.getFunds()).available).toBeCloseTo(500_000 + p!.realizedPnl - charges, 1);
  expect(await broker.getTrades()).toHaveLength(2);
});

test("exitPositions closes shorts first, filtered by segment and tag", async () => {
  const { prices, broker, updates, flush } = setup();
  prices.set(OPT.key, 100, 99.95, 100.05);
  prices.set(OPT2.key, 80, 79.95, 80.05);
  prices.set(EQ.key, 1200, 1199.9, 1200.1);
  await broker.placeOrder({ ...buy, tag: "ifly" }); // long CE
  await broker.placeOrder({ ...buy, instrumentKey: OPT2.key, side: "SELL", tag: "ifly" }); // short PE
  await broker.placeOrder({ ...buy, instrumentKey: EQ.key, quantity: 10 }); // manual stock
  await flush();

  const { orderIds } = await broker.exitPositions({ segment: "NSE_FO", tag: "ifly" });
  await flush();
  const exits = updates.filter((o) => orderIds.includes(o.id) && o.status === "FILLED");
  expect(exits.map((o) => `${o.side} ${o.symbol}`)).toEqual(["BUY NIFTY 22700 PE", "SELL NIFTY 22700 CE"]);
  const open = (await broker.getPositions()).filter((p) => p.quantity !== 0);
  expect(open.map((p) => p.symbol)).toEqual(["RELIANCE"]); // untouched
});

test("closePosition closes one instrument and never over-closes", async () => {
  const { prices, broker, statuses, flush } = setup();
  prices.set(OPT.key, 100, 99.95, 100.05);
  await broker.placeOrder({ ...buy, quantity: 130 });
  await flush();
  prices.set(OPT.key, 110, 109.95, 110.05);
  await broker.closePosition(OPT.key, { type: "LIMIT", price: 120, quantity: 65 }); // rests
  await flush();
  expect(broker.closePosition(OPT.key, { quantity: 130 })).rejects.toThrow("at most 65");
  await broker.closePosition(OPT.key); // the other 65 at market
  await flush();
  expect(statuses().filter((s) => s.endsWith("FILLED"))).toHaveLength(2);
  expect((await broker.getPositions())[0]!.quantity).toBe(65);
  expect(broker.closePosition(OPT.key)).rejects.toThrow("already being closed");
});
