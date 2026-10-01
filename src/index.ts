import { ConfigError, loadConfig } from "./config";
import { createLogger } from "./utils/logger";
import { formatIst } from "./utils/time";
import { migrate, openDatabase } from "./store/database";
import { migrations } from "./store/migrations";
import { SessionStore } from "./store/session-store";
import { InstrumentStore, refreshInstrumentsIfStale } from "./store/instrument-store";
import { TradingStore } from "./store/trading-store";
import { ScripStore } from "./store/scrip-store";
import { createBrokerAdapters, downloadInstruments } from "./brokers";
import { PaperBroker } from "./brokers/paper/paper-broker";
import { MarketEngine } from "./engine/market-engine";
import { ScripRecorder } from "./engine/scrip-recorder";
import { StrategyEngine } from "./engine/strategy-engine";
import { DEFAULT_IRON_BUTTERFLY, IronButterfly } from "./strategies/iron-butterfly";
import { RiskManager } from "./risk/risk-manager";
import { createNotifier, type Notifier } from "./alerts/notifier";
import { istDate } from "./utils/time";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.log);
  if (config.log.fileDir) logger.info("logging to file", { dir: config.log.fileDir });
  const notifier = createNotifier(config.alerts, { prefix: config.trading.mode === "live" ? "[LIVE]" : "[paper]", logger: logger.child("alerts") });

  // Anything that would crash the process is written to the log file (and alerted) before exiting.
  const fatal = (kind: string) => async (err: unknown) => {
    logger.error(`FATAL ${kind}: the bot is stopping`, { error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    notifier.notify(`💥 Bot crashed (${kind}): ${err instanceof Error ? err.message : String(err)}. Check open positions!`);
    await notifier.flush(3_000);
    process.exit(1);
  };
  process.on("uncaughtException", fatal("uncaught exception"));
  process.on("unhandledRejection", fatal("unhandled promise rejection"));

  try {
    await run(config, logger, notifier);
  } catch (err) {
    logger.error("the bot could not run", { error: err instanceof Error ? err.message : String(err) });
    notifier.notify(`⚠️ Bot could not start: ${err instanceof Error ? err.message : String(err)}`);
    await notifier.flush(3_000);
    throw new LoggedError();
  }
  await notifier.flush(3_000);
}

/** An error already written to the log; only the exit code is left to set. */
class LoggedError extends Error {}

async function run(config: ReturnType<typeof loadConfig>, logger: ReturnType<typeof createLogger>, notifier: Notifier): Promise<void> {
  const mode = config.trading.mode;

  const db = openDatabase(config.db.path);
  migrate(db, migrations);
  const sessions = new SessionStore(db);
  const session = sessions.get(config.broker);
  if (!session) throw new Error(`Not logged in to ${config.broker}. Run \`bun run login\` first.`);
  logger.info("trade-bot starting", { mode, broker: config.broker, userId: session.userId, sessionValidUntil: formatIst(session.expiresAt) + " IST" });
  if (mode === "live") logger.warn("LIVE TRADING: real orders will be placed");

  const instruments = new InstrumentStore(db, config.broker);
  await refreshInstrumentsIfStale(instruments, () => downloadInstruments(config), logger.child("instruments"));

  // The token is read on every call, so logging in again while the bot runs takes effect at once.
  const adapters = createBrokerAdapters(config, {
    getAccessToken: () => sessions.get(config.broker)?.accessToken,
    instruments,
    logger,
  });
  const market = new MarketEngine(adapters.marketData, { logger: logger.child("market") });
  await market.start();
  // Latest prices go to the scrips table for the dashboard's live P&L.
  const scrips = new ScripRecorder(market, new ScripStore(db), { logger: logger.child("scrips") });
  scrips.start();
  const store = new TradingStore(db, mode);
  const inner = mode === "live" ? adapters.broker : new PaperBroker(market, instruments, { capital: config.trading.capital, logger: logger.child("paper") });
  // Every order goes through the risk checks; at the daily loss limit they turn the kill switch on.
  const broker = new RiskManager(inner, { limits: config.risk, instruments, prices: market, store, notifier, logger: logger.child("risk") });

  const engine = new StrategyEngine({
    market,
    broker,
    instruments,
    store,
    mode,
    logger: logger.child("strategy"),
    notifier,
  });
  engine.add(new IronButterfly({ ...DEFAULT_IRON_BUTTERFLY, ...config.ironButterfly, capital: config.trading.capital }));
  await engine.start();
  logger.info("running; press Ctrl+C to stop (open positions are squared off first)", { risk: config.risk });
  notifier.notify(`▶️ Bot started (${mode})`);

  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });

  logger.info("shutting down");
  await engine.stop();
  scrips.stop();
  broker.close(); // closes the paper or real broker inside
  if (inner !== adapters.broker) adapters.broker.close();
  notifier.notify(daySummary(store.trades().filter((t) => t.tradeDate === istDate(new Date()))));
  market.stop();
  db.close();
  logger.info("stopped");
}

/** One line for the end-of-day alert. */
function daySummary(trades: { netPnl: number; exitReason: string }[]): string {
  if (trades.length === 0) return "⏹ Bot stopped. No trades today.";
  const net = Math.round(trades.reduce((s, t) => s + t.netPnl, 0) * 100) / 100;
  return `⏹ Bot stopped. Today: ${trades.length} trade${trades.length === 1 ? "" : "s"}, net ₹${net} (${trades.map((t) => t.exitReason).join(", ")})`;
}

try {
  await main();
  process.exit(0);
} catch (err) {
  if (!(err instanceof LoggedError)) console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
