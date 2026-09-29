import { expect, test } from "bun:test";
import { ConfigError, loadConfig } from "../src/config";

const UPSTOX = { UPSTOX_API_KEY: "key", UPSTOX_API_SECRET: "secret" };

test("uses defaults for everything except the Upstox app keys", () => {
  expect(loadConfig(UPSTOX)).toEqual({
    appEnv: "development",
    log: { level: "info", format: "pretty" },
    db: { path: "./db/trade-bot.sqlite" },
    broker: "upstox",
    upstox: { apiKey: "key", apiSecret: "secret", redirectUri: "http://127.0.0.1:5000/callback" },
  });
});

test("reads values from the environment and trims them", () => {
  const config = loadConfig({ ...UPSTOX, APP_ENV: "production", LOG_LEVEL: " debug ", DB_PATH: "/data/bot.sqlite" });
  expect(config.appEnv).toBe("production");
  expect(config.log).toEqual({ level: "debug", format: "json" }); // json by default in production
  expect(config.db.path).toBe("/data/bot.sqlite");
});

test("treats empty values as unset", () => {
  expect(loadConfig({ ...UPSTOX, LOG_LEVEL: "" }).log.level).toBe("info");
});

function problems(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as ConfigError).problems;
  }
  throw new Error("expected loadConfig to throw");
}

test("reports every problem at once", () => {
  expect(problems({ APP_ENV: "prod", LOG_LEVEL: "verbose", BROKER: "zerodha" })).toEqual([
    'APP_ENV must be one of development, test, production (got "prod")',
    'LOG_LEVEL must be one of debug, info, warn, error (got "verbose")',
    'BROKER must be one of upstox (got "zerodha")',
    "UPSTOX_API_KEY is required",
    "UPSTOX_API_SECRET is required",
  ]);
});

test("validates the redirect URL", () => {
  expect(problems({ ...UPSTOX, UPSTOX_REDIRECT_URI: "127.0.0.1:5000/callback" })).toEqual([
    'UPSTOX_REDIRECT_URI must be a full URL like http://127.0.0.1:5000/callback (got "127.0.0.1:5000/callback")',
  ]);
  expect(problems({ ...UPSTOX, UPSTOX_REDIRECT_URI: "ftp://127.0.0.1/callback" })).toEqual([
    'UPSTOX_REDIRECT_URI must start with http:// or https:// (got "ftp://127.0.0.1/callback")',
  ]);
});
