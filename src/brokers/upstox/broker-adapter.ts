import {
  FINAL_ORDER_STATUSES,
  type Broker,
  type Funds,
  type InstrumentLookup,
  type Order,
  type OrderChanges,
  type OrderRequest,
  type PlaceOrderResult,
  type Position,
  type Trade,
} from "../../core/types";
import type { Logger } from "../../utils/logger";
import type { UpstoxAccountApi } from "./account";
import type { UpstoxOrdersApi } from "./orders";
import { toFunds, toOrder, toPosition, toTrade, toUpstoxProduct } from "./mappers";
import { UPSTOX_BROKER_NAME } from "./constants";

export interface UpstoxBrokerOptions {
  logger?: Logger;
  /** How often to check the order book while orders are working. Replaced by the order websocket in step 13. */
  pollIntervalMs?: number;
}

/**
 * Upstox behind the broker-agnostic Broker interface.
 *
 * Before sending, orders are checked against the instrument master: quantity must be a whole
 * number of lots and prices must sit on the tick grid. Quantities above the exchange freeze limit
 * are sent with slicing on, so Upstox splits them into several orders.
 */
export class UpstoxBroker implements Broker {
  readonly name = UPSTOX_BROKER_NAME;
  private readonly handlers: ((order: Order) => void)[] = [];
  /** Orders placed here that aren't final yet, with the last state we reported. */
  private readonly working = new Map<string, Order | undefined>();
  private pollTimer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(
    private readonly orders: UpstoxOrdersApi,
    private readonly account: UpstoxAccountApi,
    private readonly instruments: InstrumentLookup,
    private readonly opts: UpstoxBrokerOptions = {},
  ) {}

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

    for (const id of result.orderIds) this.working.set(id, undefined);
    this.schedulePoll();
    return result.errors?.length
      ? { orderIds: result.orderIds, error: result.errors.map((e) => e.message).join("; ") }
      : { orderIds: result.orderIds };
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
    this.schedulePoll();
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.orders.cancelOrder(orderId);
    this.schedulePoll();
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

  close(): void {
    this.closed = true;
    clearTimeout(this.pollTimer);
  }

  private schedulePoll(): void {
    if (this.closed || this.pollTimer || this.working.size === 0) return;
    this.pollTimer = setTimeout(() => void this.poll(), this.opts.pollIntervalMs ?? 1000);
  }

  private async poll(): Promise<void> {
    try {
      for (const order of await this.getOrders()) {
        if (!this.working.has(order.id)) continue;
        const previous = this.working.get(order.id);
        if (!previous || changed(previous, order)) this.emit(order);
        if (FINAL_ORDER_STATUSES.includes(order.status)) this.working.delete(order.id);
        else this.working.set(order.id, order);
      }
    } catch (err) {
      this.opts.logger?.warn("order status poll failed, will retry", { error: String(err) });
    } finally {
      this.pollTimer = undefined;
      this.schedulePoll();
    }
  }

  private emit(order: Order): void {
    for (const handler of this.handlers) {
      try {
        handler(order);
      } catch (err) {
        this.opts.logger?.error("order update handler failed", { error: String(err) });
      }
    }
  }
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
