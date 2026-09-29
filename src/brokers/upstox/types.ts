// Upstox request/response shapes, with Upstox's own field names. The adapter (roadmap step 14)
// maps these to the broker-agnostic types in src/core.

/** e.g. "NSE_EQ|INE002A01018" (Reliance), "NSE_INDEX|Nifty 50", "NSE_FO|12345" */
export type InstrumentKey = string;

/** I = intraday, D = delivery / carry-forward (CNC or NRML), MTF = margin trading. */
export type UpstoxProduct = "I" | "D" | "MTF";
export type UpstoxOrderType = "MARKET" | "LIMIT" | "SL" | "SL-M";
export type UpstoxSide = "BUY" | "SELL";
export type UpstoxValidity = "DAY" | "IOC";

// ---------- Candles ----------

export type CandleUnit = "minutes" | "hours" | "days" | "weeks" | "months";

export interface CandleInterval {
  unit: CandleUnit;
  /** minutes: 1–300, hours: 1–5, days/weeks/months: 1 */
  interval: number;
}

export interface UpstoxCandle {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Open interest (0 for non-derivatives). */
  oi: number;
}

// ---------- Account ----------

export interface UpstoxProfile {
  email: string;
  exchanges: string[];
  products: string[];
  broker: string;
  user_id: string;
  user_name: string;
  order_types: string[];
  user_type: string;
  poa: boolean;
  is_active: boolean;
}

export interface UpstoxSegmentFunds {
  used_margin: number;
  payin_amount: number;
  span_margin: number;
  adhoc_margin: number;
  notional_cash: number;
  available_margin: number;
  exposure_margin: number;
}

/** Equity covers stocks and F&O; commodity is MCX. */
export interface UpstoxFunds {
  equity?: UpstoxSegmentFunds;
  commodity?: UpstoxSegmentFunds;
}

export interface UpstoxPosition {
  exchange: string;
  product: UpstoxProduct;
  instrument_token: InstrumentKey;
  trading_symbol: string;
  /** Net quantity; negative = short. */
  quantity: number;
  multiplier: number;
  average_price: number;
  last_price: number;
  close_price: number;
  value: number;
  pnl: number;
  realised: number;
  unrealised: number;
  buy_price: number;
  sell_price: number;
  buy_value: number;
  sell_value: number;
  day_buy_quantity: number;
  day_buy_price: number;
  day_buy_value: number;
  day_sell_quantity: number;
  day_sell_price: number;
  day_sell_value: number;
  overnight_quantity: number;
  overnight_buy_quantity: number;
  overnight_buy_amount: number;
  overnight_sell_quantity: number;
  overnight_sell_amount: number;
}

export interface UpstoxHolding {
  isin: string;
  exchange: string;
  product: UpstoxProduct;
  instrument_token: InstrumentKey;
  trading_symbol: string;
  company_name: string;
  quantity: number;
  t1_quantity: number;
  average_price: number;
  last_price: number;
  close_price: number;
  pnl: number;
  day_change: number;
  day_change_percentage: number;
  cnc_used_quantity: number;
  collateral_quantity: number;
  collateral_type: string;
  haircut: number;
}

// ---------- Regular orders ----------

export interface PlaceOrderRequest {
  instrument_token: InstrumentKey;
  transaction_type: UpstoxSide;
  quantity: number;
  product: UpstoxProduct;
  order_type: UpstoxOrderType;
  /** 0 for MARKET / SL-M. */
  price: number;
  /** 0 unless SL / SL-M. */
  trigger_price: number;
  validity: UpstoxValidity;
  disclosed_quantity?: number;
  is_amo?: boolean;
  /** Our strategy id etc.; shows up in the order book. Max 20 characters. */
  tag?: string;
  /** Let Upstox split quantities above the exchange freeze limit into several orders. */
  slice?: boolean;
}

export interface ModifyOrderRequest {
  order_id: string;
  quantity?: number;
  price: number;
  trigger_price: number;
  order_type: UpstoxOrderType;
  validity: UpstoxValidity;
  disclosed_quantity?: number;
}

export interface ExitPositionsFilter {
  /** Only positions in this segment, e.g. "NSE_FO". */
  segment?: string;
  /** Only positions opened by orders with this tag. Upstox applies tags to intraday positions only. */
  tag?: string;
}

export interface PlaceOrderResult {
  /** Several ids when the order was sliced. */
  orderIds: string[];
  /** Set when some slices failed ("partial_success"); the ids above were still placed. */
  errors?: import("./errors").UpstoxApiError[];
}

/** Lower-case statuses as Upstox reports them, e.g. "open", "complete", "rejected", "trigger pending". */
export interface UpstoxOrder {
  order_id: string;
  exchange_order_id: string | null;
  parent_order_id: string | null;
  exchange: string;
  instrument_token: InstrumentKey;
  trading_symbol: string;
  product: UpstoxProduct;
  order_type: UpstoxOrderType;
  transaction_type: UpstoxSide;
  validity: UpstoxValidity;
  variety: string;
  quantity: number;
  disclosed_quantity: number;
  price: number;
  trigger_price: number;
  average_price: number;
  filled_quantity: number;
  pending_quantity: number;
  status: string;
  status_message: string | null;
  status_message_raw: string | null;
  tag: string | null;
  placed_by: string;
  is_amo: boolean;
  order_request_id: string;
  order_ref_id: string | null;
  /** "2026-10-05 09:20:01" in IST */
  order_timestamp: string;
  exchange_timestamp: string | null;
}

export interface UpstoxTrade {
  trade_id: string;
  order_id: string;
  exchange_order_id: string;
  exchange: string;
  instrument_token: InstrumentKey;
  trading_symbol: string;
  product: UpstoxProduct;
  order_type: UpstoxOrderType;
  transaction_type: UpstoxSide;
  quantity: number;
  average_price: number;
  order_ref_id: string | null;
  order_timestamp: string;
  exchange_timestamp: string;
}

// ---------- GTT (good till triggered) orders ----------

export type GttStrategy = "ENTRY" | "TARGET" | "STOPLOSS";
export type GttTriggerType = "ABOVE" | "BELOW" | "IMMEDIATE";

export interface GttRule {
  strategy: GttStrategy;
  trigger_type: GttTriggerType;
  trigger_price: number;
  /** Trailing stop gap, STOPLOSS rules only. */
  trailing_gap?: number;
}

export interface PlaceGttOrderRequest {
  /** SINGLE: one ENTRY rule. MULTIPLE: ENTRY plus TARGET and/or STOPLOSS. */
  type: "SINGLE" | "MULTIPLE";
  instrument_token: InstrumentKey;
  transaction_type: UpstoxSide;
  quantity: number;
  product: UpstoxProduct;
  rules: GttRule[];
}

export interface ModifyGttOrderRequest {
  gtt_order_id: string;
  type: "SINGLE" | "MULTIPLE";
  quantity: number;
  rules: GttRule[];
}

export interface UpstoxGttOrder {
  gtt_order_id: string;
  type: "SINGLE" | "MULTIPLE";
  exchange: string;
  instrument_token: InstrumentKey;
  trading_symbol: string;
  quantity: number;
  product: UpstoxProduct;
  rules: (GttRule & { status?: string; message?: string; order_id?: string; transaction_type?: UpstoxSide })[];
  /** Epoch milliseconds. */
  created_at: number;
  expires_at: number;
}
