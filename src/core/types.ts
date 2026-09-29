// Broker-agnostic domain types. Brokers, strategies and the engine depend only on these.

export type Exchange = "NSE" | "BSE" | "NFO" | "BFO" | "MCX" | "CDS";

/** Intraday (MIS), delivery (CNC) or carry-forward F&O (NRML). */
export type Product = "MIS" | "CNC" | "NRML";

export type Side = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT" | "SL" | "SL-M";
export type OrderStatus = "PENDING" | "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED" | "REJECTED";
export type Timeframe = "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "1d";
export type RunMode = "backtest" | "paper" | "live";

export type InstrumentKind = "index" | "equity" | "future" | "option";
export type OptionType = "CE" | "PE";

/** A tradable (or, for indices, watchable) instrument from the broker's instrument master. */
export interface Instrument {
  /** The broker's id, passed back to the same broker for prices and orders, e.g. "NSE_FO|65923". */
  key: string;
  /** "NSE" | "BSE" | "MCX" */
  exchange: string;
  /** e.g. "NSE_EQ", "NSE_FO", "NSE_INDEX" */
  segment: string;
  kind: InstrumentKind;
  /** Exchange trading symbol, e.g. "RELIANCE", "NIFTY 25000 CE 06 OCT 26". Indices: "NIFTY", "BANKNIFTY". */
  symbol: string;
  name: string;
  /** Derivatives only: the underlying's symbol and key, e.g. "NIFTY" / "NSE_INDEX|Nifty 50". */
  underlying?: string;
  underlyingKey?: string;
  /** Derivatives only: last trading day, YYYY-MM-DD in IST. */
  expiry?: string;
  /** Options only. */
  strike?: number;
  optionType?: OptionType;
  weekly?: boolean;
  /** Units per lot; order quantities must be a multiple of this. 1 for equities. */
  lotSize: number;
  /** Minimum price step in rupees, e.g. 0.05. */
  tickSize: number;
  /** Largest quantity the exchange accepts in one order. */
  freezeQuantity?: number;
  isin?: string;
  /** Equities only: the exchange series, e.g. "EQ" for normal shares, "BE", "SM", or a bond series. */
  series?: string;
}

export interface OptionQuery {
  underlying: string;
  expiry: string;
  strike: number;
  optionType: OptionType;
}

/** Lookups over the instrument master. Strategies use these to turn "NIFTY 25000 CE" into a key. */
export interface InstrumentLookup {
  get(key: string): Instrument | undefined;
  /** By symbol ("NIFTY", "BANKNIFTY", "SENSEX") or full name ("Nifty 50"). */
  findIndex(symbolOrName: string): Instrument | undefined;
  findEquity(symbol: string, exchange?: string): Instrument | undefined;
  /** Upcoming expiries (YYYY-MM-DD, soonest first), counting expiries on or after `from` (default today). */
  expiries(underlying: string, kind: "option" | "future", from?: string): string[];
  /** Every CE and PE for one expiry, sorted by strike. */
  optionChain(underlying: string, expiry: string): Instrument[];
  findOption(query: OptionQuery): Instrument | undefined;
  /** The given expiry, or the nearest one when omitted. */
  findFuture(underlying: string, expiry?: string): Instrument | undefined;
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

/** A logged-in broker session: the access token and when it stops working. */
export interface BrokerSession {
  broker: string;
  userId: string;
  userName?: string;
  accessToken: string;
  issuedAt: Date;
  expiresAt: Date;
}

/** Interactive login, implemented by each broker adapter (e.g. Upstox's daily browser login). */
export interface BrokerLogin {
  /** Starts a login. `onLoginUrl` receives the page the user must open to log in. */
  login(onLoginUrl: (url: string) => void): Promise<BrokerSession>;
}
