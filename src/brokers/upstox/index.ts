import type { Broker, BrokerLogin, InstrumentLookup, MarketData } from "../../core/types";
import type { Logger } from "../../utils/logger";
import { exchangeCode, type UpstoxAppCredentials } from "./auth";
import { waitForLogin } from "./login-server";
import { UpstoxHttp, type UpstoxHttpOptions } from "./http";
import { UpstoxMarketDataApi } from "./market-data";
import { UpstoxAccountApi } from "./account";
import { UpstoxOrdersApi } from "./orders";
import { UpstoxMarketFeed, type MarketFeedOptions } from "./market-feed";
import { UpstoxPortfolioFeed } from "./portfolio-feed";
import { UpstoxMarketData } from "./market-data-adapter";
import { UpstoxBroker } from "./broker-adapter";

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
  /** Live order and position updates. */
  portfolioFeed: UpstoxPortfolioFeed;
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
    portfolioFeed: new UpstoxPortfolioFeed(http, { ...opts.feed, logger: opts.logger?.child("upstox:portfolio") }),
  };
}

/** Upstox behind the broker-agnostic MarketData and Broker interfaces. */
export function createUpstoxAdapters(opts: {
  getAccessToken: () => string | undefined;
  instruments: InstrumentLookup;
  logger?: Logger;
}): { marketData: MarketData; broker: Broker } {
  const api = createUpstoxApi({ getAccessToken: opts.getAccessToken, logger: opts.logger });
  return {
    marketData: new UpstoxMarketData(api.marketData, api.feed),
    broker: new UpstoxBroker(api.orders, api.account, opts.instruments, api.portfolioFeed, { logger: opts.logger?.child("upstox:orders") }),
  };
}
