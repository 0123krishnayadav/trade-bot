import { EnvReader, type Env } from "./env";
import { LOG_FORMATS, LOG_LEVELS, type LogFormat, type LogLevel } from "../utils/logger";

export { ConfigError } from "./env";

export const APP_ENVS = ["development", "test", "production"] as const;
export type AppEnv = (typeof APP_ENVS)[number];

/** Brokers with an adapter in src/brokers. */
export const BROKERS = ["upstox"] as const;
export type BrokerName = (typeof BROKERS)[number];

export const TRADING_MODES = ["paper", "live"] as const;
export type TradingMode = (typeof TRADING_MODES)[number];

export interface Config {
  appEnv: AppEnv;
  log: { level: LogLevel; format: LogFormat; /** Daily log files go here; undefined = terminal only. */ fileDir?: string };
  db: { path: string };
  /** Which broker the bot uses for market data and orders. */
  broker: BrokerName;
  upstox: {
    apiKey: string;
    apiSecret: string;
    /** Must exactly match the redirect URL saved in the Upstox developer app. */
    redirectUri: string;
  };
  trading: {
    /** paper: live prices, simulated fills. live: real orders. */
    mode: TradingMode;
    capital: number;
  };
  /** Limits checked on every order (src/risk). */
  risk: {
    /** Day's loss (after estimated charges) at which the kill switch turns on. Rupees. */
    maxDailyLoss: number;
    maxLotsPerOrder: number;
    /** Instruments with an open position at the same time. */
    maxOpenPositions: number;
  };
  /** Where alerts go; only the log when Telegram isn't set up. */
  alerts: { telegram?: { botToken: string; chatId: string } };
  /** Daily log files older than this are deleted by the scheduler. */
  logRetentionDays: number;
  /** Overrides for the iron butterfly's defaults (src/strategies/iron-butterfly). */
  ironButterfly: {
    lots: number;
    wingDistance: number;
    stopLossPctOfCapital: number;
    targetPctOfMaxProfit: number;
    minDaysToExpiry: number;
    skipDates: string[];
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
      ...(r.boolean("LOG_TO_FILE", true) ? { fileDir: r.string("LOG_DIR", "./logs") } : {}),
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
    trading: {
      mode: r.oneOf("TRADING_MODE", TRADING_MODES, "paper"),
      capital: r.number("CAPITAL", 500_000, { min: 1 }),
    },
    risk: { maxDailyLoss: 0, maxLotsPerOrder: 0, maxOpenPositions: 0 }, // set below, after capital is known
    alerts: {},
    logRetentionDays: r.number("LOG_RETENTION_DAYS", 30, { integer: true, min: 1 }),
    ironButterfly: {
      lots: r.number("IB_LOTS", 1, { integer: true, min: 1, max: 20 }),
      wingDistance: r.number("IB_WING_DISTANCE", 400, { integer: true, min: 50 }),
      stopLossPctOfCapital: r.number("IB_STOP_LOSS_PCT_OF_CAPITAL", 1, { min: 0.1, max: 10 }),
      targetPctOfMaxProfit: r.number("IB_TARGET_PCT_OF_MAX_PROFIT", 40, { min: 1, max: 100 }),
      minDaysToExpiry: r.number("IB_MIN_DAYS_TO_EXPIRY", 0, { integer: true, min: 0, max: 7 }),
      skipDates: r.dateList("IB_SKIP_DATES"),
    },
  };

  config.risk = {
    maxDailyLoss: r.number("RISK_MAX_DAILY_LOSS", Math.round(config.trading.capital * 0.02), { min: 1 }),
    maxLotsPerOrder: r.number("RISK_MAX_LOTS_PER_ORDER", 10, { integer: true, min: 1 }),
    maxOpenPositions: r.number("RISK_MAX_OPEN_POSITIONS", 8, { integer: true, min: 1 }),
  };
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (botToken && chatId) config.alerts.telegram = { botToken, chatId };
  else if (botToken || chatId) r.fail("set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID for alerts, or neither");

  // Real orders need a second, deliberate setting, so a typo in TRADING_MODE can't send them.
  if (config.trading.mode === "live" && env.LIVE_TRADING_CONFIRM?.trim() !== "yes") {
    r.fail("TRADING_MODE=live places real orders; also set LIVE_TRADING_CONFIRM=yes to allow it");
  }

  r.done();
  return config;
}
