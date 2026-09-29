import { expect, test } from "bun:test";
import type { Instrument, InstrumentLookup, Order } from "../src/core/types";
import { UpstoxMarketDataApi } from "../src/brokers/upstox/market-data";
import { UpstoxAccountApi } from "../src/brokers/upstox/account";
import { UpstoxOrdersApi } from "../src/brokers/upstox/orders";
import { UpstoxMarketFeed } from "../src/brokers/upstox/market-feed";
import { UpstoxPortfolioFeed } from "../src/brokers/upstox/portfolio-feed";
import { UpstoxMarketData } from "../src/brokers/upstox/market-data-adapter";
import { UpstoxBroker } from "../src/brokers/upstox/broker-adapter";
import { fromUpstoxProduct, toOrderStatus, toTick, toUpstoxProduct } from "../src/brokers/upstox/mappers";
import { istDateTime } from "../src/utils/time";
import { fakeUpstox, ok } from "./upstox-helpers";

// ---------- Mappings ----------

test("product mapping, including Upstox's shared D for delivery and carry-forward", () => {
  expect(toUpstoxProduct("MIS")).toBe("I");
  expect(toUpstoxProduct("CNC")).toBe("D");
  expect(toUpstoxProduct("NRML")).toBe("D");
  expect(fromUpstoxProduct("D", "NSE_EQ|INE002A01018")).toBe("CNC");
  expect(fromUpstoxProduct("D", "NSE_FO|65923")).toBe("NRML");
  expect(fromUpstoxProduct("I", "NSE_FO|65923")).toBe("MIS");
});

test("order status mapping", () => {
  expect(toOrderStatus("complete", 65)).toBe("FILLED");
  expect(toOrderStatus("rejected", 0)).toBe("REJECTED");
  expect(toOrderStatus("cancelled", 0)).toBe("CANCELLED");
  expect(toOrderStatus("cancelled after market order", 0)).toBe("CANCELLED");
  expect(toOrderStatus("trigger pending", 0)).toBe("TRIGGER_PENDING");
  expect(toOrderStatus("open", 0)).toBe("OPEN");
  expect(toOrderStatus("open", 65)).toBe("PARTIALLY_FILLED");
  expect(toOrderStatus("modify pending", 0)).toBe("OPEN");
  expect(toOrderStatus("validation pending", 0)).toBe("PENDING");
  expect(toOrderStatus("put order req received", 0)).toBe("PENDING");
  expect(toOrderStatus("something new", 0)).toBe("PENDING");
});

test("tick mapping keeps only what the feed sent", () => {
  const ltt = new Date("2026-10-05T04:00:00Z");
  expect(toTick({ instrumentKey: "K", ltp: 150, ltt, ltq: 65, closePrice: 160 })).toEqual({ instrumentKey: "K", ltp: 150, time: ltt, prevClose: 160 });
  const full = toTick({
    instrumentKey: "K",
    ltp: 150,
    ltt,
    ltq: 65,
    closePrice: 160,
    depth: [{ bidQty: 65, bidPrice: 149.95, askQty: 130, askPrice: 150.05 }],
    oi: 1000,
    iv: 0.13,
    volume: 5000,
  });
  expect(full).toMatchObject({ bestBid: 149.95, bestAsk: 150.05, oi: 1000, iv: 0.13, volume: 5000 });
});

// ---------- MarketData ----------

function marketData(responses: Response[], today = "2026-10-05") {
  const fake = fakeUpstox(responses);
  const md = new UpstoxMarketData(new UpstoxMarketDataApi(fake.http), new UpstoxMarketFeed(fake.http), () => istDateTime(today, "11:00"));
  return { md, calls: fake.calls };
}
const candle = (isoIst: string, close: number) => [isoIst, close, close, close, close, 100, 0];

test("splits long ranges into chunks Upstox accepts", async () => {
  const { md, calls } = marketData([ok({ candles: [] }), ok({ candles: [] }), ok({ candles: [] })]);
  await md.getCandles("NSE_INDEX|Nifty 50", "5m", "2026-07-01", "2026-09-10"); // 72 days, 28 per request
  expect(calls.map((c) => c.url.pathname.split("/").slice(-2).reverse().join("→"))).toEqual([
    "2026-07-01→2026-07-28",
    "2026-07-29→2026-08-25",
    "2026-08-26→2026-09-10",
  ]);
});

test("adds today's candles from the intraday API and merges in order", async () => {
  const { md, calls } = marketData([
    ok({ candles: [candle("2026-10-03T15:25:00+05:30", 2), candle("2026-10-02T15:25:00+05:30", 1)] }),
    ok({ candles: [candle("2026-10-05T09:20:00+05:30", 4), candle("2026-10-05T09:15:00+05:30", 3)] }),
  ]);
  const candles = await md.getCandles("NSE_INDEX|Nifty 50", "5m", "2026-10-02", "2026-10-05");
  expect(calls.map((c) => c.url.pathname)).toEqual([
    "/v3/historical-candle/NSE_INDEX%7CNifty%2050/minutes/5/2026-10-04/2026-10-02", // up to yesterday
    "/v3/historical-candle/intraday/NSE_INDEX%7CNifty%2050/minutes/5",
  ]);
  expect(candles.map((c) => c.close)).toEqual([1, 2, 3, 4]);
  expect(candles[0]).toMatchObject({ instrumentKey: "NSE_INDEX|Nifty 50", timeframe: "5m", oi: 0 });
});

test("today only, and past only, use one API each", async () => {
  const todayOnly = marketData([ok({ candles: [] })]);
  await todayOnly.md.getCandles("K", "1m", "2026-10-05", "2026-10-05");
  expect(todayOnly.calls[0]!.url.pathname).toContain("/intraday/");
  expect(todayOnly.calls).toHaveLength(1);

  const pastOnly = marketData([ok({ candles: [] })]);
  await pastOnly.md.getCandles("K", "1d", "2025-01-01", "2026-09-30");
  expect(pastOnly.calls).toHaveLength(1);
  expect(pastOnly.calls[0]!.url.pathname).toBe("/v3/historical-candle/K/days/1/2026-09-30/2025-01-01");
});

// ---------- Broker ----------

const OPTION: Instrument = {
  key: "NSE_FO|65923",
  exchange: "NSE",
  segment: "NSE_FO",
  kind: "option",
  symbol: "NIFTY 25000 CE 06 OCT 26",
  name: "NIFTY",
  lotSize: 65,
  tickSize: 0.05,
  freezeQuantity: 1755,
};
const lookup: InstrumentLookup = {
  get: (key) => (key === OPTION.key ? OPTION : undefined),
  findIndex: () => undefined,
  findEquity: () => undefined,
  expiries: () => [],
  optionChain: () => [],
  findOption: () => undefined,
  findFuture: () => undefined,
};

function broker(responses: Response[]) {
  const fake = fakeUpstox(responses);
  const b = new UpstoxBroker(new UpstoxOrdersApi(fake.http), new UpstoxAccountApi(fake.http), lookup, new UpstoxPortfolioFeed(fake.http));
  return { broker: b, calls: fake.calls };
}

const upstoxOrder = (status: string, filled = 0, extra: object = {}) => ({
  order_id: "250105000000001",
  instrument_token: OPTION.key,
  trading_symbol: OPTION.symbol,
  transaction_type: "SELL",
  order_type: "LIMIT",
  product: "I",
  validity: "DAY",
  quantity: 65,
  price: 150.05,
  trigger_price: 0,
  average_price: filled ? 150.05 : 0,
  filled_quantity: filled,
  pending_quantity: 65 - filled,
  status,
  status_message: null,
  tag: "iron-butterfly",
  order_timestamp: "2026-10-05 09:20:01",
  ...extra,
});

const sell = { instrumentKey: OPTION.key, side: "SELL" as const, quantity: 65, type: "LIMIT" as const, product: "MIS" as const, price: 150.05, tag: "iron-butterfly" };

test("places orders in Upstox's format", async () => {
  const { broker: b, calls } = broker([ok({ order_ids: ["1"] })]);
  expect(await b.placeOrder(sell)).toEqual({ orderIds: ["1"] });
  b.close();
  expect(calls[0]!.body).toEqual({
    instrument_token: OPTION.key,
    transaction_type: "SELL",
    quantity: 65,
    product: "I",
    order_type: "LIMIT",
    price: 150.05,
    trigger_price: 0,
    validity: "DAY",
    tag: "iron-butterfly",
    slice: false,
    disclosed_quantity: 0,
    is_amo: false,
  });
});

test("turns on slicing above the freeze quantity", async () => {
  const { broker: b, calls } = broker([ok({ order_ids: ["1", "2"] })]);
  expect((await b.placeOrder({ ...sell, quantity: 65 * 30 })).orderIds).toEqual(["1", "2"]);
  b.close();
  expect((calls[0]!.body as { slice: boolean }).slice).toBe(true);
});

test("rejects bad lots, off-tick prices and unknown instruments before calling Upstox", async () => {
  const { broker: b, calls } = broker([ok({ order_ids: ["1"] })]);
  expect(b.placeOrder({ ...sell, quantity: 75 })).rejects.toThrow("not a multiple of the lot size 65");
  expect(b.placeOrder({ ...sell, price: 150.03 })).rejects.toThrow("tick size 0.05");
  expect(b.placeOrder({ ...sell, type: "SL", triggerPrice: 149.99 })).rejects.toThrow("tick size");
  expect(b.placeOrder({ ...sell, instrumentKey: "NSE_FO|0" })).rejects.toThrow("Unknown instrument");
  expect(calls).toHaveLength(0);
  // Floating-point noise: 20.15 / 0.05 is 402.99999999999994, still a valid price.
  expect(await b.placeOrder({ ...sell, price: 20.15 })).toEqual({ orderIds: ["1"] });
  b.close();
});

test("modify fills unchanged fields from the current order", async () => {
  const { broker: b, calls } = broker([ok(upstoxOrder("open")), ok({ order_id: "250105000000001" })]);
  await b.modifyOrder("250105000000001", { price: 149.5 });
  b.close();
  expect(calls[1]!.url.toString()).toBe("https://api-hft.upstox.com/v3/order/modify");
  expect(calls[1]!.body).toEqual({ order_id: "250105000000001", quantity: 65, price: 149.5, trigger_price: 0, order_type: "LIMIT", validity: "DAY" });
});

test("maps orders, positions and funds", async () => {
  const { broker: b } = broker([
    ok([upstoxOrder("complete", 65)]),
    ok([{ instrument_token: OPTION.key, trading_symbol: OPTION.symbol, product: "I", quantity: -65, average_price: 150.05, last_price: 120, realised: 0, unrealised: 1950, pnl: 1950 }]),
    ok({ equity: { available_margin: 250000, used_margin: 50000 } }),
  ]);
  const [order] = await b.getOrders();
  expect(order).toEqual({
    id: "250105000000001",
    instrumentKey: OPTION.key,
    symbol: OPTION.symbol,
    side: "SELL",
    type: "LIMIT",
    product: "MIS",
    validity: "DAY",
    quantity: 65,
    price: 150.05,
    triggerPrice: 0,
    status: "FILLED",
    filledQuantity: 65,
    pendingQuantity: 0,
    averagePrice: 150.05,
    tag: "iron-butterfly",
    placedAt: new Date("2026-10-05T03:50:01Z"), // "2026-10-05 09:20:01" IST
  });
  expect(await b.getPositions()).toEqual([
    { instrumentKey: OPTION.key, symbol: OPTION.symbol, product: "MIS", quantity: -65, averagePrice: 150.05, lastPrice: 120, realizedPnl: 0, unrealizedPnl: 1950, pnl: 1950 },
  ]);
  expect(await b.getFunds()).toEqual({ available: 250000, used: 50000 });
});

// ---------- closePosition ----------

const position = (quantity: number, product = "I") => ({
  instrument_token: OPTION.key,
  trading_symbol: OPTION.symbol,
  product,
  quantity,
  average_price: 150,
  last_price: 160,
  realised: 0,
  unrealised: 0,
  pnl: 0,
});

test("closes a long with a SELL for the whole quantity at market, same product", async () => {
  const { broker: b, calls } = broker([ok([position(130)]), ok({ order_ids: ["C1"] })]);
  expect(await b.closePosition(OPTION.key)).toEqual({ orderIds: ["C1"] });
  expect(calls[1]!.body).toMatchObject({ instrument_token: OPTION.key, transaction_type: "SELL", quantity: 130, order_type: "MARKET", product: "I", price: 0 });
  b.close();
});

test("closes a short with a BUY, partly, at a limit price", async () => {
  const { broker: b, calls } = broker([ok([position(-130, "D")]), ok({ order_ids: ["C1"] })]);
  await b.closePosition(OPTION.key, { quantity: 65, type: "LIMIT", price: 120.5, tag: "tp" });
  expect(calls[1]!.body).toMatchObject({ transaction_type: "BUY", quantity: 65, order_type: "LIMIT", price: 120.5, product: "D", tag: "tp" });
  b.close();
});

test("refuses to close more than is open, or what isn't open", async () => {
  const { broker: b, calls } = broker([ok([position(65)]), ok([position(0)]), ok([])]);
  expect(b.closePosition(OPTION.key, { quantity: 130 })).rejects.toThrow("can close at most 65");
  await Bun.sleep(1);
  expect(b.closePosition(OPTION.key)).rejects.toThrow("No open position"); // closed earlier today: quantity 0
  await Bun.sleep(1);
  expect(b.closePosition(OPTION.key)).rejects.toThrow("No open position");
  await Bun.sleep(1);
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  b.close();
});

test("asks which product when both MIS and NRML are open", async () => {
  const { broker: b, calls } = broker([ok([position(65, "I"), position(-130, "D")]), ok([position(65, "I"), position(-130, "D")]), ok({ order_ids: ["C1"] })]);
  expect(b.closePosition(OPTION.key)).rejects.toThrow("MIS and NRML; pass product");
  await Bun.sleep(1);
  await b.closePosition(OPTION.key, { product: "NRML" });
  expect(calls[2]!.body).toMatchObject({ transaction_type: "BUY", quantity: 130, product: "D" });
  b.close();
});

test("counts pending closing orders so a position is never over-closed", async () => {
  const { broker: b, calls } = broker([
    ok([position(130)]),
    ok({ order_ids: ["C1"] }), // closes 65, still pending
    ok([position(130)]), // not filled yet, so the position still shows 130
    ok({ order_ids: ["C2"] }),
    ok([position(130)]),
  ]);
  await b.closePosition(OPTION.key, { quantity: 65 });
  await b.closePosition(OPTION.key); // only the remaining 65
  expect(calls[3]!.body).toMatchObject({ transaction_type: "SELL", quantity: 65 });
  expect(b.closePosition(OPTION.key)).rejects.toThrow("already being closed by pending orders");
  await Bun.sleep(1);
  b.close();
});

test("a pending order on the other side doesn't count as closing", async () => {
  const { broker: b, calls } = broker([ok({ order_ids: ["ADD"] }), ok([position(130)]), ok({ order_ids: ["C1"] })]);
  await b.placeOrder({ ...sell, side: "BUY", quantity: 65, price: 100 }); // adding to the long, pending
  await b.closePosition(OPTION.key);
  expect(calls[2]!.body).toMatchObject({ transaction_type: "SELL", quantity: 130 });
  b.close();
});
