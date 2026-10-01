// Dashboard: `bun run dashboard`. A separate process from the bot that reads its database (its only
// write is the kill switch row), so it can be started, stopped and changed while the bot is trading.
//
// Normally it serves the prebuilt page from dist/web (`bun run build` or `dashboard:build` first).
// With --dev (`bun run dashboard:dev`) Bun bundles web/index.html itself, with hot reload.
import { Database } from "bun:sqlite";
import { ConfigError } from "../config";
import { createLogger } from "../utils/logger";
import { loadDashboardConfig } from "./config";
import { createApiRoutes } from "./api/router";
import { LoginLockout } from "./auth/lockout";
import { SessionManager } from "./auth/session";
import { StatusService } from "./services/status-service";
import { PositionsService } from "./services/positions-service";
import { HistoryService } from "./services/history-service";
import { KillSwitchService } from "./services/kill-switch-service";
import { MarketService } from "./services/market-service";
import { OrdersService } from "./services/orders-service";
import { StaticSite, WEB_DIST_DIR } from "./static-site";

/** Only used with --dev. A variable, not a literal, so `bun run build` doesn't bundle the page into the server. */
const DEV_PAGE = "./web/index.html";

async function main(): Promise<void> {
  const dev = process.argv.includes("--dev");
  const config = loadDashboardConfig();
  // Checked first, so a missing build fails fast with a clear message.
  const site = dev ? undefined : new StaticSite(WEB_DIST_DIR);
  const logger = createLogger({ level: "info", format: config.appEnv === "production" ? "json" : "pretty" }).child("dashboard");

  // Read-only for everything shown; the bot creates the file and the schema.
  const db = new Database(config.dbPath, { readonly: true, strict: true });
  db.run("PRAGMA busy_timeout = 5000");
  const status = new StatusService(db, { broker: config.broker, mode: config.mode, risk: config.risk });
  const market = new MarketService(db, { broker: config.broker, underlying: config.underlying });
  const orders = new OrdersService(db, { mode: config.mode });
  const positions = new PositionsService(db, { mode: config.mode });
  const history = new HistoryService(db, { mode: config.mode });
  // The one write: the kill switch row. A separate connection, so everything else stays read-only.
  const writeDb = new Database(config.dbPath, { strict: true });
  writeDb.run("PRAGMA busy_timeout = 5000");
  const killSwitch = new KillSwitchService(writeDb, { mode: config.mode });

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    routes: {
      ...createApiRoutes({
        sessions: new SessionManager(config.sessionSecret, config.sessionHours * 3_600_000),
        lockout: new LoginLockout(),
        hashes: { passwordHash: config.passwordHash, pinHash: config.pinHash },
        secureCookie: config.secureCookie,
        mode: config.mode,
        status: () => status.status(),
        positions: () => positions.positions(),
        market: () => market.market(),
        orders: () => orders.today(),
        historySummary: () => history.summary(),
        history: () => history.history(),
        killSwitch: () => killSwitch.activate(),
        logger,
      }),
      // Every other path is the React app, which does its own routing (/login, /, ...).
      "/*": dev ? (await import(DEV_PAGE)).default : (req: Request) => site!.serve(req),
    },
    development: dev ? { hmr: true, console: true } : false,
    error(err) {
      logger.error("request failed", { error: err.stack ?? err.message });
      return Response.json({ error: "internal error" }, { status: 500 });
    },
  });

  logger.info(`dashboard running at ${server.url}`, { mode: config.mode, db: config.dbPath, page: dev ? "dev (bundled on the fly, hot reload)" : WEB_DIST_DIR });
  if (config.host !== "127.0.0.1" && config.host !== "localhost") {
    logger.warn("dashboard is listening beyond this machine; prefer 127.0.0.1 with an SSH tunnel or Tailscale");
  }

  const shutdown = () => {
    server.stop();
    db.close();
    writeDb.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

try {
  await main();
} catch (err) {
  console.error(err instanceof ConfigError || err instanceof Error ? err.message : err);
  if (err instanceof Error && /unable to open database/i.test(err.message)) console.error("Start the bot once first; it creates the database.");
  process.exit(1);
}
