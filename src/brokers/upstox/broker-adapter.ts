import {
  FINAL_ORDER_STATUSES,
  type Broker,
  type ClosePositionOptions,
  type ExitPositionsFilter,
  type Funds,
  type InstrumentLookup,
  type Order,
  type OrderChanges,
  type OrderRequest,
  type PlaceOrderResult,
  type Position,
  type PositionUpdate,
  type Trade,
} from "../../core/types";
import type { Logger } from "../../utils/logger";
import type { UpstoxAccountApi } from "./account";
import type { UpstoxOrdersApi } from "./orders";
import type { UpstoxPortfolioFeed } from "./portfolio-feed";
import { toFunds, toOrder, toPosition, toPositionUpdate, toTrade, toUpstoxProduct } from "./mappers";
import { UPSTOX_BROKER_NAME } from "./constants";

export interface UpstoxBrokerOptions {
  logger?: Logger;
}

/** Updates for order ids we don't know yet, kept briefly (see handleOrderUpdate). */
const MAX_EARLY_UPDATES = 200;

/**
 * Upstox behind the broker-agnostic Broker interface.
 *
 * Before sending, orders are checked against the instrument master: quantity must be a whole
 * number of lots and prices must sit on the tick grid. Quantities above the exchange freeze limit
 * are sent with slicing on, so Upstox splits them into several orders.
 *
 * Order updates arrive over the portfolio stream only; there is no polling. Upstox doesn't resend
 * updates missed while the stream was down, so after each reconnect the order book is read once.
 */
export class UpstoxBroker implements Broker {
  readonly name = UPSTOX_BROKER_NAME;
  private readonly handlers: ((order: Order) => void)[] = [];
  private readonly positionHandlers: ((update: PositionUpdate) => void)[] = [];
  /** Orders placed here that aren't final yet, with the last state we reported. */
  private readonly working = new Map<string, Order | undefined>();
  /** What was asked for each working order we placed, for orders with no update yet. */
  private readonly requests = new Map<string, OrderRequest>();
  /** Stream updates for orders whose id placeOrder hasn't returned yet (a fast fill can beat the response). */
  private readonly early = new Map<string, Order>();

  constructor(
    private readonly orders: UpstoxOrdersApi,
    private readonly account: UpstoxAccountApi,
    private readonly instruments: InstrumentLookup,
    private readonly feed: UpstoxPortfolioFeed,
    private readonly opts: UpstoxBrokerOptions = {},
  ) {
    feed.onOrder((o) => this.handleOrderUpdate(toOrder(o)));
    feed.onPosition((p) => {
      const update = toPositionUpdate(p);
      for (const handler of this.positionHandlers) this.safely("position update handler", () => handler(update));
    });
    feed.onConnectionChange((connected) => {
      if (connected) void this.catchUp();
    });
  }

  async start(): Promise<void> {
    await this.feed.connect();
  }

  async placeOrder(req: OrderRequest): Promise<PlaceOrderResult> {
    const instrument = this.instruments.get(req.instrumentKey);
    if (!instrument) throw new Error(`Unknown instrument ${req.instrumentKey}; is the instrument master up to date?`);
    if (req.quantity % instrument.lotSize !== 0) {
      throw new Error(`${instrument.symbol}: quantity ${req.quantity} is not a multiple of the lot size ${instrument.lotSize}`);
    }
    for (const [name, value] of [["price", req.price], ["triggerPrice", req.triggerPrice]] as const) {
      if (value !== undefined && !onTick(value, instrument.tickSize)) {
        throw new Error(`${instrument.symbol}: ${name} ${value} is not a multiple of the tick size ${instrument.tickSize}`);
      }
    }

    const result = await this.orders.placeOrder({
      instrument_token: req.instrumentKey,
      transaction_type: req.side,
      quantity: req.quantity,
      product: toUpstoxProduct(req.product),
      order_type: req.type,
      price: req.price ?? 0,
      trigger_price: req.triggerPrice ?? 0,
      validity: req.validity ?? "DAY",
      ...(req.tag ? { tag: req.tag } : {}),
      slice: instrument.freezeQuantity !== undefined && req.quantity > instrument.freezeQuantity,
    });

    this.track(result.orderIds, req);
    return toResult(result);
  }

  async closePosition(instrumentKey: string, opts: ClosePositionOptions = {}): Promise<PlaceOrderResult> {
    const open = (await this.getPositions()).filter(
      (p) => p.instrumentKey === instrumentKey && p.quantity !== 0 && (!opts.product || p.product === opts.product),
    );
    const name = this.instruments.get(instrumentKey)?.symbol ?? instrumentKey;
    if (open.length === 0) throw new Error(`No open ${opts.product ? opts.product + " " : ""}position in ${name}`);
    if (open.length > 1) {
      throw new Error(`${name} has open positions in ${open.map((p) => p.product).join(" and ")}; pass product to choose one`);
    }

    const position = open[0]!;
    const side = position.quantity > 0 ? "SELL" : "BUY";
    const alreadyClosing = this.pendingQuantity(instrumentKey, side, position.product);
    const available = Math.abs(position.quantity) - alreadyClosing;
    const quantity = opts.quantity ?? available;
    if (available <= 0) throw new Error(`${name}: the whole position (${Math.abs(position.quantity)}) is already being closed by pending orders`);
    if (!Number.isInteger(quantity) || quantity <= 0) throw new Error(`${name}: quantity to close must be a positive whole number (got ${quantity})`);
    if (quantity > available) {
      const pending = alreadyClosing ? `, ${alreadyClosing} already being closed by pending orders` : "";
      throw new Error(`${name}: can close at most ${available} (position ${position.quantity}${pending}), asked for ${quantity}`);
    }

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

  async exitPositions(filter: ExitPositionsFilter = {}): Promise<PlaceOrderResult> {
    const result = await this.orders.exitPositions(filter);
    this.track(result.orderIds);
    if (result.errors?.length) this.opts.logger?.error("some positions could not be exited", { errors: result.errors });
    return toResult(result);
  }

  /** Upstox needs the full order on modify, so unchanged fields are taken from the current order. */
  async modifyOrder(orderId: string, changes: OrderChanges): Promise<void> {
    const current = await this.getOrder(orderId);
    await this.orders.modifyOrder({
      order_id: orderId,
      quantity: changes.quantity ?? current.quantity,
      price: changes.price ?? current.price,
      trigger_price: changes.triggerPrice ?? current.triggerPrice,
      order_type: changes.type ?? current.type,
      validity: changes.validity ?? current.validity,
    });
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.orders.cancelOrder(orderId);
  }

  async getOrder(orderId: string): Promise<Order> {
    return toOrder(await this.orders.fetchOrderDetails(orderId));
  }

  async getOrders(): Promise<Order[]> {
    return (await this.orders.fetchOrders()).map(toOrder);
  }

  async getTrades(): Promise<Trade[]> {
    return (await this.orders.fetchTrades()).map(toTrade);
  }

  async getPositions(): Promise<Position[]> {
    return (await this.account.fetchPositions()).map(toPosition);
  }

  async getFunds(): Promise<Funds> {
    return toFunds(await this.account.fetchFunds());
  }

  onOrderUpdate(handler: (order: Order) => void): void {
    this.handlers.push(handler);
  }

  onPositionUpdate(handler: (update: PositionUpdate) => void): void {
    this.positionHandlers.push(handler);
  }

  close(): void {
    this.feed.close();
  }

  /** Starts reporting updates for these orders, including any that arrived before we knew the ids. */
  private track(orderIds: string[], req?: OrderRequest): void {
    for (const [i, id] of orderIds.entries()) {
      this.working.set(id, undefined);
      // A sliced order's parts have unknown sizes until their updates arrive, so the whole
      // quantity is counted against the first part meanwhile (errs towards "already closing").
      if (req) this.requests.set(id, i === 0 ? req : { ...req, quantity: 0 });
      const early = this.early.get(id);
      if (early) {
        this.early.delete(id);
        this.apply(early);
      }
    }
  }

  private handleOrderUpdate(order: Order): void {
    if (this.working.has(order.id)) return this.apply(order);
    // Not ours, or ours but placeOrder hasn't returned the id yet: keep it briefly.
    this.early.set(order.id, order);
    if (this.early.size > MAX_EARLY_UPDATES) this.early.delete(this.early.keys().next().value!);
  }

  /** Reports an order's new state once, ignoring stale snapshots (e.g. an order-book read that lags the stream). */
  private apply(order: Order): void {
    if (!this.working.has(order.id)) return;
    const previous = this.working.get(order.id);
    if (previous && (order.filledQuantity < previous.filledQuantity || !changed(previous, order))) return;
    this.emit(order);
    if (FINAL_ORDER_STATUSES.includes(order.status)) {
      this.working.delete(order.id);
      this.requests.delete(order.id);
    } else this.working.set(order.id, order);
  }

  /** Unfilled quantity of our working orders on one instrument, side and product. */
  private pendingQuantity(instrumentKey: string, side: "BUY" | "SELL", product: OrderRequest["product"]): number {
    let pending = 0;
    for (const [id, order] of this.working) {
      const req = this.requests.get(id);
      const key = order?.instrumentKey ?? req?.instrumentKey;
      const orderSide = order?.side ?? req?.side;
      const orderProduct = order?.product ?? req?.product;
      if (key !== instrumentKey || orderSide !== side || orderProduct !== product) continue;
      pending += order ? order.pendingQuantity : (req?.quantity ?? 0);
    }
    return pending;
  }

  /** One order-book read after a (re)connect, for updates sent while the stream was down. */
  private async catchUp(): Promise<void> {
    if (this.working.size === 0) return;
    try {
      for (const order of await this.getOrders()) this.apply(order);
    } catch (err) {
      this.opts.logger?.error("could not check orders after reconnecting; updates may have been missed", { error: String(err) });
    }
  }

  private emit(order: Order): void {
    for (const handler of this.handlers) this.safely("order update handler", () => handler(order));
  }

  private safely(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.opts.logger?.error(`${what} failed`, { error: String(err) });
    }
  }
}

function toResult(result: { orderIds: string[]; errors?: { message?: string; instrument_key?: string }[] }): PlaceOrderResult {
  if (!result.errors?.length) return { orderIds: result.orderIds };
  const error = result.errors.map((e) => (e.instrument_key ? `${e.instrument_key}: ${e.message}` : e.message)).join("; ");
  return { orderIds: result.orderIds, error };
}

function changed(a: Order, b: Order): boolean {
  return (
    a.status !== b.status ||
    a.filledQuantity !== b.filledQuantity ||
    a.averagePrice !== b.averagePrice ||
    a.quantity !== b.quantity ||
    a.price !== b.price ||
    a.triggerPrice !== b.triggerPrice
  );
}

/** Whether `price` is a whole number of ticks, allowing for floating-point noise (e.g. 20.15 / 0.05). */
function onTick(price: number, tick: number): boolean {
  const ticks = price / tick;
  return Math.abs(ticks - Math.round(ticks)) < 1e-6;
}
