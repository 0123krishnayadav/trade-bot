import type { Report } from "../../reports/report";

// Request and response shapes of the dashboard API, shared by the server and the React app.

export interface LoginRequest {
  password: string;
  pin: string;
}

export interface ApiErrorBody {
  error: string;
  /** Set when login is locked after too many failures. */
  retryAfterSeconds?: number;
}

export interface MeResponse {
  /** When the current dashboard session ends (ISO). */
  sessionExpiresAt: string;
  mode: "paper" | "live";
}

export interface BrokerStatus {
  name: string;
  /** False when there is no session or it has expired: run `bun run login`. */
  loggedIn: boolean;
  userId?: string;
  userName?: string;
  /** ISO time the broker token stops working. */
  validUntil?: string;
}

export interface StrategyStatus {
  id: string;
  /** e.g. idle, entering, open, exiting, done. */
  phase: string;
  /** IST date the state belongs to, YYYY-MM-DD. */
  date?: string;
  note?: string;
  exitReason?: string;
  /** ISO time the bot last saved this state. */
  updatedAt: string;
  /** Today's trade plan, for strategies that save one (e.g. the iron butterfly). */
  trade?: TradePlan;
}

export interface TradePlan {
  underlying?: string;
  atm?: number;
  expiry?: string;
  /** Spot at entry. */
  spot?: number;
  /** Net premium per unit. */
  credit?: number;
  maxProfit?: number;
  maxLoss?: number;
  /** MTM at which the strategy takes profit / cuts the loss, in rupees. */
  target?: number;
  stopLoss?: number;
  openedAt?: string;
}

export interface StatusResponse {
  serverTime: string;
  mode: "paper" | "live";
  broker: BrokerStatus;
  strategies: StrategyStatus[];
  /** Set when the kill switch is on for today. */
  killSwitch?: { activatedAt: string };
  /** The bot's risk limits (same .env settings and defaults as the bot). */
  risk: { maxDailyLoss: number; maxOpenPositions: number };
  today: {
    date: string;
    closedTrades: number;
    grossPnl: number;
    charges: number;
    netPnl: number;
  };
}

export interface OpenPosition {
  strategyId?: string;
  instrumentKey: string;
  symbol: string;
  /** Net quantity: positive long, negative short. */
  quantity: number;
  /** Average price of the side that opened the position. */
  averagePrice: number;
  /** Latest price the bot recorded; missing until the bot has seen a tick. */
  ltp?: number;
  /** Previous day's close. */
  cp?: number;
  /** ISO time the bot saved that price. */
  priceTime?: string;
  /** Unrealised P&L before charges; missing without a price. */
  pnl?: number;
}

export interface PositionsResponse {
  positions: OpenPosition[];
  /** Sum of the positions' unrealised P&L that have a price. */
  openPnl: number;
  /** Positions without a recorded price (their P&L isn't in openPnl). */
  missingPrices: number;
  /** ISO time of the oldest price used, to judge how fresh openPnl is. */
  pricesAsOf?: string;
  /** False until the bot, restarted on this version, has created the scrips table. */
  pricesRecorded: boolean;
}

export interface KillSwitchRequest {
  /** Must be true: the button's confirm step. */
  confirm: boolean;
}

export interface KillSwitchResponse {
  /** IST date the kill switch holds for, YYYY-MM-DD. */
  tradeDate: string;
  /** ISO time it was first pressed today. */
  activatedAt: string;
}

/** Win rate, expectancy, drawdown, exit reasons and per-day P&L of all closed trades. */
export type HistorySummary = Report;

/** Everything bought (or sold) of one instrument in a trade. */
export interface TradeFill {
  instrumentKey: string;
  symbol: string;
  quantity: number;
  averagePrice: number;
}

export interface HistoryTrade {
  id: number;
  /** IST date, YYYY-MM-DD. */
  tradeDate: string;
  strategyId: string;
  exitReason: string;
  openedAt: string;
  closedAt: string;
  grossPnl: number;
  charges: number;
  netPnl: number;
  bought: TradeFill[];
  sold: TradeFill[];
}

export interface HistoryResponse {
  summary: HistorySummary;
  /** Newest first. */
  trades: HistoryTrade[];
}

export interface MarketResponse {
  /** The index the strategies trade, from the bot's latest recorded price. */
  index?: { symbol: string; ltp: number; cp: number; change: number; changePct: number; updatedAt: string };
  today: {
    date: string;
    /** pre-open: a trading day before the open · open · closed: after the close, or not a trading day. */
    status: "pre-open" | "open" | "closed";
    session?: { open: string; close: string };
    /** Holiday or special-session name, when today has one. */
    note?: string;
  };
  nextTradingDay?: string;
  /** True until the holiday list has been downloaded: holidays are unknown, so no next trading day is given. */
  holidaysMissing: boolean;
  /** The next few days the market is closed or has special hours. */
  upcoming: { date: string; description: string; special: boolean }[];
  /** When the bot last wrote a price; a fresh time means the bot is running and connected. */
  pricesUpdatedAt?: string;
}

export interface TodayOrder {
  id: string;
  strategyId?: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  filledQuantity: number;
  averagePrice: number;
  status: string;
  statusMessage?: string;
  placedAt: string;
}

export interface OrdersResponse {
  orders: TodayOrder[];
}
