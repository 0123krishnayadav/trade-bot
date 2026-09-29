// Picks the adapter for config.broker. The only place that knows which brokers exist.
import type { BrokerLogin, Instrument } from "../core/types";
import type { Config } from "../config";
import { createUpstoxLogin } from "./upstox";
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
