import { expect, test } from "bun:test";
import { createLogger, type LogLevel } from "../src/utils/logger";

function capture(opts: { level?: LogLevel; format?: "pretty" | "json" } = {}) {
  const lines: { line: string; level: LogLevel }[] = [];
  const logger = createLogger({
    level: opts.level ?? "debug",
    format: opts.format ?? "pretty",
    clock: () => new Date("2026-10-05T03:50:00Z"),
    write: (line, level) => lines.push({ line, level }),
  });
  return { logger, lines };
}

test("pretty lines show IST time, level, module and data", () => {
  const { logger, lines } = capture();
  logger.child("upstox").info("connected", { user: "AB1234" });
  expect(lines[0]?.line).toBe('2026-10-05 09:20:00 INFO  [upstox] connected {"user":"AB1234"}');
});

test("json lines are parseable", () => {
  const { logger, lines } = capture({ format: "json" });
  logger.child("engine").warn("slow tick", { ms: 250 });
  expect(JSON.parse(lines[0]!.line)).toEqual({
    ts: "2026-10-05T03:50:00.000Z",
    level: "warn",
    module: "engine",
    msg: "slow tick",
    ms: 250,
  });
});

test("filters below the configured level", () => {
  const { logger, lines } = capture({ level: "warn" });
  logger.debug("a");
  logger.info("b");
  logger.warn("c");
  logger.error("d");
  expect(lines.map((l) => l.level)).toEqual(["warn", "error"]);
});

test("redacts secrets, including nested ones", () => {
  const { logger, lines } = capture({ format: "json" });
  logger.info("login", { accessToken: "abc", apiSecret: "xyz", request: { headers: { Authorization: "Bearer abc" } } });
  const line = lines[0]!.line;
  expect(line).not.toContain("abc");
  expect(line).not.toContain("xyz");
  expect(JSON.parse(line).request.headers.Authorization).toBe("[redacted]");
});

test("serialises errors with their message", () => {
  const { logger, lines } = capture({ format: "json" });
  logger.error("order failed", { error: new Error("insufficient funds") });
  expect(JSON.parse(lines[0]!.line).error.message).toBe("insufficient funds");
});

test("nested child modules", () => {
  const { logger, lines } = capture();
  logger.child("upstox").child("ws").info("reconnecting");
  expect(lines[0]?.line).toContain("[upstox:ws] reconnecting");
});
