// Try the Upstox APIs from the terminal with the saved login. Read-only on purpose: placing and
// cancelling orders is only done by the bot, never from an ad-hoc command.
//
//   bun run upstox profile | funds | portfolio | orders | trades | gtt
//   bun run upstox today   "NSE_INDEX|Nifty 50" minutes 5
//   bun run upstox history "NSE_INDEX|Nifty 50" days 1 2026-09-01 2026-09-25
//   bun run upstox feed    "NSE_INDEX|Nifty 50" "NSE_EQ|INE002A01018" --mode ltpc
import { ConfigError, loadConfig } from "../../config";
import { createLogger } from "../../utils/logger";
import { formatIst } from "../../utils/time";
import { migrate, openDatabase } from "../../store/database";
import { migrations } from "../../store/migrations";
import { SessionStore } from "../../store/session-store";
import { createUpstoxApi } from ".";
import { UPSTOX_BROKER_NAME } from "./constants";
import type { CandleUnit } from "./types";
import type { FeedMode } from "./feed-decoder";

const USAGE = `Usage:
  bun run upstox profile | funds | portfolio | orders | trades | gtt
  bun run upstox today   <instrument_key> <minutes|hours|days> <interval>
  bun run upstox history <instrument_key> <minutes|hours|days|weeks|months> <interval> <from YYYY-MM-DD> <to YYYY-MM-DD>
  bun run upstox feed    <instrument_key>... [--mode ltpc|full|option_greeks]`;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.log);
  const db = openDatabase(config.db.path);
  migrate(db, migrations);
  const session = new SessionStore(db).get(UPSTOX_BROKER_NAME);
  db.close();
  if (!session) throw new Error("Not logged in to Upstox. Run `bun run login` first.");

  const upstox = createUpstoxApi({ getAccessToken: () => session.accessToken, logger });
  const [command, ...args] = process.argv.slice(2);
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

  switch (command) {
    case "profile":
      return print(await upstox.account.fetchProfile());
    case "funds":
      return print(await upstox.account.fetchFunds());
    case "portfolio":
      return print(await upstox.account.fetchPortfolio());
    case "orders":
      return print(await upstox.orders.fetchOrders());
    case "trades":
      return print(await upstox.orders.fetchTrades());
    case "gtt":
      return print(await upstox.orders.fetchGttOrders());
    case "today": {
      const [key, unit, interval] = args;
      if (!key || !unit || !interval) throw new Error(USAGE);
      const candles = await upstox.marketData.fetchTodayCandles(key, { unit: unit as CandleUnit, interval: Number(interval) });
      return printCandles(candles);
    }
    case "history": {
      const [key, unit, interval, from, to] = args;
      if (!key || !unit || !interval || !from || !to) throw new Error(USAGE);
      const candles = await upstox.marketData.fetchHistoricalCandles(key, { unit: unit as CandleUnit, interval: Number(interval) }, from, to);
      return printCandles(candles);
    }
    case "feed": {
      const modeAt = args.indexOf("--mode");
      const mode = (modeAt >= 0 ? args[modeAt + 1] : "ltpc") as FeedMode;
      const instrumentKeys = args.filter((_, i) => modeAt < 0 || (i !== modeAt && i !== modeAt + 1));
      if (instrumentKeys.length === 0) throw new Error(USAGE);
      upstox.feed.onMarketStatus((status) => logger.info("market status", status));
      upstox.feed.onTick((t) => logger.info(t.instrumentKey, { ltp: t.ltp, ltt: formatIst(t.ltt), ...(t.oi ? { oi: t.oi } : {}) }));
      await upstox.feed.connect();
      upstox.feed.subscribe(instrumentKeys, mode);
      logger.info("streaming, Ctrl+C to stop", { instrumentKeys, mode });
      process.on("SIGINT", () => {
        upstox.feed.close();
        process.exit(0);
      });
      await new Promise(() => {}); // run until Ctrl+C
      return;
    }
    default:
      throw new Error(USAGE);
  }
}

function printCandles(candles: { time: Date; open: number; high: number; low: number; close: number; volume: number; oi: number }[]): void {
  console.table(candles.map((c) => ({ time: formatIst(c.time), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, oi: c.oi })));
  console.log(`${candles.length} candles`);
}

try {
  await main();
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err instanceof Error ? err.message : err);
  process.exit(1);
}
