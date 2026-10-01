import { afterAll, beforeAll, expect, test } from "bun:test";
import { createApiRoutes } from "../src/dashboard/api/router";
import type { HistoryResponse, StatusResponse } from "../src/dashboard/api/types";
import { hashForEnv, verifyCredentials } from "../src/dashboard/auth/credentials";
import { LoginLockout } from "../src/dashboard/auth/lockout";
import { SESSION_COOKIE, SessionManager } from "../src/dashboard/auth/session";
import { loadDashboardConfig } from "../src/dashboard/config";
import { StatusService } from "../src/dashboard/services/status-service";
import { PositionsService } from "../src/dashboard/services/positions-service";
import { HistoryService } from "../src/dashboard/services/history-service";
import { buildReport } from "../src/reports/report";
import { KillSwitchService, KillSwitchUnavailable } from "../src/dashboard/services/kill-switch-service";
import { ScripStore } from "../src/store/scrip-store";
import type { Order } from "../src/core/types";
import { migrate, openDatabase } from "../src/store/database";
import { migrations } from "../src/store/migrations";
import { SessionStore } from "../src/store/session-store";
import { TradingStore } from "../src/store/trading-store";
import { createLogger } from "../src/utils/logger";

const SECRET = "x".repeat(32);
const PASSWORD = "correct-horse-battery-staple";
const PIN = "482915";
const quiet = createLogger({ level: "error", format: "pretty", write: () => {} });
const fastHash = (s: string) => Bun.password.hash(s, { algorithm: "argon2id", memoryCost: 1024, timeCost: 1 });

// ---------- Credentials ----------

test("credentials need both the password and the PIN", async () => {
  const hashes = { passwordHash: await fastHash(PASSWORD), pinHash: await fastHash(PIN) };
  expect(await verifyCredentials(PASSWORD, PIN, hashes)).toBe(true);
  expect(await verifyCredentials(PASSWORD, "000000", hashes)).toBe(false);
  expect(await verifyCredentials("wrong", PIN, hashes)).toBe(false);
  expect(await verifyCredentials(PASSWORD, PIN, { ...hashes, pinHash: "not a hash" })).toBe(false);
});

test("config decodes the base64 hashes written by setup", async () => {
  const env = {
    DASHBOARD_PASSWORD_HASH: await hashForEnv(PASSWORD),
    DASHBOARD_PIN_HASH: await hashForEnv(PIN),
    DASHBOARD_SESSION_SECRET: SECRET,
  };
  expect(env.DASHBOARD_PASSWORD_HASH).not.toContain("$"); // safe in .env
  const config = loadDashboardConfig(env);
  expect(await Bun.password.verify(PASSWORD, config.passwordHash)).toBe(true);
  expect(config.host).toBe("127.0.0.1");
  expect(() => loadDashboardConfig({ ...env, DASHBOARD_PIN_HASH: btoa("plain"), DASHBOARD_SESSION_SECRET: "short" })).toThrow(
    /DASHBOARD_PIN_HASH is not a hash[\s\S]*at least 32/,
  );
});

// ---------- Sessions ----------

test("session cookies are signed, expire and can be revoked", () => {
  let now = 1_000_000;
  const sessions = new SessionManager(SECRET, 60_000, () => now);
  const { token } = sessions.create();
  expect(sessions.verify(token)).toBeDefined();

  const [body, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ sid: "a", exp: now + 1e9 })).toString("base64url");
  expect(sessions.verify(`${forged}.${sig}`)).toBeUndefined();
  expect(sessions.verify(`${body}.${sig}x`)).toBeUndefined();
  expect(new SessionManager("y".repeat(32), 60_000, () => now).verify(token)).toBeUndefined();

  const second = sessions.create().token;
  sessions.revoke(token);
  expect(sessions.verify(token)).toBeUndefined();
  expect(sessions.verify(second)).toBeDefined(); // only the logged-out session ends

  now += 60_000;
  expect(sessions.verify(second)).toBeUndefined();
});

// ---------- Lockout ----------

test("login locks after 5 failures and unlocks after 15 minutes", () => {
  let now = 0;
  const lockout = new LoginLockout(5, 15 * 60_000, () => now);
  for (let i = 0; i < 4; i++) lockout.recordFailure();
  expect(lockout.remainingMs()).toBe(0);
  lockout.recordFailure();
  expect(lockout.remainingMs()).toBe(15 * 60_000);
  now += 15 * 60_000;
  expect(lockout.remainingMs()).toBe(0);
  lockout.recordFailure(); // a fresh count after the lock ran out
  expect(lockout.remainingMs()).toBe(0);
  lockout.recordSuccess();
  for (let i = 0; i < 4; i++) lockout.recordFailure();
  expect(lockout.remainingMs()).toBe(0);
});

// ---------- Status ----------

test("status never includes the broker access token", () => {
  const db = openDatabase(":memory:");
  migrate(db, migrations);
  const now = new Date("2026-10-01T06:00:00Z"); // 11:30 IST
  new SessionStore(db).save({
    broker: "upstox",
    userId: "AB1234",
    userName: "Krishna",
    accessToken: "SECRET-TOKEN",
    issuedAt: new Date("2026-10-01T02:00:00Z"),
    expiresAt: new Date("2026-10-01T22:00:00Z"),
  });
  const trading = new TradingStore(db, "paper");
  trading.saveState("iron-butterfly", { date: "2026-10-01", phase: "done", exitReason: "TARGET", legs: [] });
  const trade = { strategyId: "iron-butterfly", openedAt: now, closedAt: now, exitReason: "TARGET" };
  trading.saveTrade({ ...trade, tradeDate: "2026-10-01", grossPnl: 5800, charges: 220.5, netPnl: 5579.5 });
  trading.saveTrade({ ...trade, tradeDate: "2026-09-30", grossPnl: -100, charges: 200, netPnl: -300 });
  new TradingStore(db, "live").saveState("iron-butterfly", { phase: "open" });

  const status = new StatusService(db, { broker: "upstox", mode: "paper", now: () => now }).status();
  expect(JSON.stringify(status)).not.toContain("SECRET-TOKEN");
  expect(status.broker).toEqual({ name: "upstox", loggedIn: true, userId: "AB1234", userName: "Krishna", validUntil: "2026-10-01T22:00:00.000Z" });
  expect(status.strategies).toMatchObject([{ id: "iron-butterfly", phase: "done", date: "2026-10-01", exitReason: "TARGET" }]);
  expect(status.today).toEqual({ date: "2026-10-01", closedTrades: 1, grossPnl: 5800, charges: 220.5, netPnl: 5579.5 });

  const later = new StatusService(db, { broker: "upstox", mode: "paper", now: () => new Date("2026-10-02T00:00:00Z") }).status();
  expect(later.broker.loggedIn).toBe(false);
  db.close();
});

// ---------- Positions ----------

const fill = (id: string, key: string, side: "BUY" | "SELL", qty: number, avg: number, placedAt: string): Order => ({
  id,
  instrumentKey: key,
  symbol: key.replace("NSE_FO|", "OPT "),
  side,
  type: "MARKET",
  product: "MIS",
  quantity: qty,
  price: 0,
  triggerPrice: 0,
  status: "FILLED",
  filledQuantity: qty,
  averagePrice: avg,
  placedAt: new Date(placedAt),
} as Order);

test("open P&L comes from today's fills and the scrips table", () => {
  const db = openDatabase(":memory:");
  migrate(db, migrations);
  const trading = new TradingStore(db, "paper");
  const save = (o: Order) => trading.saveOrder("upstox", o, "iron-butterfly");
  save(fill("1", "NSE_FO|CE", "SELL", 65, 148.85, "2026-10-01T03:50:00Z"));
  save(fill("2", "NSE_FO|WING", "BUY", 65, 22.95, "2026-10-01T03:50:00Z"));
  save(fill("3", "NSE_FO|NOPRICE", "BUY", 65, 10, "2026-10-01T03:50:00Z"));
  save(fill("4", "NSE_FO|CLOSED", "BUY", 65, 50, "2026-10-01T03:51:00Z"));
  save(fill("5", "NSE_FO|CLOSED", "SELL", 65, 60, "2026-10-01T04:00:00Z"));
  save(fill("6", "NSE_FO|YESTERDAY", "BUY", 65, 99, "2026-09-30T05:00:00Z"));
  new ScripStore(db).saveMany([
    { instrumentKey: "NSE_FO|CE", ltp: 120, cp: 140 },
    { instrumentKey: "NSE_FO|WING", ltp: 20, cp: 25 },
  ]);

  const res = new PositionsService(db, { mode: "paper", now: () => new Date("2026-10-01T06:00:00Z") }).positions();
  expect(res.positions.map((p) => [p.instrumentKey, p.quantity, p.pnl])).toEqual([
    ["NSE_FO|CE", -65, 1875.25], // short: (148.85 - 120) x 65
    ["NSE_FO|NOPRICE", 65, undefined],
    ["NSE_FO|WING", 65, -191.75], // long: (20 - 22.95) x 65
  ]);
  expect(res.positions[0]).toMatchObject({ strategyId: "iron-butterfly", averagePrice: 148.85, ltp: 120, cp: 140 });
  expect(res.openPnl).toBe(1683.5);
  expect(res.missingPrices).toBe(1);
  expect(res.pricesRecorded).toBe(true);
  expect(new PositionsService(db, { mode: "live" }).positions().positions).toEqual([]); // modes kept apart
  db.close();
});

test("positions still load before the bot has created the scrips table", () => {
  const db = openDatabase(":memory:");
  migrate(db, migrations.filter((m) => m.id < 4));
  new TradingStore(db, "paper").saveOrder("upstox", fill("1", "NSE_FO|CE", "SELL", 65, 100, "2026-10-01T03:50:00Z"));
  const res = new PositionsService(db, { mode: "paper", now: () => new Date("2026-10-01T06:00:00Z") }).positions();
  expect(res).toMatchObject({ pricesRecorded: false, openPnl: 0, missingPrices: 1 });
  expect(res.positions).toHaveLength(1);
  db.close();
});

// ---------- History ----------

test("history: totals, and what each trade bought and sold", () => {
  const db = openDatabase(":memory:");
  migrate(db, migrations);
  const trading = new TradingStore(db, "paper");
  const save = (o: Order, strategy = "iron-butterfly") => trading.saveOrder("upstox", o, strategy);
  // Day 1: buy a wing, sell the short; close both. Then a second trade the same day.
  save(fill("1", "NSE_FO|WING", "BUY", 65, 20, "2026-09-30T03:50:00Z"));
  save(fill("2", "NSE_FO|CE", "SELL", 65, 150, "2026-09-30T03:50:01Z"));
  save(fill("3", "NSE_FO|CE", "BUY", 65, 120, "2026-09-30T09:45:00Z"));
  save(fill("4", "NSE_FO|WING", "SELL", 65, 10, "2026-09-30T09:45:01Z"));
  save(fill("5", "NSE_FO|CE", "SELL", 30, 100, "2026-09-30T09:50:00Z"));
  save(fill("6", "NSE_FO|CE", "SELL", 35, 102, "2026-09-30T09:50:01Z")); // two fills: averaged
  save(fill("7", "NSE_FO|CE", "BUY", 65, 110, "2026-09-30T09:55:00Z"));
  save(fill("8", "NSE_FO|OTHER", "BUY", 10, 5, "2026-09-30T09:51:00Z"), "other-strategy"); // not ours
  save(fill("9", "NSE_FO|OPEN", "BUY", 65, 5, "2026-10-01T03:50:00Z")); // still open: no trade yet
  const trade = (closedAt: string, gross: number, net: number) =>
    trading.saveTrade({
      strategyId: "iron-butterfly",
      tradeDate: "2026-09-30",
      openedAt: new Date("2026-09-30T03:50:02Z"),
      closedAt: new Date(closedAt),
      exitReason: net > 0 ? "TIME_EXIT" : "STOP_LOSS",
      grossPnl: gross,
      charges: 100,
      netPnl: net,
    });
  trade("2026-09-30T09:45:02Z", 1300, 1200);
  trade("2026-09-30T09:55:01Z", -495, -595);
  new TradingStore(db, "live").saveTrade({ strategyId: "x", tradeDate: "2026-09-30", openedAt: new Date(), closedAt: new Date(), exitReason: "TARGET", grossPnl: 9, charges: 0, netPnl: 9 });

  const res = new HistoryService(db, { mode: "paper" }).history();
  expect(res.summary).toMatchObject({ trades: 2, wins: 1, losses: 1, winRate: 50, grossPnl: 805, charges: 200, netPnl: 605, since: "2026-09-30", maxDrawdown: 595 });
  expect(res.trades.map((t) => t.netPnl)).toEqual([-595, 1200]); // newest first
  const [second, first] = res.trades;
  expect(first!.bought.map((f) => [f.symbol, f.quantity, f.averagePrice])).toEqual([["OPT CE", 65, 120], ["OPT WING", 65, 20]]);
  expect(first!.sold.map((f) => [f.symbol, f.quantity, f.averagePrice])).toEqual([["OPT CE", 65, 150], ["OPT WING", 65, 10]]);
  expect(second!.sold).toEqual([{ instrumentKey: "NSE_FO|CE", symbol: "OPT CE", quantity: 65, averagePrice: 101.08 }]);
  expect(second!.bought.map((f) => f.instrumentKey)).toEqual(["NSE_FO|CE"]);

  db.close();
});

// ---------- Kill switch ----------

test("kill switch: one row for today (first press kept), shown in the status", () => {
  const db = openDatabase(":memory:");
  migrate(db, migrations);
  let now = new Date("2026-10-01T06:00:00Z"); // 11:30 IST
  const service = new KillSwitchService(db, { mode: "paper", now: () => now });
  const status = () => new StatusService(db, { broker: "upstox", mode: "paper", now: () => now }).status();
  expect(status().killSwitch).toBeUndefined();

  expect(service.activate()).toEqual({ tradeDate: "2026-10-01", activatedAt: "2026-10-01T06:00:00.000Z" });
  now = new Date("2026-10-01T07:00:00Z");
  expect(service.activate().activatedAt).toBe("2026-10-01T06:00:00.000Z"); // pressing again keeps the first time
  expect(status().killSwitch).toEqual({ activatedAt: "2026-10-01T06:00:00.000Z" });
  expect(new TradingStore(db, "paper").killSwitch("2026-10-01")).toMatchObject({ source: "dashboard" });

  now = new Date("2026-10-01T19:00:00Z"); // 00:30 IST on 2 Oct: a new day
  expect(status().killSwitch).toBeUndefined();
  db.close();
});

test("kill switch needs the bot's table; status works without it", () => {
  const db = openDatabase(":memory:");
  migrate(db, migrations.filter((m) => m.id < 5));
  expect(() => new KillSwitchService(db, { mode: "paper" }).activate()).toThrow(KillSwitchUnavailable);
  expect(new StatusService(db, { broker: "upstox", mode: "paper" }).status().killSwitch).toBeUndefined();
  db.close();
});

// ---------- API ----------

let server: ReturnType<typeof Bun.serve>;
let noTable = false;
const history: HistoryResponse = { summary: buildReport([]), trades: [] };
const status: StatusResponse = {
  serverTime: "2026-10-01T06:00:00.000Z",
  mode: "paper",
  broker: { name: "upstox", loggedIn: false },
  strategies: [],
  today: { date: "2026-10-01", closedTrades: 0, grossPnl: 0, charges: 0, netPnl: 0 },
};

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    routes: createApiRoutes({
      sessions: new SessionManager(SECRET, 3_600_000),
      lockout: new LoginLockout(),
      hashes: { passwordHash: await fastHash(PASSWORD), pinHash: await fastHash(PIN) },
      secureCookie: false,
      mode: "paper",
      status: () => status,
      positions: () => ({ positions: [], openPnl: 0, missingPrices: 0, pricesRecorded: true }),
      historySummary: () => history.summary,
      history: () => history,
      killSwitch: () => {
        if (noTable) throw new KillSwitchUnavailable("restart the bot on this version first");
        return { tradeDate: "2026-10-01", activatedAt: "2026-10-01T06:00:00.000Z" };
      },
      logger: quiet,
    }),
  });
});
afterAll(() => server.stop(true));

const call = (path: string, init: RequestInit = {}) => fetch(new URL(path, server.url), init);
const login = (body: unknown, contentType = "application/json") =>
  call("/api/auth/login", { method: "POST", headers: { "Content-Type": contentType }, body: JSON.stringify(body) });
const cookieOf = (res: Response) => res.headers.get("set-cookie")!.split(";")[0]!;

test("API: login sets an HttpOnly, SameSite=Strict session cookie that unlocks the other routes", async () => {
  expect((await call("/api/status")).status).toBe(401);
  expect((await call("/api/auth/me")).status).toBe(401);

  const res = await login({ password: PASSWORD, pin: PIN });
  expect(res.status).toBe(204);
  const setCookie = res.headers.get("set-cookie")!;
  expect(setCookie).toStartWith(`${SESSION_COOKIE}=`);
  expect(setCookie).toMatch(/HttpOnly/i);
  expect(setCookie).toMatch(/SameSite=Strict/i);
  const cookie = cookieOf(res);

  const me = await call("/api/auth/me", { headers: { Cookie: cookie } });
  expect(me.status).toBe(200);
  expect(await me.json()).toMatchObject({ mode: "paper" });
  expect(await (await call("/api/history/summary", { headers: { Cookie: cookie } })).json()).toEqual(history.summary);
  expect((await call("/api/history", { headers: { Cookie: cookie } })).status).toBe(200);
  expect((await call("/api/history")).status).toBe(401);
  const statusRes = await call("/api/status", { headers: { Cookie: cookie } });
  expect(await statusRes.json()).toEqual(status);
  expect(statusRes.headers.get("cache-control")).toBe("no-store");

  expect((await call("/api/auth/logout", { method: "POST", headers: { Cookie: cookie } })).status).toBe(204);
  expect((await call("/api/auth/me", { headers: { Cookie: cookie } })).status).toBe(401); // revoked server-side too
});

test("API: kill switch needs a session and an explicit confirm", async () => {
  const kill = (body: unknown, cookie?: string) =>
    call("/api/kill-switch", { method: "POST", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  expect((await kill({ confirm: true })).status).toBe(401);
  const cookie = cookieOf(await login({ password: PASSWORD, pin: PIN }));
  expect((await kill({}, cookie)).status).toBe(400);
  const ok = await kill({ confirm: true }, cookie);
  expect(await ok.json()).toEqual({ tradeDate: "2026-10-01", activatedAt: "2026-10-01T06:00:00.000Z" });
  noTable = true;
  const unavailable = await kill({ confirm: true }, cookie);
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({ error: "restart the bot on this version first" });
  noTable = false;
});

test("API: rejects bad requests and unknown routes", async () => {
  expect((await login({ password: PASSWORD, pin: PIN }, "text/plain")).status).toBe(415);
  expect((await login({ password: PASSWORD })).status).toBe(400);
  expect((await call("/api/nope")).status).toBe(404);
});

test("API: wrong credentials give one generic error, then lock login", async () => {
  const wrongPin = await login({ password: PASSWORD, pin: "000000" });
  expect(wrongPin.status).toBe(401);
  expect(await wrongPin.json()).toEqual({ error: "invalid credentials" });
  for (let i = 0; i < 4; i++) await login({ password: "nope", pin: PIN });

  const locked = await login({ password: PASSWORD, pin: PIN }); // even the right ones, while locked
  expect(locked.status).toBe(429);
  expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(800);
  expect(locked.headers.get("set-cookie")).toBeNull();
});
