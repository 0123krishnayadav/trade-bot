import { expect, test } from "bun:test";
import { ConfigError, loadConfig } from "../src/config";

test("uses defaults when nothing is set", () => {
  expect(loadConfig({})).toEqual({
    appEnv: "development",
    log: { level: "info", format: "pretty" },
    db: { path: "./db/trade-bot.sqlite" },
  });
});

test("reads values from the environment and trims them", () => {
  const config = loadConfig({ APP_ENV: "production", LOG_LEVEL: " debug ", DB_PATH: "/data/bot.sqlite" });
  expect(config.appEnv).toBe("production");
  expect(config.log).toEqual({ level: "debug", format: "json" }); // json by default in production
  expect(config.db.path).toBe("/data/bot.sqlite");
});

test("treats empty values as unset", () => {
  expect(loadConfig({ LOG_LEVEL: "" }).log.level).toBe("info");
});

test("reports every problem at once", () => {
  try {
    loadConfig({ APP_ENV: "prod", LOG_LEVEL: "verbose" });
    throw new Error("expected loadConfig to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).problems).toEqual([
      'APP_ENV must be one of development, test, production (got "prod")',
      'LOG_LEVEL must be one of debug, info, warn, error (got "verbose")',
    ]);
  }
});
