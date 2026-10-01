import { expect, test } from "bun:test";
import type { Notifier } from "../src/alerts/notifier";
import { RiskManager, RiskRejection, type RiskLimits } from "../src/risk/risk-manager";
import { createLogger } from "../src/utils/logger";
import { DEFAULT_IRON_BUTTERFLY, IronButterfly } from "../src/strategies/iron-butterfly";
import { key, settle, tradingHarness } from "./trading-harness";

const LIMITS: RiskLimits = { maxDailyLoss: 3_000, maxLotsPerOrder: 2, maxOpenPositions: 2 };
const CE = key(22700, "CE");
const PE = key(22700, "PE");
const WING = key(23100, "CE");

function alerts(): Notifier & { sent: string[] } {
  const sent: string[] = [];
  return { sent, notify: (t) => void sent.push(t), flush: async () => {} };
}

async function setup(limits = LIMITS) {
  const notifier = alerts();
  const h = tradingHarness({ risk: limits, notifier });
  h.at("09:30");
  await h.risk!.start();
  h.prices({ spot: 22710, ce: 150, pe: 140, wingCe: 20, wingPe: 25 });
  const order = async (instrumentKey: string, side: "BUY" | "SELL", lots = 1) => {
    const result = await h.risk!.placeOrder({ instrumentKey, side, quantity: 65 * lots, type: "MARKET", product: "MIS" });
    await settle();
    return result;
  };
  return { h, notifier, order };
}

test("refuses orders above the lot limit", async () => {
  const { order, notifier } = await setup();
  expect(order(CE, "SELL", 3)).rejects.toThrow(RiskRejection);
  expect(order(CE, "SELL", 3)).rejects.toThrow("3 lots is above the 2-lot limit per order");
  await settle();
  expect(notifier.sent[0]).toContain("Order refused");
});

test("limits the number of open positions, but closing is always allowed", async () => {
  const { h, order } = await setup();
  await order(CE, "SELL");
  await order(PE, "SELL");
  expect(h.risk!.openPositions().size).toBe(2);
  expect(order(WING, "BUY")).rejects.toThrow("would open position 3, above the limit of 2");
  await order(CE, "SELL"); // adding to an existing position doesn't open a new one
  await order(CE, "BUY", 2); // closing
  expect(h.risk!.openPositions().size).toBe(1);
  await order(WING, "BUY"); // room again
});

test("after the kill switch, only orders that reduce a position go through", async () => {
  const { h, order } = await setup();
  await order(CE, "SELL");
  h.store.activateKillSwitch("2026-10-05", "test");
  expect(order(PE, "SELL")).rejects.toThrow("the kill switch is on for today");
  expect(order(CE, "SELL")).rejects.toThrow("the kill switch is on for today"); // adds to the short
  expect(order(CE, "BUY", 2)).rejects.toThrow("the kill switch is on for today"); // would flip it long
  await order(CE, "BUY"); // closes the short
  expect((await h.broker.getPositions()).find((p) => p.instrumentKey === CE)?.quantity).toBe(0);
});

test("day P&L counts charges and live prices; at the loss limit the kill switch turns on", async () => {
  const { h, order, notifier } = await setup();
  await order(CE, "SELL", 2); // 130 sold at 149.95
  const pnlAtEntry = h.risk!.dayPnl();
  expect(pnlAtEntry).toBeLessThan(0); // charges (and the spread to the ltp)
  expect(pnlAtEntry).toBeGreaterThan(-100);

  h.prices({ ce: 165 }); // -15 x 130 = -1950: still inside the limit
  h.risk!.check();
  expect(h.store.killSwitch("2026-10-05")).toBeUndefined();

  h.prices({ ce: 175 }); // about -3250
  h.risk!.check();
  expect(h.store.killSwitch("2026-10-05")?.source).toMatch(/^risk: daily loss ₹3\d{3}/);
  expect(notifier.sent.some((t) => t.includes("Daily loss limit"))).toBe(true);
  expect(order(PE, "SELL")).rejects.toThrow("the daily loss limit was hit today");
});

test("end to end: the loss limit squares off the iron butterfly through the kill switch", async () => {
  const notifier = alerts();
  const h = tradingHarness({ risk: { maxDailyLoss: 2_000, maxLotsPerOrder: 5, maxOpenPositions: 4 }, notifier });
  h.at("09:15");
  await h.add(new IronButterfly({ ...DEFAULT_IRON_BUTTERFLY, fillTimeoutMs: 2_000 }));
  h.prices({ spot: 22710, ce: 150, pe: 140, wingCe: 20, wingPe: 25 });
  await h.clock("09:20");
  expect(await h.broker.getOrders()).toHaveLength(4);

  // A sharp rally: shorts -80.10, wings +40.90 per unit -> about -2,548 (plus charges) on the
  // position: past the ₹2,000 daily limit, still inside the strategy's own ₹5,000 stop.
  h.prices({ spot: 22950, ce: 330, pe: 40, wingCe: 80, wingPe: 6 });
  await settle();
  expect(h.store.loadState<{ phase: string }>("iron-butterfly")!.phase).toBe("open");
  h.risk!.check(); // runs every second in the bot
  await h.clock("10:00"); // the engine sees the kill switch on its next clock tick
  await settle();

  expect(h.store.trades("iron-butterfly")[0]!.exitReason).toBe("KILL_SWITCH");
  expect((await h.broker.getPositions()).every((p) => p.quantity === 0)).toBe(true);
  expect(notifier.sent.some((t) => t.includes("Kill switch on"))).toBe(true);
});

test("limits start fresh the next day", async () => {
  const h = tradingHarness();
  let now = new Date("2026-10-05T04:00:00Z"); // 09:30 IST
  const risk = new RiskManager(h.broker, { limits: LIMITS, instruments: h.instruments, prices: h.market, store: h.store, logger: createLogger({ level: "error", format: "pretty", write: () => {} }), now: () => now, checkIntervalMs: 3_600_000 });
  await risk.start();
  h.prices({ spot: 22710, ce: 150, pe: 140 });
  await risk.placeOrder({ instrumentKey: CE, side: "SELL", quantity: 130, type: "MARKET", product: "MIS" });
  await settle();
  h.prices({ ce: 200 });
  risk.check();
  expect(risk.placeOrder({ instrumentKey: PE, side: "SELL", quantity: 65, type: "MARKET", product: "MIS" })).rejects.toThrow("daily loss limit");
  await settle();

  now = new Date("2026-10-06T04:00:00Z"); // next morning
  expect(risk.dayPnl()).toBe(0);
  expect(risk.openPositions().size).toBe(0);
  risk.close();
});
