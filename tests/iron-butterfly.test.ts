import { expect, test } from "bun:test";
import { IronButterfly, DEFAULT_IRON_BUTTERFLY, type IronButterflyConfig } from "../src/strategies/iron-butterfly";
import { migrate, openDatabase } from "../src/store/database";
import { migrations } from "../src/store/migrations";
import { TradingStore } from "../src/store/trading-store";
import { tradingHarness, key, settle } from "./trading-harness";

// NIFTY at 22710 → ATM 22700, wings 22300 PE and 23100 CE (400 points), 1 lot = 65.
// Entry prices (bid/ask spread 0.10): shorts sold at bid, wings bought at ask.
const cfg: IronButterflyConfig = { ...DEFAULT_IRON_BUTTERFLY, fillTimeoutMs: 2_000 };
const ENTRY = { spot: 22710, ce: 150, pe: 140, wingCe: 20, wingPe: 25 };

async function entered(config = cfg) {
  const h = tradingHarness();
  h.at("09:15");
  await h.add(new IronButterfly(config));
  h.prices(ENTRY);
  await h.clock("09:19");
  expect(await h.broker.getOrders()).toHaveLength(0); // too early
  await h.clock("09:20");
  return h;
}

const orderLog = async (h: ReturnType<typeof tradingHarness>) =>
  (await h.broker.getOrders()).map((o) => `${o.side} ${o.symbol.split(" ").slice(1, 3).join(" ")} ${o.status}`);

test("enters at 09:20: wings bought first, then ATM shorts, 1 lot each", async () => {
  const h = await entered();
  expect(await orderLog(h)).toEqual([
    "BUY 23100 CE FILLED",
    "BUY 22300 PE FILLED",
    "SELL 22700 CE FILLED",
    "SELL 22700 PE FILLED",
  ]);
  const positions = await h.broker.getPositions();
  expect(positions.map((p) => p.quantity).sort((a, b) => a - b)).toEqual([-65, -65, 65, 65]);
  const state = h.store.loadState<{ phase: string; credit: number; maxProfit: number; target: number; stopLoss: number }>("iron-butterfly")!;
  // credit = (149.95 + 139.95) - (20.05 + 25.05) = 244.8 per unit
  expect(state).toMatchObject({ phase: "open", credit: 244.8, maxProfit: 15912, stopLoss: 5000 });
  expect(state.target).toBeCloseTo(15912 * 0.4, 1);
});

test("exits at the target: shorts bought back first, trade recorded", async () => {
  const h = await entered();
  h.prices({ ce: 100, pe: 90, wingCe: 10, wingPe: 12 }); // MTM ≈ (289.9-190) - (45.1-22) ≈ 76.8/unit ≈ 4992 < 6365
  await h.clock("11:00");
  expect(h.store.loadState<{ phase: string }>("iron-butterfly")!.phase).toBe("open");
  h.prices({ ce: 80, pe: 70, wingCe: 8, wingPe: 9 }); // ≈ 101.8/unit ≈ 6617 ≥ target
  await settle();

  expect((await orderLog(h)).slice(4)).toEqual(["BUY 22700 CE FILLED", "BUY 22700 PE FILLED", "SELL 23100 CE FILLED", "SELL 22300 PE FILLED"]);
  expect((await h.broker.getPositions()).every((p) => p.quantity === 0)).toBe(true);
  const [trade] = h.store.trades("iron-butterfly");
  expect(trade).toMatchObject({ tradeDate: "2026-10-05", exitReason: "TARGET" });
  // Shorts: sold 149.95+139.95, bought back 80.05+70.05. Wings: bought 20.05+25.05, sold 7.95+8.95.
  expect(trade!.grossPnl).toBeCloseTo(65 * (289.9 - 150.1 - (45.1 - 16.9)), 1);
  expect(trade!.charges).toBeGreaterThan(0);
  expect(trade!.netPnl).toBeCloseTo(trade!.grossPnl - trade!.charges, 2);
});

test("exits at the stop loss", async () => {
  const h = await entered();
  h.prices({ spot: 22990, ce: 360, pe: 40, wingCe: 60, wingPe: 5 }); // big rally: MTM ≈ (289.9 - 400) + (65 - 45.1) ≈ -90.2/unit ≈ -5863
  await settle();
  const [trade] = h.store.trades("iron-butterfly");
  expect(trade!.exitReason).toBe("STOP_LOSS");
  expect(trade!.grossPnl).toBeLessThan(-5000);
});

test("squares off at 15:15 and doesn't trade again that day", async () => {
  const h = await entered();
  await h.clock("15:14");
  expect(h.store.trades()).toHaveLength(0);
  await h.clock("15:15");
  expect(h.store.trades()[0]!.exitReason).toBe("TIME_EXIT");
  await h.clock("15:16");
  expect(await h.broker.getOrders()).toHaveLength(8);
});

test("no entry outside the window, on skip dates, or twice", async () => {
  const late = tradingHarness();
  late.at("09:15");
  await late.add(new IronButterfly(cfg));
  late.prices(ENTRY);
  await late.clock("09:31");
  await late.clock("09:32");
  expect(await late.broker.getOrders()).toHaveLength(0);

  const skip = tradingHarness();
  skip.at("09:15");
  await skip.add(new IronButterfly({ ...cfg, skipDates: ["2026-10-05"] }));
  skip.prices(ENTRY);
  await skip.clock("09:20");
  expect(await skip.broker.getOrders()).toHaveLength(0);
});

test("waits for the spot price within the window", async () => {
  const h = tradingHarness();
  h.at("09:15");
  await h.add(new IronButterfly(cfg));
  await h.clock("09:20"); // no prices yet
  expect(await h.broker.getOrders()).toHaveLength(0);
  h.prices(ENTRY); // the NIFTY tick triggers the entry
  await settle();
  expect(await h.broker.getOrders()).toHaveLength(4);
});

test("a failed leg on entry unwinds the legs that filled", async () => {
  const h = tradingHarness();
  h.at("09:15");
  await h.add(new IronButterfly(cfg));
  h.prices(ENTRY);
  const place = h.broker.placeOrder.bind(h.broker);
  h.broker.placeOrder = async (req) => {
    if (req.instrumentKey === key(22300, "PE")) throw new Error("broker refused the order"); // e.g. insufficient margin
    return place(req);
  };
  await h.clock("09:20");
  expect(await orderLog(h)).toEqual(["BUY 23100 CE FILLED", "SELL 23100 CE FILLED"]);
  expect((await h.broker.getPositions()).every((p) => p.quantity === 0)).toBe(true);
  expect(h.store.trades()[0]!.exitReason).toBe("ENTRY_FAILED");
});

test("uses the next expiry when minDaysToExpiry skips expiry day", async () => {
  const h = tradingHarness({ date: "2026-10-06" }); // expiry day
  h.at("09:15");
  await h.add(new IronButterfly({ ...cfg, minDaysToExpiry: 1 }));
  h.prices({ ...ENTRY, expiry: "2026-10-13" });
  await h.clock("09:20");
  expect((await h.broker.getOrders()).every((o) => o.symbol.endsWith("2026-10-13"))).toBe(true);
});

test("shutting down squares off an open trade", async () => {
  const h = await entered();
  await h.engine.stop();
  expect(h.store.trades()[0]!.exitReason).toBe("SHUTDOWN");
  expect((await h.broker.getPositions()).every((p) => p.quantity === 0)).toBe(true);
});

test("an exit that doesn't fill is retried without doubling up", async () => {
  const h = await entered();
  // No bid/ask updates on the 22700 CE from here: remove its price so the paper broker can't fill it
  const ceKey = key(22700, "CE");
  (h.market as unknown as { lastTicks: Map<string, unknown> }).lastTicks.delete(ceKey);
  await h.clock("15:15");
  expect(await orderLog(h)).toContain("BUY 22700 CE REJECTED");
  expect(h.store.trades()).toHaveLength(0);
  expect(h.store.loadState<{ phase: string }>("iron-butterfly")!.phase).toBe("exiting");

  h.prices({ ce: 90 }); // price is back
  await h.clock("15:15"); // within 5s: not retried yet
  await h.clock("15:16");
  const buysOfCe = (await orderLog(h)).filter((o) => o.startsWith("BUY 22700 CE"));
  expect(buysOfCe).toEqual(["BUY 22700 CE REJECTED", "BUY 22700 CE FILLED"]);
  expect((await h.broker.getPositions()).every((p) => p.quantity === 0)).toBe(true);
  expect(h.store.trades()[0]!.exitReason).toBe("TIME_EXIT");
});

test("after a restart, an unfinished paper trade is discarded (paper positions don't survive)", async () => {
  const db = openDatabase(":memory:");
  migrate(db, migrations);
  new TradingStore(db, "paper").saveState("iron-butterfly", { date: "2026-10-05", phase: "open", legs: [] });
  const h = tradingHarness({ db });
  h.at("09:25");
  await h.add(new IronButterfly(cfg));
  h.prices(ENTRY);
  await h.clock("09:26");
  expect(await h.broker.getOrders()).toHaveLength(0); // doesn't re-enter the same day either
  expect(h.store.loadState<{ phase: string }>("iron-butterfly")!.phase).toBe("done");
});

test("orders and trades are saved with the strategy id", async () => {
  const h = await entered();
  await h.clock("15:15");
  const rows = h.db.query("SELECT strategy_id, status, tag FROM orders WHERE mode = 'paper'").all() as { strategy_id: string; status: string; tag: string }[];
  expect(rows).toHaveLength(8);
  expect(rows.every((r) => r.strategy_id === "iron-butterfly" && r.status === "FILLED" && r.tag === "iron-butterfly")).toBe(true);
});

test("waits for the option legs' quotes before ordering (they arrive after subscribing)", async () => {
  const h = tradingHarness();
  h.at("09:15");
  await h.add(new IronButterfly({ ...cfg, quoteWaitMs: 50 }));
  h.prices({ spot: 22710 }); // NIFTY only: no option quotes yet, as right after subscribing
  await h.clock("09:20");
  expect(await h.broker.getOrders()).toHaveLength(0); // nothing sent, nothing rejected
  expect(h.store.loadState<{ phase: string }>("iron-butterfly")?.phase ?? "idle").toBe("idle");
  h.prices(ENTRY); // quotes arrive
  await h.clock("09:21");
  expect(await orderLog(h)).toEqual(["BUY 23100 CE FILLED", "BUY 22300 PE FILLED", "SELL 22700 CE FILLED", "SELL 22700 PE FILLED"]);
});

test("gives up for the day if option quotes never arrive in the entry window", async () => {
  const h = tradingHarness();
  h.at("09:15");
  await h.add(new IronButterfly({ ...cfg, quoteWaitMs: 20 }));
  h.prices({ spot: 22710 });
  await h.clock("09:20");
  await h.clock("09:31");
  expect(await h.broker.getOrders()).toHaveLength(0);
  expect(h.store.loadState<{ phase: string; note: string }>("iron-butterfly")).toMatchObject({ phase: "done", note: "entry window missed" });
});

test("a non-positive credit is treated as a failed entry, not an instant target hit", async () => {
  const h = tradingHarness();
  h.at("09:15");
  await h.add(new IronButterfly(cfg));
  h.prices({ spot: 22710, ce: 20, pe: 20, wingCe: 30, wingPe: 30 }); // nonsense quotes: wings dearer than the ATM options
  await h.clock("09:20");
  expect(h.store.trades()[0]!.exitReason).toBe("ENTRY_FAILED");
  expect((await h.broker.getPositions()).every((p) => p.quantity === 0)).toBe(true);
});

test("doesn't enter on yesterday's price (sent by the broker on connect)", async () => {
  const h = tradingHarness();
  h.at("08:00");
  await h.add(new IronButterfly(cfg));
  h.md.push({ instrumentKey: "NSE_INDEX|Nifty 50", ltp: 22716.2, time: new Date("2026-10-02T10:00:00Z"), prevClose: 0 }); // last Friday's close
  await h.clock("09:20");
  expect(await h.broker.getOrders()).toHaveLength(0);
  h.prices(ENTRY); // today's live price arrives
  await settle();
  expect(await h.broker.getOrders()).toHaveLength(4);
});

// ---------- Kill switch ----------
// The dashboard's button writes a row; the engine checks for today's row on every clock tick.

test("kill switch row: the next clock tick squares off the open trade (shorts first) and blocks new trades", async () => {
  const h = await entered();
  h.store.activateKillSwitch("2026-10-05", "test");
  await h.clock("10:00");
  await settle();
  expect((await orderLog(h)).slice(4)).toEqual(["BUY 22700 CE FILLED", "BUY 22700 PE FILLED", "SELL 23100 CE FILLED", "SELL 22300 PE FILLED"]);
  expect((await h.broker.getPositions()).every((p) => p.quantity === 0)).toBe(true);
  expect(h.store.trades("iron-butterfly")[0]!.exitReason).toBe("KILL_SWITCH");
  expect(h.store.loadState<{ phase: string }>("iron-butterfly")!.phase).toBe("done");
  expect(h.logs.filter((l) => l.includes("KILL SWITCH is on for today"))).toHaveLength(1);
  await h.clock("10:01"); // carried out once, not on every tick
  expect(h.logs.filter((l) => l.includes("KILL SWITCH is on for today"))).toHaveLength(1);
  expect(await h.broker.getOrders()).toHaveLength(8);
});

test("kill switch pressed before the bot starts (or before a restart): no trade that day", async () => {
  const h = tradingHarness();
  h.store.activateKillSwitch("2026-10-05", "test");
  h.at("09:15");
  await h.add(new IronButterfly(cfg)); // start() checks the switch
  expect(h.store.loadState("iron-butterfly")).toMatchObject({ date: "2026-10-05", phase: "done", note: "kill switch" });
  h.prices(ENTRY);
  await h.clock("09:20");
  expect(await h.broker.getOrders()).toHaveLength(0);
});

test("kill switch holds for one day only: yesterday's row doesn't stop today's trade", async () => {
  const db = openDatabase(":memory:");
  migrate(db, migrations);
  new TradingStore(db, "paper").activateKillSwitch("2026-10-02", "test");
  new TradingStore(db, "live").activateKillSwitch("2026-10-05", "test"); // other mode: ignored
  const h = tradingHarness({ db });
  h.at("09:15");
  await h.add(new IronButterfly(cfg));
  h.prices(ENTRY);
  await h.clock("09:20");
  expect(await h.broker.getOrders()).toHaveLength(4);
});

test("kill switch when the saved state is from yesterday still marks today as done", async () => {
  const db = openDatabase(":memory:");
  migrate(db, migrations);
  new TradingStore(db, "paper").saveState("iron-butterfly", { date: "2026-10-02", phase: "done", legs: [] });
  const h = tradingHarness({ db });
  h.at("09:00");
  await h.add(new IronButterfly(cfg));
  expect(await h.engine.killSwitch()).toEqual([{ strategyId: "iron-butterfly", ok: true }]);
  expect(h.store.loadState("iron-butterfly")).toMatchObject({ date: "2026-10-05", phase: "done" });
  h.prices(ENTRY);
  await h.clock("09:20");
  expect(await h.broker.getOrders()).toHaveLength(0);
});
