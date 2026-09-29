// Picks the adapter for config.broker. The only place that knows which brokers exist.
import type { Broker, BrokerLogin, Instrument, InstrumentLookup, MarketData } from "../core/types";
import type { Logger } from "../utils/logger";
import type { Config } from "../config";
import { createUpstoxAdapters, createUpstoxLogin } from "./upstox";
import { downloadUpstoxInstruments } from "./upstox/instruments";

export function createBrokerLogin(config: Config): BrokerLogin {
  switch (config.broker) {
    case "upstox":
      return createUpstoxLogin(config.upstox);
    default: {
      const unknown: never = config.broker;
      throw new Error(`No login for broker "${unknown}"`);
    }
  }
}

/** Today's instrument master from the configured broker. */
export function downloadInstruments(config: Config): Promise<Instrument[]> {
  switch (config.broker) {
    case "upstox":
      return downloadUpstoxInstruments();
    default: {
      const unknown: never = config.broker;
      throw new Error(`No instrument download for broker "${unknown}"`);
    }
  }
}

export interface BrokerAdapters {
  marketData: MarketData;
  broker: Broker;
}

/** Market data and order access for the configured broker; engines use only these interfaces. */
export function createBrokerAdapters(
  config: Config,
  deps: { getAccessToken: () => string | undefined; instruments: InstrumentLookup; logger?: Logger },
): BrokerAdapters {
  switch (config.broker) {
    case "upstox":
      return createUpstoxAdapters(deps);
    default: {
      const unknown: never = config.broker;
      throw new Error(`No adapters for broker "${unknown}"`);
    }
  }
}
