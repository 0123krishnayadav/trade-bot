// Conversions between Upstox's shapes and the broker-agnostic types in src/core.
import type { Funds, Order, OrderStatus, Position, PositionUpdate, Product, SubscriptionMode, Tick, Timeframe, Trade } from "../../core/types";
import { parseIstTimestamp } from "../../utils/time";
import type { FeedMode, FeedTick } from "./feed-decoder";
import type { UpstoxPositionMessage } from "./portfolio-feed";
import type { CandleInterval, UpstoxFunds, UpstoxOrder, UpstoxPosition, UpstoxProduct, UpstoxTrade } from "./types";

export const TIMEFRAMES: Record<Timeframe, CandleInterval> = {
  "1m": { unit: "minutes", interval: 1 },
  "3m": { unit: "minutes", interval: 3 },
  "5m": { unit: "minutes", interval: 5 },
  "15m": { unit: "minutes", interval: 15 },
  "30m": { unit: "minutes", interval: 30 },
  "1h": { unit: "hours", interval: 1 },
  "1d": { unit: "days", interval: 1 },
};

export const FEED_MODES: Record<SubscriptionMode, FeedMode> = { ltp: "ltpc", full: "full", greeks: "option_greeks" };

export function toUpstoxProduct(product: Product): UpstoxProduct {
  return product === "MIS" ? "I" : product === "MTF" ? "MTF" : "D";
}

/** Upstox uses "D" for both equity delivery and F&O carry-forward; the segment tells them apart. */
export function fromUpstoxProduct(product: UpstoxProduct, instrumentKey: string): Product {
  if (product === "I") return "MIS";
  if (product === "MTF") return "MTF";
  return instrumentKey.split("|")[0]!.endsWith("_EQ") ? "CNC" : "NRML";
}

const PENDING = new Set([
  "put order req received",
  "validation pending",
  "open pending",
  "after market order req received",
  "modify after market order req received",
]);
const OPEN = new Set(["open", "modified", "modify pending", "modify validation pending", "not modified", "cancel pending", "not cancelled"]);

/** Upstox reports lower-case statuses such as "trigger pending" or "open pending". */
export function toOrderStatus(status: string, filledQuantity: number): OrderStatus {
  const s = status.toLowerCase();
  if (s === "complete") return "FILLED";
  if (s === "rejected") return "REJECTED";
  if (s.startsWith("cancelled")) return "CANCELLED";
  if (s === "trigger pending") return "TRIGGER_PENDING";
  if (OPEN.has(s)) return filledQuantity > 0 ? "PARTIALLY_FILLED" : "OPEN";
  if (PENDING.has(s)) return "PENDING";
  return filledQuantity > 0 ? "PARTIALLY_FILLED" : "PENDING"; // unknown intermediate status
}

export function toOrder(o: UpstoxOrder): Order {
  const order: Order = {
    id: o.order_id,
    instrumentKey: o.instrument_token,
    symbol: o.trading_symbol,
    side: o.transaction_type,
    type: o.order_type,
    product: fromUpstoxProduct(o.product, o.instrument_token),
    validity: o.validity,
    quantity: o.quantity,
    price: o.price,
    triggerPrice: o.trigger_price,
    status: toOrderStatus(o.status, o.filled_quantity),
    filledQuantity: o.filled_quantity,
    pendingQuantity: o.pending_quantity,
    averagePrice: o.average_price,
    placedAt: parseIstTimestamp(o.order_timestamp),
  };
  if (o.status_message) order.statusMessage = o.status_message;
  if (o.tag) order.tag = o.tag;
  return order;
}

export function toTrade(t: UpstoxTrade): Trade {
  return {
    id: t.trade_id,
    orderId: t.order_id,
    instrumentKey: t.instrument_token,
    symbol: t.trading_symbol,
    side: t.transaction_type,
    product: fromUpstoxProduct(t.product, t.instrument_token),
    quantity: t.quantity,
    price: t.average_price,
    time: parseIstTimestamp(t.exchange_timestamp ?? t.order_timestamp),
  };
}

export function toPosition(p: UpstoxPosition): Position {
  return {
    instrumentKey: p.instrument_token,
    symbol: p.trading_symbol,
    product: fromUpstoxProduct(p.product, p.instrument_token),
    quantity: p.quantity,
    averagePrice: p.average_price,
    lastPrice: p.last_price,
    realizedPnl: p.realised,
    unrealizedPnl: p.unrealised,
    pnl: p.pnl,
  };
}

/** Stream position messages can carry average_price 0; fall back to the buy or sell average then. */
export function toPositionUpdate(p: UpstoxPositionMessage): PositionUpdate {
  const fallback = p.quantity > 0 ? p.buy_price : p.quantity < 0 ? p.sell_price : 0;
  return {
    instrumentKey: p.instrument_token,
    product: fromUpstoxProduct(p.product, p.instrument_token),
    quantity: p.quantity,
    averagePrice: p.average_price || fallback,
    buyQuantity: (p.day_buy_quantity ?? 0) + (p.overnight_buy_quantity ?? 0),
    sellQuantity: (p.day_sell_quantity ?? 0) + (p.overnight_sell_quantity ?? 0),
    buyValue: p.buy_value,
    sellValue: p.sell_value,
  };
}

/** Equity margin covers stocks and NSE/BSE F&O. Commodity (MCX) margin is separate and not included. */
export function toFunds(f: UpstoxFunds): Funds {
  return { available: f.equity?.available_margin ?? 0, used: f.equity?.used_margin ?? 0 };
}

export function toTick(t: FeedTick): Tick {
  const tick: Tick = { instrumentKey: t.instrumentKey, ltp: t.ltp, time: t.ltt, prevClose: t.closePrice };
  if (t.volume !== undefined) tick.volume = t.volume;
  if (t.oi !== undefined) tick.oi = t.oi;
  if (t.iv !== undefined) tick.iv = t.iv;
  if (t.greeks) tick.greeks = t.greeks;
  const best = t.depth?.[0];
  if (best) {
    tick.bestBid = best.bidPrice;
    tick.bestAsk = best.askPrice;
  }
  return tick;
}
