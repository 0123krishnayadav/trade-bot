import { EnvReader, type Env } from "./env";
import { LOG_FORMATS, LOG_LEVELS, type LogFormat, type LogLevel } from "../utils/logger";

export { ConfigError } from "./env";

export const APP_ENVS = ["development", "test", "production"] as const;
export type AppEnv = (typeof APP_ENVS)[number];

/** Brokers with an adapter in src/brokers. */
export const BROKERS = ["upstox"] as const;
export type BrokerName = (typeof BROKERS)[number];

export interface Config {
  appEnv: AppEnv;
  log: { level: LogLevel; format: LogFormat };
  db: { path: string };
  /** Which broker the bot uses for market data and orders. */
  broker: BrokerName;
  upstox: {
    apiKey: string;
    apiSecret: string;
    /** Must exactly match the redirect URL saved in the Upstox developer app. */
    redirectUri: string;
  };
}

/**
 * Loads settings from environment variables (Bun reads `.env` automatically).
 * Each roadmap step adds its own section here.
 */
export function loadConfig(env: Env = process.env): Config {
  const r = new EnvReader(env);
  const appEnv = r.oneOf("APP_ENV", APP_ENVS, "development");

  const config: Config = {
    appEnv,
    log: {
      level: r.oneOf("LOG_LEVEL", LOG_LEVELS, "info"),
      format: r.oneOf("LOG_FORMAT", LOG_FORMATS, appEnv === "production" ? "json" : "pretty"),
    },
    db: {
      path: r.string("DB_PATH", "./db/trade-bot.sqlite"),
    },
    broker: r.oneOf("BROKER", BROKERS, "upstox"),
    // Only broker so far, so always required. Make this conditional on `broker` when a second one is added.
    upstox: {
      apiKey: r.string("UPSTOX_API_KEY"),
      apiSecret: r.string("UPSTOX_API_SECRET"),
      redirectUri: r.url("UPSTOX_REDIRECT_URI", "http://127.0.0.1:5000/callback"),
    },
  };

  r.done();
  return config;
}
