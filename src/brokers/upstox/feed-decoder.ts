import protobuf from "protobufjs";
// Upstox's official schema, copied unchanged from their SDK (src/feeder/proto/MarketDataFeedV3.proto).
import feedProto from "./MarketDataFeedV3.proto" with { type: "text" };
import type { InstrumentKey } from "./types";

/**
 * ltpc: last price only. full: price, 5-level depth, OHLC, OI, greeks.
 * option_greeks: price, best bid/ask, greeks. full_d30: like full with 30-level depth (Upstox Plus).
 */
export type FeedMode = "ltpc" | "full" | "option_greeks" | "full_d30";

export interface DepthLevel {
  bidQty: number;
  bidPrice: number;
  askQty: number;
  askPrice: number;
}

export interface FeedOhlc {
  /** "1d" for today, "I1" for the current 1-minute bar, "I30" for 30-minute, etc. */
  interval: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  time: Date;
}

export interface OptionGreeks {
  delta: number;
  theta: number;
  gamma: number;
  vega: number;
  rho: number;
}

/** One instrument's update, flattened from whichever feed mode it came in. */
export interface FeedTick {
  instrumentKey: InstrumentKey;
  ltp: number;
  /** Last trade time. */
  ltt: Date;
  /** Last trade quantity. */
  ltq: number;
  /** Previous day's close. */
  closePrice: number;
  ohlc?: FeedOhlc[];
  depth?: DepthLevel[];
  greeks?: OptionGreeks;
  /** Average traded price. */
  atp?: number;
  /** Volume traded today. */
  volume?: number;
  oi?: number;
  iv?: number;
  totalBuyQty?: number;
  totalSellQty?: number;
}

export interface DecodedFeed {
  type: "initial_feed" | "live_feed" | "market_info";
  time: Date;
  ticks: FeedTick[];
  /** Segment → status, e.g. {"NSE_FO": "NORMAL_OPEN"}; only on market_info messages. */
  marketStatus?: Record<string, string>;
}

const root = new protobuf.Root();
root.addJSON(protobuf.common.get("google/protobuf/wrappers.proto")!.nested!);
protobuf.parse(feedProto, root, { keepCase: true });
export const FeedResponse = root.lookupType("com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse");

interface RawLtpc {
  ltp?: number;
  ltt?: number;
  ltq?: number;
  cp?: number;
}
interface RawOhlc {
  interval?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  vol?: number;
  ts?: number;
}
interface RawQuote {
  bidQ?: number;
  bidP?: number;
  askQ?: number;
  askP?: number;
}
interface RawFeed {
  ltpc?: RawLtpc;
  fullFeed?: {
    marketFF?: {
      ltpc?: RawLtpc;
      marketLevel?: { bidAskQuote?: RawQuote[] };
      optionGreeks?: OptionGreeks;
      marketOHLC?: { ohlc?: RawOhlc[] };
      atp?: number;
      vtt?: number;
      oi?: number;
      iv?: number;
      tbq?: number;
      tsq?: number;
    };
    indexFF?: { ltpc?: RawLtpc; marketOHLC?: { ohlc?: RawOhlc[] } };
  };
  firstLevelWithGreeks?: {
    ltpc?: RawLtpc;
    firstDepth?: RawQuote;
    optionGreeks?: OptionGreeks;
    vtt?: number;
    oi?: number;
    iv?: number;
  };
}
interface RawResponse {
  type?: DecodedFeed["type"];
  feeds?: Record<string, RawFeed>;
  currentTs?: number;
  marketInfo?: { segmentStatus?: Record<string, string> };
}

export function decodeFeed(bytes: Uint8Array): DecodedFeed {
  const raw = FeedResponse.toObject(FeedResponse.decode(bytes), { longs: Number, enums: String }) as RawResponse;
  const ticks: FeedTick[] = [];
  for (const [instrumentKey, feed] of Object.entries(raw.feeds ?? {})) {
    const tick = toTick(instrumentKey, feed);
    if (tick) ticks.push(tick);
  }
  return {
    type: raw.type ?? "initial_feed",
    time: new Date(raw.currentTs ?? 0),
    ticks,
    marketStatus: raw.marketInfo?.segmentStatus,
  };
}

function toTick(instrumentKey: string, feed: RawFeed): FeedTick | undefined {
  const market = feed.fullFeed?.marketFF;
  const index = feed.fullFeed?.indexFF;
  const greeksFeed = feed.firstLevelWithGreeks;
  const ltpc = feed.ltpc ?? market?.ltpc ?? index?.ltpc ?? greeksFeed?.ltpc;
  if (!ltpc) return undefined;

  const tick: FeedTick = {
    instrumentKey,
    ltp: ltpc.ltp ?? 0,
    ltt: new Date(ltpc.ltt ?? 0),
    ltq: ltpc.ltq ?? 0,
    closePrice: ltpc.cp ?? 0,
  };
  const ohlc = (market ?? index)?.marketOHLC?.ohlc;
  if (ohlc?.length) tick.ohlc = ohlc.map(toOhlc);
  if (market) {
    tick.depth = (market.marketLevel?.bidAskQuote ?? []).map(toDepth);
    tick.greeks = market.optionGreeks;
    Object.assign(tick, { atp: market.atp, volume: market.vtt, oi: market.oi, iv: market.iv, totalBuyQty: market.tbq, totalSellQty: market.tsq });
  }
  if (greeksFeed) {
    if (greeksFeed.firstDepth) tick.depth = [toDepth(greeksFeed.firstDepth)];
    tick.greeks = greeksFeed.optionGreeks;
    Object.assign(tick, { volume: greeksFeed.vtt, oi: greeksFeed.oi, iv: greeksFeed.iv });
  }
  for (const key of Object.keys(tick) as (keyof FeedTick)[]) if (tick[key] === undefined) delete tick[key];
  return tick;
}

function toOhlc(o: RawOhlc): FeedOhlc {
  return {
    interval: o.interval ?? "",
    open: o.open ?? 0,
    high: o.high ?? 0,
    low: o.low ?? 0,
    close: o.close ?? 0,
    volume: o.vol ?? 0,
    time: new Date(o.ts ?? 0),
  };
}

function toDepth(q: RawQuote): DepthLevel {
  return { bidQty: q.bidQ ?? 0, bidPrice: q.bidP ?? 0, askQty: q.askQ ?? 0, askPrice: q.askP ?? 0 };
}
