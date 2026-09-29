// Picks the adapter for config.broker. The only place that knows which brokers exist.
import type { BrokerLogin } from "../core/types";
import type { Config } from "../config";
import { createUpstoxLogin } from "./upstox";

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
