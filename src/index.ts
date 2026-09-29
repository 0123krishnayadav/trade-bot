import { ConfigError, loadConfig } from "./config";
import { createLogger } from "./utils/logger";
import { formatIst } from "./utils/time";
import { migrate, openDatabase } from "./store/database";
import { migrations } from "./store/migrations";
import { SessionStore } from "./store/session-store";
import { InstrumentStore, refreshInstrumentsIfStale } from "./store/instrument-store";
import { TradingStore } from "./store/trading-store";
import { createBrokerAdapters, downloadInstruments } from "./brokers";
import { PaperBroker } from "./brokers/paper/paper-broker";
import { MarketEngine } from "./engine/market-engine";
import { StrategyEngine } from "./engine/strategy-engine";
import { DEFAULT_IRON_BUTTERFLY, IronButterfly } from "./strategies/iron-butterfly";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.log);
  if (config.log.fileDir) logger.info("logging to file", { dir: config.log.fileDir });

  // Anything that would crash the process is written to the log file before exiting.
  const fatal = (kind: string) => (err: unknown) => {
    logger.error(`FATAL ${kind}: the bot is stopping`, { error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    process.exit(1);
  };
  process.on("uncaughtException", fatal("uncaught exception"));
  process.on("unhandledRejection", fatal("unhandled promise rejection"));

  try {
    await run(config, logger);
  } catch (err) {
    logger.error("the bot could not run", { error: err instanceof Error ? err.message : String(err) });
    throw new LoggedError();
  }
}

/** An error already written to the log; only the exit code is left to set. */
class LoggedError extends Error {}

async function run(config: ReturnType<typeof loadConfig>, logger: ReturnType<typeof createLogger>): Promise<void> {
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
  const broker = mode === "live" ? adapters.broker : new PaperBroker(market, instruments, { capital: config.trading.capital, logger: logger.child("paper") });

  const engine = new StrategyEngine({
    market,
    broker,
    instruments,
    store: new TradingStore(db, mode),
    mode,
    logger: logger.child("strategy"),
  });
  engine.add(new IronButterfly({ ...DEFAULT_IRON_BUTTERFLY, ...config.ironButterfly, capital: config.trading.capital }));
  await engine.start();
  logger.info("running; press Ctrl+C to stop (open positions are squared off first)");

  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });

  logger.info("shutting down");
  await engine.stop();
  broker.close();
  if (broker !== adapters.broker) adapters.broker.close();
  market.stop();
  db.close();
  logger.info("stopped");
}

try {
  await main();
  process.exit(0);
} catch (err) {
  if (!(err instanceof LoggedError)) console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
