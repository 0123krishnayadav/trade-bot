import type { BrokerLogin } from "../../core/types";
import type { Logger } from "../../utils/logger";
import { exchangeCode, type UpstoxAppCredentials } from "./auth";
import { waitForLogin } from "./login-server";
import { UpstoxHttp, type UpstoxHttpOptions } from "./http";
import { UpstoxMarketDataApi } from "./market-data";
import { UpstoxAccountApi } from "./account";
import { UpstoxOrdersApi } from "./orders";
import { UpstoxMarketFeed, type MarketFeedOptions } from "./market-feed";

/** Upstox's daily browser login: open the link, log in, the local callback saves the token. */
export function createUpstoxLogin(creds: UpstoxAppCredentials): BrokerLogin {
  return {
    login: (onLoginUrl) =>
      waitForLogin({
        apiKey: creds.apiKey,
        redirectUri: creds.redirectUri,
        exchange: (code) => exchangeCode(creds, code),
        onAuthorizeUrl: onLoginUrl,
      }),
  };
}

export interface UpstoxApi {
  marketData: UpstoxMarketDataApi;
  account: UpstoxAccountApi;
  orders: UpstoxOrdersApi;
  /** Live prices; call feed.connect() before subscribing. */
  feed: UpstoxMarketFeed;
}

/** All Upstox REST APIs and the live feed, sharing one HTTP client (and so one rate limit). */
export function createUpstoxApi(
  opts: { getAccessToken: () => string | undefined; logger?: Logger } & Omit<UpstoxHttpOptions, "getAccessToken" | "logger"> & {
      feed?: Omit<MarketFeedOptions, "logger">;
    },
): UpstoxApi {
  const http = new UpstoxHttp({ ...opts, logger: opts.logger?.child("upstox") });
  return {
    marketData: new UpstoxMarketDataApi(http),
    account: new UpstoxAccountApi(http),
    orders: new UpstoxOrdersApi(http),
    feed: new UpstoxMarketFeed(http, { ...opts.feed, logger: opts.logger?.child("upstox:feed") }),
  };
}
