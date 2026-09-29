import { expect, test } from "bun:test";
import { decodeFeed, FeedResponse } from "../src/brokers/upstox/feed-decoder";
import { UpstoxMarketFeed, type WebSocketLike } from "../src/brokers/upstox/market-feed";
import { fail, fakeUpstox, ok } from "./upstox-helpers";

const encode = (obj: object) => FeedResponse.encode(FeedResponse.fromObject(obj)).finish();

// ---------- Decoder ----------

test("decodes ltpc ticks", () => {
  const feed = decodeFeed(
    encode({ type: 1, currentTs: 1759637400000, feeds: { "NSE_EQ|INE002A01018": { ltpc: { ltp: 1402.5, ltt: 1759637399000, ltq: 10, cp: 1390 } } } }),
  );
  expect(feed.type).toBe("live_feed");
  expect(feed.time).toEqual(new Date(1759637400000));
  expect(feed.ticks).toEqual([
    { instrumentKey: "NSE_EQ|INE002A01018", ltp: 1402.5, ltt: new Date(1759637399000), ltq: 10, closePrice: 1390 },
  ]);
});

test("decodes full index feeds with OHLC", () => {
  const [tick] = decodeFeed(
    encode({
      type: 1,
      feeds: {
        "NSE_INDEX|Nifty 50": {
          fullFeed: {
            indexFF: {
              ltpc: { ltp: 25010.5, ltt: 1759637399000, cp: 24990 },
              marketOHLC: { ohlc: [{ interval: "1d", open: 25000, high: 25100, low: 24950, close: 25010.5, vol: 0, ts: 1759597200000 }] },
            },
          },
        },
      },
    }),
  ).ticks;
  expect(tick!.ltp).toBe(25010.5);
  expect(tick!.ohlc).toEqual([{ interval: "1d", open: 25000, high: 25100, low: 24950, close: 25010.5, volume: 0, time: new Date(1759597200000) }]);
  expect(tick!.depth).toBeUndefined();
});

test("decodes full option feeds with depth, OI, IV and greeks", () => {
  const [tick] = decodeFeed(
    encode({
      type: 1,
      feeds: {
        "NSE_FO|12345": {
          fullFeed: {
            marketFF: {
              ltpc: { ltp: 150.05, ltt: 1759637399000, ltq: 75, cp: 160 },
              marketLevel: { bidAskQuote: [{ bidQ: 750, bidP: 150, askQ: 1500, askP: 150.1 }] },
              optionGreeks: { delta: 0.51, theta: -12.3, gamma: 0.0008, vega: 9.1, rho: 1.2 },
              atp: 155.2,
              vtt: 1234500,
              oi: 5678000,
              iv: 0.132,
              tbq: 100000,
              tsq: 120000,
            },
          },
        },
      },
    }),
  ).ticks;
  expect(tick).toMatchObject({
    instrumentKey: "NSE_FO|12345",
    ltp: 150.05,
    depth: [{ bidQty: 750, bidPrice: 150, askQty: 1500, askPrice: 150.1 }],
    greeks: { delta: 0.51, theta: -12.3, gamma: 0.0008, vega: 9.1, rho: 1.2 },
    atp: 155.2,
    volume: 1234500,
    oi: 5678000,
    iv: 0.132,
    totalBuyQty: 100000,
    totalSellQty: 120000,
  });
});

test("decodes option_greeks feeds", () => {
  const [tick] = decodeFeed(
    encode({
      type: 1,
      feeds: {
        "NSE_FO|12345": {
          firstLevelWithGreeks: { ltpc: { ltp: 150 }, firstDepth: { bidQ: 75, bidP: 149.95, askQ: 150, askP: 150.05 }, optionGreeks: { delta: 0.5 }, oi: 100, iv: 0.13 },
        },
      },
    }),
  ).ticks;
  expect(tick!.depth).toEqual([{ bidQty: 75, bidPrice: 149.95, askQty: 150, askPrice: 150.05 }]);
  expect(tick!.greeks?.delta).toBe(0.5);
  expect(tick!.oi).toBe(100);
});

test("decodes market status messages", () => {
  const feed = decodeFeed(encode({ type: 2, marketInfo: { segmentStatus: { NSE_FO: 2, NSE_EQ: 3 } } }));
  expect(feed.type).toBe("market_info");
  expect(feed.marketStatus).toEqual({ NSE_FO: "NORMAL_OPEN", NSE_EQ: "NORMAL_CLOSE" });
  expect(feed.ticks).toEqual([]);
});

// ---------- Connection ----------

class FakeSocket implements WebSocketLike {
  binaryType = "blob";
  readyState = 0;
  sent: { method: string; data: { instrumentKeys: string[]; mode?: string } }[] = [];
  closedWith?: number;
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onerror: WebSocketLike["onerror"] = null;
  constructor(readonly url: string) {}
  send(data: Uint8Array | string) {
    expect(data).toBeInstanceOf(Uint8Array); // Upstox wants binary frames
    this.sent.push(JSON.parse(new TextDecoder().decode(data as Uint8Array)));
  }
  close(code?: number) {
    this.closedWith = code;
    this.drop(code ?? 1000);
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
  message(obj: object) {
    this.onmessage?.({ data: encode(obj).slice().buffer });
  }
}

const authorized = (n: number) => ok({ authorizedRedirectUri: `wss://feed.upstox.test/${n}` });
const tick = (key: string, ltp: number) => ({ type: 1, feeds: { [key]: { ltpc: { ltp } } } });

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(2);
  expect(check()).toBe(true);
}

function setup(responses: Response[]) {
  const { http, calls } = fakeUpstox(responses);
  const sockets: FakeSocket[] = [];
  const feed = new UpstoxMarketFeed(http, {
    reconnectDelayMs: 1,
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      queueMicrotask(() => s.open());
      return s;
    },
  });
  return { feed, sockets, calls };
}

test("connects via the authorize URL and streams ticks", async () => {
  const { feed, sockets, calls } = setup([authorized(1)]);
  const ticks: number[] = [];
  feed.onTick((t) => ticks.push(t.ltp));
  await feed.connect();
  expect(calls[0]!.url.toString()).toBe("https://api.upstox.com/v3/feed/market-data-feed/authorize");
  expect(sockets[0]!.url).toBe("wss://feed.upstox.test/1");
  expect(sockets[0]!.binaryType).toBe("arraybuffer");

  feed.subscribe(["NSE_INDEX|Nifty 50"], "full");
  expect(sockets[0]!.sent).toMatchObject([{ method: "sub", data: { instrumentKeys: ["NSE_INDEX|Nifty 50"], mode: "full" } }]);
  sockets[0]!.message(tick("NSE_INDEX|Nifty 50", 25000));
  expect(ticks).toEqual([25000]);

  feed.changeMode(["NSE_INDEX|Nifty 50"], "ltpc");
  feed.unsubscribe(["NSE_INDEX|Nifty 50"]);
  expect(sockets[0]!.sent.map((m) => m.method)).toEqual(["sub", "change_mode", "unsub"]);
  expect(sockets[0]!.sent[2]!.data.mode).toBeUndefined();
});

test("subscriptions made before connecting are sent on connect, grouped by mode", async () => {
  const { feed, sockets } = setup([authorized(1)]);
  feed.subscribe(["A", "B"], "ltpc");
  feed.subscribe(["C"], "full");
  await feed.connect();
  expect(sockets[0]!.sent.map((m) => [m.data.mode, m.data.instrumentKeys])).toEqual([
    ["ltpc", ["A", "B"]],
    ["full", ["C"]],
  ]);
});

test("reconnects after a drop with a fresh URL and resubscribes", async () => {
  const { feed, sockets, calls } = setup([authorized(1), authorized(2)]);
  const states: boolean[] = [];
  feed.onConnectionChange((c) => states.push(c));
  await feed.connect();
  feed.subscribe(["A"], "full");
  feed.unsubscribe(["gone"]);

  sockets[0]!.drop();
  await until(() => sockets.length === 2 && feed.connected);
  expect(calls).toHaveLength(2);
  expect(sockets[1]!.url).toBe("wss://feed.upstox.test/2");
  expect(sockets[1]!.sent).toMatchObject([{ method: "sub", data: { instrumentKeys: ["A"], mode: "full" } }]);
  expect(states).toEqual([true, false, true]);
  feed.close();
});

test("close() doesn't reconnect", async () => {
  const { feed, sockets } = setup([authorized(1)]);
  await feed.connect();
  feed.close();
  await Bun.sleep(10);
  expect(sockets).toHaveLength(1);
  expect(sockets[0]!.closedWith).toBe(1000);
});

test("stops reconnecting when the session has expired", async () => {
  const { feed, sockets, calls } = setup([authorized(1), fail(401, "UDAPI100050", "Invalid token")]);
  await feed.connect();
  sockets[0]!.drop();
  await until(() => calls.length === 2);
  await Bun.sleep(10);
  expect(calls).toHaveLength(2);
  expect(sockets).toHaveLength(1);
});

test("a throwing tick handler doesn't stop other handlers", async () => {
  const { feed, sockets } = setup([authorized(1)]);
  const seen: number[] = [];
  feed.onTick(() => {
    throw new Error("bug in strategy");
  });
  feed.onTick((t) => seen.push(t.ltp));
  await feed.connect();
  sockets[0]!.message(tick("A", 1));
  expect(seen).toEqual([1]);
});

test("ignores undecodable messages", async () => {
  const { feed, sockets } = setup([authorized(1)]);
  const seen: number[] = [];
  feed.onTick((t) => seen.push(t.ltp));
  await feed.connect();
  sockets[0]!.onmessage?.({ data: new Uint8Array([0xff, 0xff, 0xff]).buffer });
  sockets[0]!.onmessage?.({ data: "text frame" });
  sockets[0]!.message(tick("A", 2));
  expect(seen).toEqual([2]);
});
