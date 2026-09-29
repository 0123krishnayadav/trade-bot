import { EnvReader, type Env } from "./env";
import { LOG_FORMATS, LOG_LEVELS, type LogFormat, type LogLevel } from "../utils/logger";

export { ConfigError } from "./env";

export const APP_ENVS = ["development", "test", "production"] as const;
export type AppEnv = (typeof APP_ENVS)[number];

export interface Config {
  appEnv: AppEnv;
  log: { level: LogLevel; format: LogFormat };
  db: { path: string };
}

/**
 * Loads settings from environment variables (Bun reads `.env` automatically).
 * Each roadmap step adds its own section here, e.g. `upstox` in step 4.
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
  };

  r.done();
  return config;
}
