// Every Upstox URL the adapter uses. Add new endpoints here, not inline in the calling code.

/** Name this adapter uses for itself, e.g. as the key for saved sessions. Matches BROKER=upstox in config. */
export const UPSTOX_BROKER_NAME = "upstox";

export const UPSTOX_HOSTS = {
  /** Everything except placing, modifying and cancelling regular orders. */
  api: "https://api.upstox.com",
  /** Low-latency host for placing, modifying and cancelling regular orders. */
  hft: "https://api-hft.upstox.com",
} as const;

export type UpstoxHost = keyof typeof UPSTOX_HOSTS;

/** Kept for the login code, which only talks to the main host. */
export const UPSTOX_API_BASE = UPSTOX_HOSTS.api;

export const UPSTOX_ENDPOINTS = {
  // Login
  /** Browser login page; redirects back with ?code=... */
  authorize: "/v2/login/authorization/dialog",
  /** Exchanges the login code for an access token. */
  token: "/v2/login/authorization/token",

  // Account
  profile: "/v2/user/profile",
  fundsAndMargin: "/v2/user/get-funds-and-margin",
  positions: "/v2/portfolio/short-term-positions",
  holdings: "/v2/portfolio/long-term-holdings",

  // Regular orders (place/modify/cancel go to the hft host)
  placeOrder: "/v3/order/place",
  modifyOrder: "/v3/order/modify",
  cancelOrder: "/v3/order/cancel",
  orderBook: "/v2/order/retrieve-all",
  /** Squares off open positions with MARKET orders; main host, not hft. */
  exitPositions: "/v2/order/positions/exit",
  orderDetails: "/v2/order/details",
  tradesForDay: "/v2/order/trades/get-trades-for-day",

  // GTT (good till triggered) orders
  gttPlace: "/v3/order/gtt/place",
  gttModify: "/v3/order/gtt/modify",
  gttCancel: "/v3/order/gtt/cancel",
  gttOrders: "/v3/order/gtt",

  // Candles; instrument key and dates are appended as path segments
  historicalCandles: "/v3/historical-candle",
  intradayCandles: "/v3/historical-candle/intraday",

  // Live websockets; each authorize call returns a one-time wss:// URL
  marketFeedAuthorize: "/v3/feed/market-data-feed/authorize",
  /** Order, position, holding and GTT updates (JSON messages). */
  portfolioFeedAuthorize: "/v2/feed/portfolio-stream-feed/authorize",
} as const;

/** Daily instrument master for all exchanges (gzipped JSON, public, refreshed every morning). */
export const UPSTOX_INSTRUMENTS_URL = "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

/** Full URL for an endpoint on the main host, e.g. upstoxUrl(UPSTOX_ENDPOINTS.token). */
export function upstoxUrl(path: string, host: UpstoxHost = "api"): string {
  return new URL(path, UPSTOX_HOSTS[host]).toString();
}
