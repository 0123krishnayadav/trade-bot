import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, pruneLogs, type LogLevel } from "../src/utils/logger";

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

test("writes to a file per IST day, from the root logger and its children", async () => {
  const { mkdtempSync, readdirSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "trade-bot-logs-"));
  let now = new Date("2026-09-30T18:29:00Z"); // 23:59 IST on the 30th
  const logger = createLogger({ level: "info", format: "pretty", clock: () => now, write: () => {}, fileDir: join(dir, "logs") });
  logger.info("before midnight");
  logger.child("strategy").warn("from a child");
  now = new Date("2026-09-30T18:31:00Z"); // 00:01 IST on the 1st
  logger.info("after midnight");

  expect(readdirSync(join(dir, "logs")).sort()).toEqual(["2026-09-30.log", "2026-10-01.log"]);
  expect(readFileSync(join(dir, "logs", "2026-09-30.log"), "utf8")).toBe(
    "2026-09-30 23:59:00 INFO  before midnight\n2026-09-30 23:59:00 WARN  [strategy] from a child\n",
  );
  expect(readFileSync(join(dir, "logs", "2026-10-01.log"), "utf8")).toBe("2026-10-01 00:01:00 INFO  after midnight\n");
  rmSync(dir, { recursive: true });
});

test("pruneLogs deletes only dated log files older than the retention", () => {
  const dir = mkdtempSync(join(tmpdir(), "trade-bot-logs-"));
  for (const name of ["2026-08-31.log", "2026-09-01.log", "2026-09-30.log", "notes.txt", "2026-01-01.txt"]) writeFileSync(join(dir, name), "x");
  expect(pruneLogs(dir, 30, new Date("2026-10-01T06:00:00Z"))).toEqual(["2026-08-31.log"]);
  expect(readdirSync(dir).sort()).toEqual(["2026-01-01.txt", "2026-09-01.log", "2026-09-30.log", "notes.txt"]);
  expect(pruneLogs(join(dir, "missing"), 30)).toEqual([]);
});
