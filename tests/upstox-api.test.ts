import { expect, test } from "bun:test";
import { UpstoxMarketDataApi } from "../src/brokers/upstox/market-data";
import { UpstoxAccountApi } from "../src/brokers/upstox/account";
import { UpstoxOrdersApi } from "../src/brokers/upstox/orders";
import type { PlaceOrderRequest } from "../src/brokers/upstox/types";
import { fakeUpstox, ok } from "./upstox-helpers";

const NIFTY = "NSE_INDEX|Nifty 50";

// ---------- Candles ----------

test("today's candles: path, and newest-first converted to oldest-first", async () => {
  const { http, calls } = fakeUpstox([
    ok({
      candles: [
        ["2026-10-05T09:20:00+05:30", 25010, 25020, 25000, 25015, 1000, 0],
        ["2026-10-05T09:15:00+05:30", 25000, 25012, 24990, 25010, 1500, 0],
      ],
    }),
  ]);
  const candles = await new UpstoxMarketDataApi(http).fetchTodayCandles(NIFTY, { unit: "minutes", interval: 5 });
  expect(calls[0]!.url.pathname).toBe("/v3/historical-candle/intraday/NSE_INDEX%7CNifty%2050/minutes/5");
  expect(candles.map((c) => c.time.toISOString())).toEqual(["2026-10-05T03:45:00.000Z", "2026-10-05T03:50:00.000Z"]);
  expect(candles[0]).toEqual({ time: new Date("2026-10-05T03:45:00Z"), open: 25000, high: 25012, low: 24990, close: 25010, volume: 1500, oi: 0 });
});

test("historical candles put to_date before from_date in the path", async () => {
  const { http, calls } = fakeUpstox([ok({ candles: [] })]);
  await new UpstoxMarketDataApi(http).fetchHistoricalCandles(NIFTY, { unit: "days", interval: 1 }, "2026-09-01", "2026-09-25");
  expect(calls[0]!.url.pathname).toBe("/v3/historical-candle/NSE_INDEX%7CNifty%2050/days/1/2026-09-25/2026-09-01");
});

test("rejects bad candle intervals and dates before calling Upstox", async () => {
  const { http, calls } = fakeUpstox();
  const api = new UpstoxMarketDataApi(http);
  expect(api.fetchTodayCandles(NIFTY, { unit: "hours", interval: 6 })).rejects.toThrow("1 to 5");
  expect(api.fetchTodayCandles(NIFTY, { unit: "days", interval: 2 })).rejects.toThrow("1 to 1");
  expect(api.fetchHistoricalCandles(NIFTY, { unit: "days", interval: 1 }, "2026-9-1", "2026-09-25")).rejects.toThrow("YYYY-MM-DD");
  expect(api.fetchHistoricalCandles(NIFTY, { unit: "days", interval: 1 }, "2026-09-25", "2026-09-01")).rejects.toThrow("after");
  expect(calls).toHaveLength(0);
});

// ---------- Account ----------

test("portfolio fetches positions and holdings", async () => {
  const { http, calls } = fakeUpstox([ok([{ instrument_token: "NSE_FO|1", quantity: -75 }]), ok([{ isin: "INE002A01018", quantity: 10 }])]);
  const portfolio = await new UpstoxAccountApi(http).fetchPortfolio();
  expect(calls.map((c) => c.url.pathname).sort()).toEqual(["/v2/portfolio/long-term-holdings", "/v2/portfolio/short-term-positions"]);
  expect(portfolio.positions[0]!.quantity).toBe(-75);
  expect(portfolio.holdings[0]!.isin).toBe("INE002A01018");
});

test("profile and funds endpoints", async () => {
  const { http, calls } = fakeUpstox([ok({ user_id: "AB1234" }), ok({ equity: { available_margin: 100000 } })]);
  const account = new UpstoxAccountApi(http);
  expect((await account.fetchProfile()).user_id).toBe("AB1234");
  expect((await account.fetchFunds()).equity?.available_margin).toBe(100000);
  expect(calls.map((c) => c.url.pathname)).toEqual(["/v2/user/profile", "/v2/user/get-funds-and-margin"]);
});

// ---------- Regular orders ----------

const limitBuy: PlaceOrderRequest = {
  instrument_token: "NSE_FO|12345",
  transaction_type: "BUY",
  quantity: 75,
  product: "I",
  order_type: "LIMIT",
  price: 20.5,
  trigger_price: 0,
  validity: "DAY",
  tag: "iron-butterfly",
};

test("places an order on the hft host with defaults filled in", async () => {
  const { http, calls } = fakeUpstox([ok({ order_ids: ["250105000000001"] }, { metadata: { latency: 30 } })]);
  expect(await new UpstoxOrdersApi(http).placeOrder(limitBuy)).toEqual({ orderIds: ["250105000000001"] });
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.url.toString()).toBe("https://api-hft.upstox.com/v3/order/place");
  expect(calls[0]!.body).toEqual({ ...limitBuy, disclosed_quantity: 0, is_amo: false, slice: false });
});

test("reports sliced orders that only partly succeeded", async () => {
  const { http } = fakeUpstox([
    Response.json({ status: "partial_success", data: { order_ids: ["1"] }, errors: [{ errorCode: "UDAPI1", message: "slice 2 rejected" }] }),
  ]);
  const result = await new UpstoxOrdersApi(http).placeOrder({ ...limitBuy, quantity: 3600, slice: true });
  expect(result.orderIds).toEqual(["1"]);
  expect(result.errors?.[0]?.message).toBe("slice 2 rejected");
});

test("validates orders before sending", async () => {
  const { http, calls } = fakeUpstox();
  const orders = new UpstoxOrdersApi(http);
  expect(orders.placeOrder({ ...limitBuy, quantity: 0 })).rejects.toThrow("quantity");
  expect(orders.placeOrder({ ...limitBuy, price: 0 })).rejects.toThrow("need a price");
  expect(orders.placeOrder({ ...limitBuy, order_type: "MARKET" })).rejects.toThrow("price 0");
  expect(orders.placeOrder({ ...limitBuy, order_type: "SL" })).rejects.toThrow("trigger_price");
  expect(orders.placeOrder({ ...limitBuy, order_type: "SL-M", price: 0 })).rejects.toThrow("trigger_price");
  expect(orders.placeOrder({ ...limitBuy, tag: "x".repeat(21) })).rejects.toThrow("20 characters");
  expect(calls).toHaveLength(0);
});

test("modifies and cancels on the hft host", async () => {
  const { http, calls } = fakeUpstox([ok({ order_id: "1" }), ok({ order_id: "1" })]);
  const orders = new UpstoxOrdersApi(http);
  await orders.modifyOrder({ order_id: "1", price: 21, trigger_price: 0, order_type: "LIMIT", validity: "DAY" });
  expect(await orders.cancelOrder("1")).toBe("1");
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    "PUT https://api-hft.upstox.com/v3/order/modify",
    "DELETE https://api-hft.upstox.com/v3/order/cancel?order_id=1",
  ]);
});

test("order book, order details and trades", async () => {
  const { http, calls } = fakeUpstox([ok([{ order_id: "1", status: "complete" }]), ok({ order_id: "1" }), ok([])]);
  const orders = new UpstoxOrdersApi(http);
  expect((await orders.fetchOrders())[0]!.status).toBe("complete");
  await orders.fetchOrderDetails("1");
  await orders.fetchTrades();
  expect(calls.map((c) => c.url.toString())).toEqual([
    "https://api.upstox.com/v2/order/retrieve-all",
    "https://api.upstox.com/v2/order/details?order_id=1",
    "https://api.upstox.com/v2/order/trades/get-trades-for-day",
  ]);
});

// ---------- GTT ----------

test("GTT place, modify, cancel and list", async () => {
  const { http, calls } = fakeUpstox([
    ok({ gtt_order_ids: ["GTT-1"] }),
    ok({ gtt_order_ids: ["GTT-1"] }),
    ok({ gtt_order_ids: ["GTT-1"] }),
    ok([]),
  ]);
  const orders = new UpstoxOrdersApi(http);
  const rules = [
    { strategy: "ENTRY" as const, trigger_type: "BELOW" as const, trigger_price: 2800 },
    { strategy: "TARGET" as const, trigger_type: "IMMEDIATE" as const, trigger_price: 3000 },
    { strategy: "STOPLOSS" as const, trigger_type: "IMMEDIATE" as const, trigger_price: 2700, trailing_gap: 10 },
  ];
  expect(
    await orders.placeGttOrder({ type: "MULTIPLE", instrument_token: "NSE_EQ|INE002A01018", transaction_type: "BUY", quantity: 1, product: "D", rules }),
  ).toEqual(["GTT-1"]);
  await orders.modifyGttOrder({ gtt_order_id: "GTT-1", type: "MULTIPLE", quantity: 2, rules });
  await orders.cancelGttOrder("GTT-1");
  await orders.fetchGttOrders();

  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    "POST https://api.upstox.com/v3/order/gtt/place",
    "PUT https://api.upstox.com/v3/order/gtt/modify",
    "DELETE https://api.upstox.com/v3/order/gtt/cancel",
    "GET https://api.upstox.com/v3/order/gtt",
  ]);
  expect(calls[2]!.body).toEqual({ gtt_order_id: "GTT-1" });
});

test("validates GTT rules", async () => {
  const { http, calls } = fakeUpstox();
  const orders = new UpstoxOrdersApi(http);
  const base = { instrument_token: "NSE_EQ|X", transaction_type: "BUY" as const, quantity: 1, product: "D" as const };
  const entry = { strategy: "ENTRY" as const, trigger_type: "ABOVE" as const, trigger_price: 100 };
  const target = { strategy: "TARGET" as const, trigger_type: "IMMEDIATE" as const, trigger_price: 110 };
  expect(orders.placeGttOrder({ ...base, type: "SINGLE", rules: [target] })).rejects.toThrow("exactly one ENTRY");
  expect(orders.placeGttOrder({ ...base, type: "SINGLE", rules: [entry, target] })).rejects.toThrow("only the ENTRY");
  expect(orders.placeGttOrder({ ...base, type: "MULTIPLE", rules: [entry] })).rejects.toThrow("TARGET and/or STOPLOSS");
  expect(orders.placeGttOrder({ ...base, type: "MULTIPLE", rules: [entry, { ...target, trailing_gap: 5 }] })).rejects.toThrow("trailing_gap");
  expect(calls).toHaveLength(0);
});
