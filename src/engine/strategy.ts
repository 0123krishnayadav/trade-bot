import type {
  Candle,
  ClosePositionOptions,
  Funds,
  InstrumentLookup,
  Order,
  OrderChanges,
  OrderRequest,
  PlaceOrderResult,
  Position,
  RunMode,
  SubscriptionMode,
  Tick,
  Timeframe,
} from "../core/types";
import type { TradeRecord } from "../store/trading-store";
import type { Logger } from "../utils/logger";

/**
 * A trading strategy. The engine calls these one at a time per strategy (never concurrently), so
 * a strategy doesn't need locks: a new tick waits until the previous handler has finished.
 */
export interface Strategy {
  /** Unique name, also used as the order tag: at most 20 characters. */
  readonly id: string;
  /** Subscribe to instruments, restore saved state. */
  start(ctx: StrategyContext): Promise<void> | void;
  /** Ticks for instruments this strategy subscribed to (only the latest is delivered if it falls behind). */
  onTick?(tick: Tick, ctx: StrategyContext): Promise<void> | void;
  /** Completed candles for series requested with ctx.watchCandles. */
  onCandle?(candle: Candle, ctx: StrategyContext): Promise<void> | void;
  /** Status changes of orders this strategy placed. */
  onOrderUpdate?(order: Order, ctx: StrategyContext): Promise<void> | void;
  /** Every second, for time-based rules (entry at 09:20, exit at 15:15) even when no ticks arrive. */
  onClock?(now: Date, ctx: StrategyContext): Promise<void> | void;
  /** On shutdown: square off or save state. */
  stop?(ctx: StrategyContext): Promise<void> | void;
}

/** Everything a strategy may use. Orders are tagged with the strategy id automatically. */
export interface StrategyContext {
  readonly strategyId: string;
  readonly mode: RunMode;
  readonly instruments: InstrumentLookup;
  readonly log: Logger;
  now(): Date;

  // Market data
  subscribe(instrumentKeys: string[], mode?: SubscriptionMode): void;
  unsubscribe(instrumentKeys?: string[]): void;
  ltp(instrumentKey: string): number | undefined;
  lastTick(instrumentKey: string): Tick | undefined;
  candles(instrumentKey: string, timeframe: Timeframe, count: number): Promise<Candle[]>;
  /** Delivers each completed candle of this series to onCandle. */
  watchCandles(instrumentKey: string, timeframe: Timeframe): void;

  // Orders
  placeOrder(req: Omit<OrderRequest, "tag">): Promise<PlaceOrderResult>;
  modifyOrder(orderId: string, changes: OrderChanges): Promise<void>;
  cancelOrder(orderId: string): Promise<void>;
  closePosition(instrumentKey: string, opts?: Omit<ClosePositionOptions, "tag">): Promise<PlaceOrderResult>;
  /** Waits until every order is final (filled/cancelled/rejected) or the timeout passes; returns their latest states. */
  waitForOrders(orderIds: string[], timeoutMs: number): Promise<Order[]>;
  positions(): Promise<Position[]>;
  funds(): Promise<Funds>;

  // Records
  recordTrade(trade: Omit<TradeRecord, "strategyId">): void;
  loadState<T>(): T | undefined;
  /** Saves state for restarts; undefined clears it. */
  saveState(state: unknown): void;
}
