// Broker-agnostic domain types. Brokers, strategies and the engine depend only on these.

// ---------- Instruments ----------

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

// ---------- Market data ----------

export type Timeframe = "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "1d";

export interface Candle {
  instrumentKey: string;
  timeframe: Timeframe;
  /** Candle open time. */
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Open interest; 0 for non-derivatives. */
  oi: number;
}

/** ltp: price only (cheapest). full: price, depth, volume, OI. greeks: price, best bid/ask, OI, IV, greeks. */
export type SubscriptionMode = "ltp" | "full" | "greeks";

export interface Greeks {
  delta: number;
  theta: number;
  gamma: number;
  vega: number;
  rho: number;
}

export interface Tick {
  instrumentKey: string;
  ltp: number;
  /** Last trade time. */
  time: Date;
  /** Previous session's close. */
  prevClose: number;
  /** Only in "full"/"greeks" modes: */
  volume?: number;
  oi?: number;
  iv?: number;
  greeks?: Greeks;
  bestBid?: number;
  bestAsk?: number;
}

/** Live prices and candles from the broker. The MarketEngine is the only thing that uses this directly. */
export interface MarketData {
  connect(): Promise<void>;
  disconnect(): void;
  /** Safe to call before connect(); subscriptions are (re)sent whenever the connection opens. */
  subscribe(instrumentKeys: string[], mode?: SubscriptionMode): void;
  unsubscribe(instrumentKeys: string[]): void;
  onTick(handler: (tick: Tick) => void): void;
  onConnectionChange(handler: (connected: boolean) => void): void;
  /** Candles between two IST dates (inclusive, YYYY-MM-DD), oldest first. Includes today's so far when `to` is today. */
  getCandles(instrumentKey: string, timeframe: Timeframe, from: string, to: string): Promise<Candle[]>;
}

// ---------- Market calendar ----------

/**
 * A day the F&O market is closed, or open at unusual hours (e.g. a Sunday budget session or
 * Diwali muhurat trading). Regular weekdays aren't listed.
 */
export interface MarketHoliday {
  /** IST date, YYYY-MM-DD. */
  date: string;
  description: string;
  /** When F&O trades that day; undefined when it's closed all day. */
  session?: { open: Date; close: Date };
}

// ---------- Orders and portfolio ----------

/** MIS: intraday. CNC: equity delivery. NRML: carry-forward F&O. MTF: margin trading. */
export type Product = "MIS" | "CNC" | "NRML" | "MTF";
export type Side = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT" | "SL" | "SL-M";
export type Validity = "DAY" | "IOC";

/**
 * PENDING: accepted by the broker, not yet at the exchange. OPEN: waiting at the exchange.
 * TRIGGER_PENDING: stop-loss waiting for its trigger. PARTIALLY_FILLED: open with some quantity filled.
 * FILLED, CANCELLED, REJECTED are final (a cancelled order may still have filled partly).
 */
export type OrderStatus = "PENDING" | "OPEN" | "TRIGGER_PENDING" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED" | "REJECTED";

export const FINAL_ORDER_STATUSES: readonly OrderStatus[] = ["FILLED", "CANCELLED", "REJECTED"];

export type RunMode = "backtest" | "paper" | "live";

export interface OrderRequest {
  instrumentKey: string;
  side: Side;
  quantity: number;
  type: OrderType;
  product: Product;
  /** LIMIT and SL only. */
  price?: number;
  /** SL and SL-M only. */
  triggerPrice?: number;
  /** Default DAY. */
  validity?: Validity;
  /** Free text shown in the broker's order book, e.g. the strategy id. Max 20 characters. */
  tag?: string;
}

export interface OrderChanges {
  quantity?: number;
  price?: number;
  triggerPrice?: number;
  type?: OrderType;
  validity?: Validity;
}

export interface ClosePositionOptions {
  /** How much to close; default the whole position. */
  quantity?: number;
  /** Default MARKET. */
  type?: "MARKET" | "LIMIT";
  /** Required for LIMIT. */
  price?: number;
  /** Needed only when the instrument has open positions in more than one product (e.g. MIS and NRML). */
  product?: Product;
  tag?: string;
}

/** Which open positions to square off; everything when empty. */
export interface ExitPositionsFilter {
  /** e.g. "NSE_FO" for F&O only. */
  segment?: string;
  /** Positions opened by orders with this tag (e.g. a strategy id). Intraday positions only. */
  tag?: string;
}

export interface PlaceOrderResult {
  /** More than one when the broker split a large order into several (above the exchange freeze limit). */
  orderIds: string[];
  /** Set when some of the split orders failed; the ids above were still placed. */
  error?: string;
}

export interface Order {
  id: string;
  instrumentKey: string;
  symbol: string;
  side: Side;
  type: OrderType;
  product: Product;
  validity: Validity;
  quantity: number;
  price: number;
  triggerPrice: number;
  status: OrderStatus;
  filledQuantity: number;
  pendingQuantity: number;
  /** Average fill price; 0 until something fills. */
  averagePrice: number;
  /** Broker or exchange message, e.g. the rejection reason. */
  statusMessage?: string;
  tag?: string;
  placedAt: Date;
}

/** One execution (fill). An order can have several. */
export interface Trade {
  id: string;
  orderId: string;
  instrumentKey: string;
  symbol: string;
  side: Side;
  product: Product;
  quantity: number;
  price: number;
  time: Date;
}

export interface Position {
  instrumentKey: string;
  symbol: string;
  product: Product;
  /** Net quantity; negative = short. */
  quantity: number;
  averagePrice: number;
  lastPrice: number;
  realizedPnl: number;
  unrealizedPnl: number;
  pnl: number;
}

/** A change in net position, as the broker reports it right after a fill. P&L comes from live prices. */
export interface PositionUpdate {
  instrumentKey: string;
  product: Product;
  /** Net quantity; negative = short. */
  quantity: number;
  averagePrice: number;
  buyQuantity: number;
  sellQuantity: number;
  buyValue: number;
  sellValue: number;
}

export interface Funds {
  /** Margin available for new trades (equity + F&O segment). */
  available: number;
  used: number;
}

/** Orders and portfolio at the broker. Real brokers and the paper broker both implement this. */
export interface Broker {
  readonly name: string;
  /** Opens the live order/position stream, if the broker has one. Call once before trading. */
  start(): Promise<void>;
  placeOrder(req: OrderRequest): Promise<PlaceOrderResult>;
  /**
   * Squares off open positions at market, closing shorts before longs. For kill switches and
   * end-of-day exits. Returns the exit order ids; their fills arrive through onOrderUpdate.
   */
  exitPositions(filter?: ExitPositionsFilter): Promise<PlaceOrderResult>;
  /**
   * Squares off one instrument's open position with an opposite order (SELL to close a long, BUY
   * to close a short) in the same product. Never closes more than is open and not already being
   * closed by a pending order.
   */
  closePosition(instrumentKey: string, opts?: ClosePositionOptions): Promise<PlaceOrderResult>;
  modifyOrder(orderId: string, changes: OrderChanges): Promise<void>;
  cancelOrder(orderId: string): Promise<void>;
  getOrder(orderId: string): Promise<Order>;
  /** Today's orders. */
  getOrders(): Promise<Order[]>;
  /** Today's fills. */
  getTrades(): Promise<Trade[]>;
  getPositions(): Promise<Position[]>;
  getFunds(): Promise<Funds>;
  /** Called whenever an order placed through this broker changes status or fills more. */
  onOrderUpdate(handler: (order: Order) => void): void;
  /** Called when a position's net quantity changes (any fill in the account). */
  onPositionUpdate(handler: (update: PositionUpdate) => void): void;
  /** Closes the stream and stops background work. */
  close(): void;
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
