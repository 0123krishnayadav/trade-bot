import { expect, test } from "bun:test";
import type { Instrument, InstrumentLookup, Order, PositionUpdate } from "../src/core/types";
import { UpstoxPortfolioFeed } from "../src/brokers/upstox/portfolio-feed";
import { UpstoxBroker } from "../src/brokers/upstox/broker-adapter";
import { UpstoxOrdersApi } from "../src/brokers/upstox/orders";
import { UpstoxAccountApi } from "../src/brokers/upstox/account";
import { UpstoxHttp } from "../src/brokers/upstox/http";
import type { WebSocketLike } from "../src/brokers/upstox/reconnecting-socket";
import { ok } from "./upstox-helpers";

class FakeSocket implements WebSocketLike {
  binaryType = "blob";
  readyState = 0;
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onerror: WebSocketLike["onerror"] = null;
  constructor(readonly url: string) {}
  send() {}
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  drop() {
    this.close(1006);
  }
  push(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

/**
 * HTTP fake that routes by path, so authorize, order and order-book calls can interleave freely.
 * `beforePlaceResponds` runs while placeOrder is in flight, to simulate a fill racing the response.
 */
function fakeApi(routes: { orderBook?: () => object[]; beforePlaceResponds?: () => void } = {}) {
  const paths: string[] = [];
  const http = new UpstoxHttp({
    getAccessToken: () => "t",
    sleep: async () => {},
    fetchFn: async (url) => {
      const u = new URL(url);
      paths.push(u.pathname + u.search);
      if (u.pathname.endsWith("/authorize")) return ok({ authorized_redirect_uri: `wss://portfolio.test/${paths.length}` });
      if (u.pathname === "/v3/order/place") {
        routes.beforePlaceResponds?.();
        return ok({ order_ids: ["ORDER-1"] });
      }
      if (u.pathname === "/v2/order/retrieve-all") return ok(routes.orderBook?.() ?? []);
      if (u.pathname === "/v2/order/positions/exit") {
        routes.beforePlaceResponds?.();
        return Response.json(
          { status: "partial_success", data: { order_ids: ["EXIT-1"] }, errors: [{ error_code: "UDAPI100500", message: "Something went wrong", instrument_key: "NSE_FO|2" }] },
          { status: 207 },
        );
      }
      throw new Error(`unexpected ${u.pathname}`);
    },
  });
  const sockets: FakeSocket[] = [];
  const feed = new UpstoxPortfolioFeed(http, {
    reconnectDelayMs: 1,
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      queueMicrotask(() => s.open());
      return s;
    },
  });
  return { http, feed, sockets, paths };
}

const OPTION: Instrument = { key: "NSE_FO|1", exchange: "NSE", segment: "NSE_FO", kind: "option", symbol: "NIFTY 22700 CE", name: "NIFTY", lotSize: 65, tickSize: 0.05 };
const lookup = { get: (k: string) => (k === OPTION.key ? OPTION : undefined) } as InstrumentLookup;
const sell = { instrumentKey: OPTION.key, side: "SELL" as const, quantity: 130, type: "MARKET" as const, product: "MIS" as const };

const orderMsg = (status: string, filled = 0, id = "ORDER-1") => ({
  update_type: "order",
  order_id: id,
  instrument_token: OPTION.key,
  instrument_key: OPTION.key,
  trading_symbol: OPTION.symbol,
  transaction_type: "SELL",
  order_type: "MARKET",
  product: "I",
  validity: "DAY",
  quantity: 130,
  price: 0,
  trigger_price: 0,
  average_price: filled ? 219.5 : 0,
  filled_quantity: filled,
  pending_quantity: 130 - filled,
  status,
  status_message: "",
  tag: null,
  order_timestamp: "2026-10-05 09:20:01",
});

function setup(routes?: Parameters<typeof fakeApi>[0]) {
  const api = fakeApi(routes);
  const broker = new UpstoxBroker(new UpstoxOrdersApi(api.http), new UpstoxAccountApi(api.http), lookup, api.feed);
  const updates: Order[] = [];
  broker.onOrderUpdate((o) => updates.push(o));
  return { ...api, broker, updates, statuses: () => updates.map((o) => `${o.status}:${o.filledQuantity}`) };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(2);
  expect(check()).toBe(true);
}

// ---------- Feed ----------

test("authorizes with the requested update types and parses messages", async () => {
  const { feed, sockets, paths } = fakeApi();
  const orders: string[] = [];
  const positions: number[] = [];
  feed.onOrder((o) => orders.push(o.status));
  feed.onPosition((p) => positions.push(p.quantity));
  await feed.connect();
  expect(paths[0]).toBe("/v2/feed/portfolio-stream-feed/authorize?update_types=order%2Cposition");
  expect(sockets[0]!.url).toBe("wss://portfolio.test/1");

  sockets[0]!.push(orderMsg("open"));
  sockets[0]!.push({ update_type: "position", instrument_token: OPTION.key, product: "I", quantity: -130 });
  sockets[0]!.push({ update_type: "holding", quantity: 3 }); // not used
  sockets[0]!.onmessage?.({ data: "not json" });
  expect(orders).toEqual(["open"]);
  expect(positions).toEqual([-130]);
  feed.close();
});

// ---------- Broker using the stream ----------

test("reports order updates from the stream without polling", async () => {
  const { broker, sockets, paths, statuses } = setup();
  await broker.start();
  await broker.placeOrder(sell);
  sockets[0]!.push(orderMsg("open pending"));
  sockets[0]!.push(orderMsg("open"));
  sockets[0]!.push(orderMsg("open", 65));
  sockets[0]!.push(orderMsg("complete", 130));
  sockets[0]!.push(orderMsg("complete", 130)); // duplicate: ignored
  sockets[0]!.push(orderMsg("complete", 65, "SOMEONE-ELSES")); // not placed by us: ignored
  await Bun.sleep(10);
  expect(statuses()).toEqual(["PENDING:0", "OPEN:0", "PARTIALLY_FILLED:65", "FILLED:130"]);
  expect(paths.filter((p) => p.includes("retrieve-all"))).toHaveLength(0);
  broker.close();
});

test("a fill that arrives before placeOrder returns is still reported", async () => {
  let sockets: FakeSocket[] = [];
  const { broker, statuses, ...rest } = setup({ beforePlaceResponds: () => sockets[0]!.push(orderMsg("complete", 130)) });
  sockets = rest.sockets;
  await broker.start();
  expect(await broker.placeOrder(sell)).toEqual({ orderIds: ["ORDER-1"] });
  expect(statuses()).toEqual(["FILLED:130"]);
  broker.close();
});

test("no polling while the stream is down; one order-book read after reconnecting", async () => {
  let book: object[] = [];
  const { broker, sockets, paths, statuses } = setup({ orderBook: () => book });
  await broker.start();
  await broker.placeOrder(sell);
  const bookReads = () => paths.filter((p) => p.includes("retrieve-all")).length;

  sockets[0]!.drop();
  book = [orderMsg("complete", 130)]; // filled while disconnected; Upstox won't resend it
  await until(() => sockets.length === 2 && sockets[1]!.readyState === 1);
  await until(() => statuses().at(-1) === "FILLED:130");
  await Bun.sleep(20);
  expect(bookReads()).toBe(1);
  broker.close();
});

test("nothing is read after reconnecting when no orders are working", async () => {
  const { broker, sockets, paths } = setup();
  await broker.start();
  sockets[0]!.drop();
  await until(() => sockets.length === 2 && sockets[1]!.readyState === 1);
  await Bun.sleep(10);
  expect(paths.filter((p) => p.includes("retrieve-all"))).toHaveLength(0);
  broker.close();
});

test("ignores a stale snapshot that arrives after a newer update", async () => {
  let book: object[] = [];
  const { broker, sockets, statuses } = setup({ orderBook: () => book });
  await broker.start();
  await broker.placeOrder(sell);
  sockets[0]!.push(orderMsg("open", 65));
  book = [orderMsg("open", 0)]; // older state than the stream already reported
  sockets[0]!.drop(); // the reconnect reads the order book once
  await until(() => sockets.length === 2 && sockets[1]!.readyState === 1);
  await Bun.sleep(20);
  expect(statuses()).toEqual(["PARTIALLY_FILLED:65"]);
  broker.close();
});

test("maps position updates, filling in a zero average price", async () => {
  const { broker, sockets } = setup();
  const updates: PositionUpdate[] = [];
  broker.onPositionUpdate((u) => updates.push(u));
  await broker.start();
  sockets[0]!.push({
    update_type: "position",
    instrument_token: OPTION.key,
    product: "I",
    quantity: -130,
    average_price: 0,
    buy_price: 0,
    sell_price: 219.5,
    buy_value: 0,
    sell_value: 28535,
    day_buy_quantity: 0,
    day_sell_quantity: 130,
    overnight_buy_quantity: 0,
    overnight_sell_quantity: 0,
    multiplier: 1,
  });
  expect(updates).toEqual([
    { instrumentKey: OPTION.key, product: "MIS", quantity: -130, averagePrice: 219.5, buyQuantity: 0, sellQuantity: 130, buyValue: 0, sellValue: 28535 },
  ]);
  broker.close();
});

test("exit positions: fills of the exit orders are reported, and failures are returned", async () => {
  let sockets: FakeSocket[] = [];
  const { broker, statuses, ...rest } = setup({ beforePlaceResponds: () => sockets[0]!.push({ ...orderMsg("complete", 130, "EXIT-1"), transaction_type: "BUY" }) });
  sockets = rest.sockets;
  await broker.start();
  const result = await broker.exitPositions({ segment: "NSE_FO" });
  expect(result).toEqual({ orderIds: ["EXIT-1"], error: "NSE_FO|2: Something went wrong" });
  expect(rest.paths).toContain("/v2/order/positions/exit?segment=NSE_FO");
  expect(statuses()).toEqual(["FILLED:130"]); // the fill beat the response and was still delivered
  broker.close();
});
