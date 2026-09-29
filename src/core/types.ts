// Broker-agnostic domain types. Brokers, strategies and the engine depend only on these.

export type Exchange = "NSE" | "BSE" | "NFO" | "BFO" | "MCX" | "CDS";

/** Intraday (MIS), delivery (CNC) or carry-forward F&O (NRML). */
export type Product = "MIS" | "CNC" | "NRML";

export type Side = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT" | "SL" | "SL-M";
export type OrderStatus = "PENDING" | "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED" | "REJECTED";
export type Timeframe = "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "1d";
export type RunMode = "backtest" | "paper" | "live";

export interface Instrument {
  symbol: string; // e.g. "RELIANCE", "NIFTY25OCT25000CE"
  exchange: Exchange;
  lotSize: number;
  tickSize: number;
}

export interface Candle {
  symbol: string;
  timeframe: Timeframe;
  time: Date; // candle open time
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Tick {
  symbol: string;
  time: Date;
  ltp: number;
  volume?: number;
}

export interface OrderRequest {
  symbol: string;
  exchange: Exchange;
  side: Side;
  quantity: number;
  type: OrderType;
  product: Product;
  price?: number; // LIMIT / SL
  triggerPrice?: number; // SL / SL-M
  tag?: string; // strategy id, for tracing
}

export interface Order extends OrderRequest {
  id: string;
  status: OrderStatus;
  filledQuantity: number;
  averagePrice: number;
  createdAt: Date;
  updatedAt: Date;
  rejectReason?: string;
}

export interface Position {
  symbol: string;
  exchange: Exchange;
  product: Product;
  quantity: number; // negative = short
  averagePrice: number;
  realizedPnl: number;
}

export interface Funds {
  available: number;
  used: number;
}

/** Every broker adapter (paper, Zerodha, Upstox, ...) implements this. */
export interface Broker {
  readonly name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  placeOrder(req: OrderRequest): Promise<Order>;
  modifyOrder(id: string, changes: Partial<Pick<OrderRequest, "quantity" | "price" | "triggerPrice" | "type">>): Promise<Order>;
  cancelOrder(id: string): Promise<Order>;
  getOrders(): Promise<Order[]>;
  getPositions(): Promise<Position[]>;
  getFunds(): Promise<Funds>;
  onOrderUpdate(handler: (order: Order) => void): void;
}

/** Source of market data: historical file/API for backtests, broker websocket for paper/live. */
export interface DataFeed {
  subscribe(symbols: string[], timeframe: Timeframe): Promise<void>;
  onCandle(handler: (candle: Candle) => void): void;
  onTick?(handler: (tick: Tick) => void): void;
  getHistory(symbol: string, timeframe: Timeframe, from: Date, to: Date): Promise<Candle[]>;
}

/** What a strategy can see and do. The engine supplies it; strategies never touch a broker directly. */
export interface StrategyContext {
  mode: RunMode;
  now(): Date;
  history(symbol: string, count: number): Candle[];
  position(symbol: string): Position | undefined;
  buy(symbol: string, quantity: number, opts?: Partial<OrderRequest>): Promise<Order>;
  sell(symbol: string, quantity: number, opts?: Partial<OrderRequest>): Promise<Order>;
  log(message: string, data?: unknown): void;
}

export interface Strategy {
  readonly id: string;
  readonly symbols: string[];
  readonly timeframe: Timeframe;
  init?(ctx: StrategyContext): Promise<void> | void;
  onCandle(candle: Candle, ctx: StrategyContext): Promise<void> | void;
  onTick?(tick: Tick, ctx: StrategyContext): Promise<void> | void;
  onOrderUpdate?(order: Order, ctx: StrategyContext): Promise<void> | void;
  stop?(ctx: StrategyContext): Promise<void> | void;
}
