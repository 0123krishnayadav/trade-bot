import type { Notifier } from "../alerts/notifier";
import { estimateCharges } from "../brokers/charges";
import {
  FINAL_ORDER_STATUSES,
  type Broker,
  type ClosePositionOptions,
  type ExitPositionsFilter,
  type InstrumentLookup,
  type Order,
  type OrderChanges,
  type OrderRequest,
  type PlaceOrderResult,
  type PositionUpdate,
} from "../core/types";
import type { TradingStore } from "../store/trading-store";
import type { Logger } from "../utils/logger";
import { istDate } from "../utils/time";

export interface RiskLimits {
  /** The day's loss (after estimated charges) that turns the kill switch on. Rupees, positive. */
  maxDailyLoss: number;
  maxLotsPerOrder: number;
  /** Instruments with an open position at once (pending entry orders count too). */
  maxOpenPositions: number;
}

export interface RiskManagerOptions {
  limits: RiskLimits;
  instruments: InstrumentLookup;
  /** Latest prices, to value open positions. */
  prices: { ltp(instrumentKey: string): number | undefined };
  /** Reads the kill switch, and turns it on when the daily loss limit is hit. */
  store: Pick<TradingStore, "killSwitch" | "activateKillSwitch">;
  notifier?: Notifier;
  logger: Logger;
  now?: () => Date;
  checkIntervalMs?: number;
}

/** Thrown by placeOrder when an order breaks a limit; the strategy sees it as a failed order. */
export class RiskRejection extends Error {
  override name = "RiskRejection";
}

/** One instrument's activity today. */
interface Book {
  net: number;
  /** Sell value minus buy value. */
  cash: number;
  charges: number;
  lastFill: number;
}

/**
 * Wraps the broker (real or paper) with risk checks. Every order passes through placeOrder:
 * orders that add exposure are refused after the kill switch or a daily-loss breach, or when they
 * break the size or position-count limits; orders that reduce a position always go through.
 * The day's P&L is checked every second; at the loss limit the kill switch row is written, and
 * the strategy engine squares everything off from there.
 */
export class RiskManager implements Broker {
  readonly name: string;
  private readonly books = new Map<string, Book>();
  /** orderId -> fills already counted */
  private readonly seen = new Map<string, { filled: number; value: number }>();
  /** Instruments with a pending order that would open a new position: orderId -> instrumentKey. */
  private readonly opening = new Map<string, string>();
  /** Orders already filled, cancelled or rejected (their update can beat placeOrder's result). */
  private readonly finished = new Set<string>();
  private day: string;
  private breached = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly now: () => Date;

  constructor(
    private readonly inner: Broker,
    private readonly opts: RiskManagerOptions,
  ) {
    this.name = inner.name;
    this.now = opts.now ?? (() => new Date());
    this.day = istDate(this.now());
    inner.onOrderUpdate((order) => this.applyOrder(order));
  }

  async start(): Promise<void> {
    await this.inner.start();
    // Today's fills so far (e.g. after a restart in live mode), so the limits see them.
    for (const order of await this.inner.getOrders()) this.applyOrder(order);
    this.timer ??= setInterval(() => this.check(), this.opts.checkIntervalMs ?? 1_000);
  }

  close(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.inner.close();
  }

  async placeOrder(req: OrderRequest): Promise<PlaceOrderResult> {
    this.rollDay();
    const problem = this.vet(req);
    if (problem) {
      this.opts.logger.warn("order refused by risk limits", { instrumentKey: req.instrumentKey, side: req.side, quantity: req.quantity, reason: problem });
      this.opts.notifier?.notify(`🚫 Order refused: ${problem}`);
      throw new RiskRejection(problem);
    }
    const opensNew = (this.books.get(req.instrumentKey)?.net ?? 0) === 0;
    const result = await this.inner.placeOrder(req);
    if (opensNew) for (const id of result.orderIds) if (!this.finished.has(id)) this.opening.set(id, req.instrumentKey);
    return result;
  }

  /** The day's P&L after estimated charges: closed parts at fill prices, open parts at the latest price. */
  dayPnl(): number {
    this.rollDay();
    let pnl = 0;
    for (const [key, b] of this.books) pnl += b.cash - b.charges + b.net * (this.opts.prices.ltp(key) ?? b.lastFill);
    return Math.round(pnl * 100) / 100;
  }

  /** Instruments with an open position, plus those with an order pending that opens one. */
  openPositions(): Set<string> {
    this.rollDay();
    const keys = new Set<string>();
    for (const [key, b] of this.books) if (b.net !== 0) keys.add(key);
    for (const key of this.opening.values()) keys.add(key);
    return keys;
  }

  /** Runs every second: turns the kill switch on when the day's loss reaches the limit. */
  check(): void {
    this.rollDay();
    if (this.breached) return;
    const pnl = this.dayPnl();
    if (pnl > -this.opts.limits.maxDailyLoss) return;
    this.breached = true;
    const source = `risk: daily loss ₹${-pnl} hit the ₹${this.opts.limits.maxDailyLoss} limit`;
    this.opts.logger.error("DAILY LOSS LIMIT hit: turning the kill switch on", { pnl, limit: this.opts.limits.maxDailyLoss });
    try {
      this.opts.store.activateKillSwitch(this.day, source, this.now());
    } catch (err) {
      this.opts.logger.error("could not turn the kill switch on", { error: String(err) });
    }
    this.opts.notifier?.notify(`🛑 Daily loss limit: ₹${-pnl} (limit ₹${this.opts.limits.maxDailyLoss}). Kill switch on.`);
  }

  /** Why the order can't go, or undefined if it may. */
  private vet(req: OrderRequest): string | undefined {
    const instrument = this.opts.instruments.get(req.instrumentKey);
    const lots = instrument ? req.quantity / instrument.lotSize : req.quantity;
    if (lots > this.opts.limits.maxLotsPerOrder) return `${lots} lots is above the ${this.opts.limits.maxLotsPerOrder}-lot limit per order`;

    const net = this.books.get(req.instrumentKey)?.net ?? 0;
    const addsExposure = req.side === "BUY" ? net >= 0 || req.quantity > -net : net <= 0 || req.quantity > net;
    if (!addsExposure) return undefined; // closing or reducing: always allowed

    if (this.breached) return "the daily loss limit was hit today";
    let killSwitch;
    try {
      killSwitch = this.opts.store.killSwitch(this.day);
    } catch {
      killSwitch = undefined; // table missing: nothing was pressed
    }
    if (killSwitch) return "the kill switch is on for today";
    const open = this.openPositions();
    if (!open.has(req.instrumentKey) && open.size + 1 > this.opts.limits.maxOpenPositions) {
      return `would open position ${open.size + 1}, above the limit of ${this.opts.limits.maxOpenPositions}`;
    }
    return undefined;
  }

  private applyOrder(order: Order): void {
    this.rollDay();
    if (istDate(order.placedAt) !== this.day) return; // an earlier day's order
    const before = this.seen.get(order.id) ?? { filled: 0, value: 0 };
    const value = order.filledQuantity * order.averagePrice;
    const qty = order.filledQuantity - before.filled;
    if (qty > 0) {
      const delta = value - before.value;
      const price = delta / qty;
      const book = this.books.get(order.instrumentKey) ?? { net: 0, cash: 0, charges: 0, lastFill: price };
      book.net += order.side === "BUY" ? qty : -qty;
      book.cash += order.side === "BUY" ? -delta : delta;
      book.lastFill = price;
      const instrument = this.opts.instruments.get(order.instrumentKey);
      if (instrument) book.charges += estimateCharges(instrument, order.side, order.product, price, qty).total;
      this.books.set(order.instrumentKey, book);
    }
    this.seen.set(order.id, { filled: order.filledQuantity, value });
    if (FINAL_ORDER_STATUSES.includes(order.status)) {
      this.finished.add(order.id);
      this.opening.delete(order.id);
    }
  }

  /** Intraday limits start fresh each IST day. */
  private rollDay(): void {
    const today = istDate(this.now());
    if (today === this.day) return;
    this.day = today;
    this.books.clear();
    this.seen.clear();
    this.opening.clear();
    this.finished.clear();
    this.breached = false;
  }

  // ---------- Everything else passes straight through ----------

  exitPositions(filter?: ExitPositionsFilter): Promise<PlaceOrderResult> {
    return this.inner.exitPositions(filter);
  }
  closePosition(instrumentKey: string, opts?: ClosePositionOptions): Promise<PlaceOrderResult> {
    return this.inner.closePosition(instrumentKey, opts);
  }
  modifyOrder(orderId: string, changes: OrderChanges): Promise<void> {
    return this.inner.modifyOrder(orderId, changes);
  }
  cancelOrder(orderId: string): Promise<void> {
    return this.inner.cancelOrder(orderId);
  }
  getOrder(orderId: string): Promise<Order> {
    return this.inner.getOrder(orderId);
  }
  getOrders() {
    return this.inner.getOrders();
  }
  getTrades() {
    return this.inner.getTrades();
  }
  getPositions() {
    return this.inner.getPositions();
  }
  getFunds() {
    return this.inner.getFunds();
  }
  onOrderUpdate(handler: (order: Order) => void): void {
    this.inner.onOrderUpdate(handler);
  }
  onPositionUpdate(handler: (update: PositionUpdate) => void): void {
    this.inner.onPositionUpdate(handler);
  }
}
