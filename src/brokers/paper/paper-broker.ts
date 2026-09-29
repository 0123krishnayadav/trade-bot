import {
  FINAL_ORDER_STATUSES,
  type Broker,
  type ClosePositionOptions,
  type ExitPositionsFilter,
  type Funds,
  type Instrument,
  type InstrumentLookup,
  type Order,
  type OrderChanges,
  type OrderRequest,
  type PlaceOrderResult,
  type Position,
  type PositionUpdate,
  type SubscriptionMode,
  type Tick,
  type Trade,
} from "../../core/types";
import type { Logger } from "../../utils/logger";
import { checkOrder, roundToTick } from "../order-checks";
import { estimateCharges } from "../charges";

/** The slice of the MarketEngine the paper broker needs for prices. */
export interface PriceSource {
  lastTick(instrumentKey: string): Tick | undefined;
  onTick(instrumentKey: string, handler: (tick: Tick) => void): () => void;
  subscribe(owner: string, instrumentKeys: string[], mode?: SubscriptionMode): void;
  unsubscribe(owner: string, instrumentKeys?: string[]): void;
}

export interface PaperBrokerOptions {
  capital: number;
  logger?: Logger;
  now?: () => Date;
  /** Extra ticks of slippage on MARKET fills when there's no bid/ask to fill against. Default 1. */
  slippageTicks?: number;
}

interface PaperOrder extends Order {
  request: OrderRequest;
  charges: number;
}

interface PaperPosition {
  instrumentKey: string;
  symbol: string;
  segment: string;
  product: Order["product"];
  quantity: number;
  averagePrice: number;
  realizedPnl: number;
  buyQuantity: number;
  sellQuantity: number;
  buyValue: number;
  sellValue: number;
  /** Tags of the orders that opened it, for exitPositions({ tag }). */
  tags: Set<string>;
}

const OWNER = "paper-broker";

/**
 * Simulated broker on live prices. MARKET orders fill at the best ask (buy) or bid (sell); LIMIT
 * orders fill once the market reaches their price; SL/SL-M trigger when the last price crosses the
 * trigger. Orders fill in full; there are no partial fills. Charges are estimated per fill. Margin
 * isn't modelled: funds are capital plus realised P&L minus charges.
 */
export class PaperBroker implements Broker {
  readonly name = "paper";
  private readonly orders = new Map<string, PaperOrder>();
  private readonly positions = new Map<string, PaperPosition>();
  private readonly trades: Trade[] = [];
  private readonly resting = new Map<string, () => void>();
  private readonly orderHandlers: ((order: Order) => void)[] = [];
  private readonly positionHandlers: ((update: PositionUpdate) => void)[] = [];
  private readonly runId = Date.now().toString(36);
  private readonly now: () => Date;
  private seq = 0;
  private chargesPaid = 0;

  constructor(
    private readonly prices: PriceSource,
    private readonly instruments: InstrumentLookup,
    private readonly opts: PaperBrokerOptions,
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  async start(): Promise<void> {}

  close(): void {
    for (const stop of this.resting.values()) stop();
    this.resting.clear();
    this.prices.unsubscribe(OWNER);
  }

  async placeOrder(req: OrderRequest): Promise<PlaceOrderResult> {
    const instrument = checkOrder(req, this.instruments);
    const now = this.now();
    const order: PaperOrder = {
      id: `PAPER-${this.runId}-${++this.seq}`,
      instrumentKey: req.instrumentKey,
      symbol: instrument.symbol,
      side: req.side,
      type: req.type,
      product: req.product,
      validity: req.validity ?? "DAY",
      quantity: req.quantity,
      price: req.price ?? 0,
      triggerPrice: req.triggerPrice ?? 0,
      status: "PENDING",
      filledQuantity: 0,
      pendingQuantity: req.quantity,
      averagePrice: 0,
      placedAt: now,
      request: req,
      charges: 0,
      ...(req.tag ? { tag: req.tag } : {}),
    };
    this.orders.set(order.id, order);
    this.prices.subscribe(OWNER, [req.instrumentKey], "full");
    // Like a real broker, the result comes back before the first status update.
    setTimeout(() => this.work(order, instrument), 0);
    return { orderIds: [order.id] };
  }

  async modifyOrder(orderId: string, changes: OrderChanges): Promise<void> {
    const order = this.openOrder(orderId);
    const req: OrderRequest = {
      ...order.request,
      quantity: changes.quantity ?? order.quantity,
      type: changes.type ?? order.type,
      validity: changes.validity ?? order.validity,
      price: changes.price ?? order.price,
      triggerPrice: changes.triggerPrice ?? order.triggerPrice,
    };
    const instrument = checkOrder(req, this.instruments);
    Object.assign(order, {
      request: req,
      quantity: req.quantity,
      pendingQuantity: req.quantity,
      type: req.type,
      validity: req.validity,
      price: req.price ?? 0,
      triggerPrice: req.triggerPrice ?? 0,
    });
    this.work(order, instrument);
  }

  async cancelOrder(orderId: string): Promise<void> {
    const order = this.openOrder(orderId);
    this.stopResting(order.id);
    order.status = "CANCELLED";
    this.emit(order);
  }

  async getOrder(orderId: string): Promise<Order> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Unknown order ${orderId}`);
    return publicOrder(order);
  }

  async getOrders(): Promise<Order[]> {
    return [...this.orders.values()].map(publicOrder);
  }

  async getTrades(): Promise<Trade[]> {
    return this.trades.map((t) => ({ ...t }));
  }

  async getPositions(): Promise<Position[]> {
    return [...this.positions.values()].map((p) => {
      const last = this.prices.lastTick(p.instrumentKey)?.ltp ?? p.averagePrice;
      const unrealizedPnl = p.quantity === 0 ? 0 : (last - p.averagePrice) * p.quantity;
      return {
        instrumentKey: p.instrumentKey,
        symbol: p.symbol,
        product: p.product,
        quantity: p.quantity,
        averagePrice: p.averagePrice,
        lastPrice: last,
        realizedPnl: round2(p.realizedPnl),
        unrealizedPnl: round2(unrealizedPnl),
        pnl: round2(p.realizedPnl + unrealizedPnl),
      };
    });
  }

  async getFunds(): Promise<Funds> {
    let realized = 0;
    for (const p of this.positions.values()) realized += p.realizedPnl;
    return { available: round2(this.opts.capital + realized - this.chargesPaid), used: 0 };
  }

  /** Market exits for matching positions, shorts (BUY exits) first, like Upstox's exit API. */
  async exitPositions(filter: ExitPositionsFilter = {}): Promise<PlaceOrderResult> {
    const matching = [...this.positions.values()].filter(
      (p) => p.quantity !== 0 && (!filter.segment || p.segment === filter.segment) && (!filter.tag || p.tags.has(filter.tag)),
    );
    matching.sort((a, b) => Math.sign(a.quantity) - Math.sign(b.quantity)); // shorts first
    const orderIds: string[] = [];
    for (const p of matching) {
      const pending = this.pendingQuantity(p.instrumentKey, p.quantity > 0 ? "SELL" : "BUY", p.product);
      const quantity = Math.abs(p.quantity) - pending;
      if (quantity <= 0) continue;
      const result = await this.placeOrder({
        instrumentKey: p.instrumentKey,
        side: p.quantity > 0 ? "SELL" : "BUY",
        quantity,
        type: "MARKET",
        product: p.product,
      });
      orderIds.push(...result.orderIds);
    }
    return { orderIds };
  }

  async closePosition(instrumentKey: string, opts: ClosePositionOptions = {}): Promise<PlaceOrderResult> {
    const open = [...this.positions.values()].filter(
      (p) => p.instrumentKey === instrumentKey && p.quantity !== 0 && (!opts.product || p.product === opts.product),
    );
    const name = this.instruments.get(instrumentKey)?.symbol ?? instrumentKey;
    if (open.length === 0) throw new Error(`No open ${opts.product ? opts.product + " " : ""}position in ${name}`);
    if (open.length > 1) throw new Error(`${name} has open positions in ${open.map((p) => p.product).join(" and ")}; pass product to choose one`);
    const position = open[0]!;
    const side = position.quantity > 0 ? "SELL" : "BUY";
    const available = Math.abs(position.quantity) - this.pendingQuantity(instrumentKey, side, position.product);
    const quantity = opts.quantity ?? available;
    if (available <= 0) throw new Error(`${name}: the whole position is already being closed by pending orders`);
    if (quantity > available) throw new Error(`${name}: can close at most ${available}, asked for ${quantity}`);
    return this.placeOrder({
      instrumentKey,
      side,
      quantity,
      type: opts.type ?? "MARKET",
      product: position.product,
      ...(opts.price !== undefined ? { price: opts.price } : {}),
      ...(opts.tag ? { tag: opts.tag } : {}),
    });
  }

  onOrderUpdate(handler: (order: Order) => void): void {
    this.orderHandlers.push(handler);
  }

  onPositionUpdate(handler: (update: PositionUpdate) => void): void {
    this.positionHandlers.push(handler);
  }

  // ---------- Matching ----------

  /** Tries to fill now; if the price isn't there yet, waits for ticks. */
  private work(order: PaperOrder, instrument: Instrument): void {
    if (FINAL_ORDER_STATUSES.includes(order.status)) return;
    const tick = this.prices.lastTick(order.instrumentKey);
    if (order.type === "MARKET" && !tick) return this.reject(order, "no market price available for a paper fill");

    if (order.status === "PENDING") {
      order.status = order.type === "SL" || order.type === "SL-M" ? "TRIGGER_PENDING" : "OPEN";
      this.emit(order);
    }
    if (tick && this.tryFill(order, instrument, tick)) return;
    if (!this.resting.has(order.id)) {
      this.resting.set(
        order.id,
        this.prices.onTick(order.instrumentKey, (t) => this.tryFill(order, instrument, t)),
      );
    }
  }

  /** Returns true when the order filled. */
  private tryFill(order: PaperOrder, instrument: Instrument, tick: Tick): boolean {
    if (FINAL_ORDER_STATUSES.includes(order.status)) return true;
    const buy = order.side === "BUY";
    const ask = tick.bestAsk || tick.ltp;
    const bid = tick.bestBid || tick.ltp;

    if (order.status === "TRIGGER_PENDING") {
      const triggered = buy ? tick.ltp >= order.triggerPrice : tick.ltp <= order.triggerPrice;
      if (!triggered) return false;
      order.status = "OPEN";
      this.emit(order);
    }

    let price: number | undefined;
    const marketLike = order.type === "MARKET" || order.type === "SL-M";
    if (marketLike) {
      const slip = (tick.bestAsk && tick.bestBid ? 0 : (this.opts.slippageTicks ?? 1)) * instrument.tickSize;
      price = buy ? ask + slip : Math.max(instrument.tickSize, bid - slip);
    } else if (buy ? ask <= order.price : bid >= order.price) {
      price = buy ? Math.min(order.price, ask) : Math.max(order.price, bid);
    }
    if (price === undefined) return false;

    this.fill(order, instrument, roundToTick(price, instrument.tickSize));
    return true;
  }

  private fill(order: PaperOrder, instrument: Instrument, price: number): void {
    this.stopResting(order.id);
    const charges = estimateCharges(instrument, order.side, order.product, price, order.quantity).total;
    Object.assign(order, { status: "FILLED", filledQuantity: order.quantity, pendingQuantity: 0, averagePrice: price, charges });
    this.chargesPaid += charges;
    this.trades.push({
      id: `${order.id}-T`,
      orderId: order.id,
      instrumentKey: order.instrumentKey,
      symbol: order.symbol,
      side: order.side,
      product: order.product,
      quantity: order.quantity,
      price,
      time: this.now(),
    });
    const position = this.applyFill(order, instrument, price);
    this.emit(order);
    const update: PositionUpdate = {
      instrumentKey: position.instrumentKey,
      product: position.product,
      quantity: position.quantity,
      averagePrice: position.averagePrice,
      buyQuantity: position.buyQuantity,
      sellQuantity: position.sellQuantity,
      buyValue: round2(position.buyValue),
      sellValue: round2(position.sellValue),
    };
    for (const handler of this.positionHandlers) this.safely("position update handler", () => handler(update));
    this.opts.logger?.info("paper fill", { symbol: order.symbol, side: order.side, quantity: order.quantity, price, charges });
  }

  private applyFill(order: PaperOrder, instrument: Instrument, price: number): PaperPosition {
    const id = `${order.instrumentKey}|${order.product}`;
    const p = this.positions.get(id) ?? {
      instrumentKey: order.instrumentKey,
      symbol: instrument.symbol,
      segment: instrument.segment,
      product: order.product,
      quantity: 0,
      averagePrice: 0,
      realizedPnl: 0,
      buyQuantity: 0,
      sellQuantity: 0,
      buyValue: 0,
      sellValue: 0,
      tags: new Set<string>(),
    };
    const signed = order.side === "BUY" ? order.quantity : -order.quantity;
    if (order.side === "BUY") {
      p.buyQuantity += order.quantity;
      p.buyValue += price * order.quantity;
    } else {
      p.sellQuantity += order.quantity;
      p.sellValue += price * order.quantity;
    }

    if (p.quantity === 0 || Math.sign(p.quantity) === Math.sign(signed)) {
      p.averagePrice = (Math.abs(p.quantity) * p.averagePrice + order.quantity * price) / (Math.abs(p.quantity) + order.quantity);
      p.quantity += signed;
      if (order.tag) p.tags.add(order.tag);
    } else {
      const closing = Math.min(order.quantity, Math.abs(p.quantity));
      p.realizedPnl += closing * (price - p.averagePrice) * Math.sign(p.quantity);
      p.quantity += signed;
      if (p.quantity === 0) {
        p.averagePrice = 0;
        p.tags.clear();
      } else if (Math.sign(p.quantity) === Math.sign(signed)) {
        p.averagePrice = price; // flipped sides
        p.tags = new Set(order.tag ? [order.tag] : []);
      }
    }
    this.positions.set(id, p);
    return p;
  }

  // ---------- Helpers ----------

  private openOrder(orderId: string): PaperOrder {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Unknown order ${orderId}`);
    if (FINAL_ORDER_STATUSES.includes(order.status)) throw new Error(`Order ${orderId} is already ${order.status}`);
    return order;
  }

  private pendingQuantity(instrumentKey: string, side: "BUY" | "SELL", product: Order["product"]): number {
    let pending = 0;
    for (const o of this.orders.values()) {
      if (o.instrumentKey === instrumentKey && o.side === side && o.product === product && !FINAL_ORDER_STATUSES.includes(o.status)) {
        pending += o.pendingQuantity;
      }
    }
    return pending;
  }

  private reject(order: PaperOrder, reason: string): void {
    order.status = "REJECTED";
    order.statusMessage = reason;
    this.emit(order);
  }

  private stopResting(orderId: string): void {
    this.resting.get(orderId)?.();
    this.resting.delete(orderId);
  }

  private emit(order: PaperOrder): void {
    const snapshot = publicOrder(order);
    for (const handler of this.orderHandlers) this.safely("order update handler", () => handler(snapshot));
  }

  private safely(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.opts.logger?.error(`${what} failed`, { error: String(err) });
    }
  }
}

function publicOrder(o: PaperOrder): Order {
  const { request: _request, charges: _charges, ...order } = o;
  return { ...order };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
