import { EnvReader, type Env } from "../config/env";
import { APP_ENVS, BROKERS, TRADING_MODES, type AppEnv, type BrokerName, type TradingMode } from "../config";

export interface DashboardConfig {
  appEnv: AppEnv;
  host: string;
  port: number;
  /** The bot's SQLite file; the dashboard only reads it. */
  dbPath: string;
  broker: BrokerName;
  mode: TradingMode;
  /** argon2 hashes from `bun run dashboard:setup`, stored base64-encoded so `$` survives .env. */
  passwordHash: string;
  pinHash: string;
  /** Signs the session cookie. Changing it logs out every session. */
  sessionSecret: string;
  sessionHours: number;
  /** Send the cookie only over HTTPS. Turn on when the dashboard is served through HTTPS. */
  secureCookie: boolean;
}

/** Dashboard settings. Separate from the bot's config so the dashboard needs no broker API keys. */
export function loadDashboardConfig(env: Env = process.env): DashboardConfig {
  const r = new EnvReader(env);
  const config: DashboardConfig = {
    appEnv: r.oneOf("APP_ENV", APP_ENVS, "development"),
    host: r.string("DASHBOARD_HOST", "127.0.0.1"),
    port: r.number("DASHBOARD_PORT", 4000, { integer: true, min: 1, max: 65535 }),
    dbPath: r.string("DB_PATH", "./db/trade-bot.sqlite"),
    broker: r.oneOf("BROKER", BROKERS, "upstox"),
    mode: r.oneOf("TRADING_MODE", TRADING_MODES, "paper"),
    passwordHash: decodeHash(r, "DASHBOARD_PASSWORD_HASH"),
    pinHash: decodeHash(r, "DASHBOARD_PIN_HASH"),
    sessionSecret: r.string("DASHBOARD_SESSION_SECRET"),
    sessionHours: r.number("DASHBOARD_SESSION_HOURS", 24, { min: 1, max: 24 * 30 }),
    secureCookie: r.boolean("DASHBOARD_SECURE_COOKIE", false),
  };
  if (config.sessionSecret && config.sessionSecret.length < 32) r.fail("DASHBOARD_SESSION_SECRET must be at least 32 characters");
  r.done();
  return config;
}

function decodeHash(r: EnvReader, name: string): string {
  const raw = r.string(name);
  if (!raw) return raw;
  const hash = Buffer.from(raw, "base64").toString("utf8");
  if (!hash.startsWith("$argon2")) r.fail(`${name} is not a hash from \`bun run dashboard:setup\``);
  return hash;
}
