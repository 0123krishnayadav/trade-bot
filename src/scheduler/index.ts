// `bun run scheduler`: the one long-running process. Keeps the dashboard up, and runs the bot on
// trading days only (from 20 minutes before the open to 5 minutes after the close), with alerts
// for login, crashes and holidays. Ctrl+C stops everything; the bot squares off first.
import { createNotifier } from "../alerts/notifier";
import { MarketCalendar, refreshHolidaysIfStale } from "../calendar/market-calendar";
import { downloadHolidays } from "../brokers";
import { ConfigError, loadConfig } from "../config";
import { SCRIPTS, startChild, tag, type Child } from "../process/child";
import { CalendarStore } from "../store/calendar-store";
import { migrate, openDatabase } from "../store/database";
import { migrations } from "../store/migrations";
import { SessionStore } from "../store/session-store";
import { createLogger, pruneLogs } from "../utils/logger";
import { Scheduler } from "./scheduler";

const TICK_MS = 30_000;

const config = (() => {
  try {
    return loadConfig();
  } catch (err) {
    console.error(err instanceof ConfigError || err instanceof Error ? err.message : err);
    process.exit(1);
  }
})();
const logger = createLogger(config.log).child("scheduler");
const notifier = createNotifier(config.alerts, { prefix: config.trading.mode === "live" ? "[LIVE]" : "[paper]", logger: logger.child("alerts") });

const db = openDatabase(config.db.path);
migrate(db, migrations);
const sessions = new SessionStore(db);
const calendarStore = new CalendarStore(db);
const calendar = new MarketCalendar(calendarStore);

const scheduler = new Scheduler({
  calendar,
  refreshCalendar: () =>
    refreshHolidaysIfStale(
      calendar,
      calendarStore,
      () => downloadHolidays(config.broker, { getAccessToken: () => sessions.get(config.broker)?.accessToken, logger }),
      logger,
    ),
  loggedIn: () => sessions.get(config.broker) !== undefined,
  startBot: () => startChild("bot", SCRIPTS.bot, 36),
  onNewDay: () => {
    if (!config.log.fileDir) return;
    const deleted = pruneLogs(config.log.fileDir, config.logRetentionDays);
    if (deleted.length) logger.info("old log files deleted", { count: deleted.length, keepDays: config.logRetentionDays });
  },
  notifier,
  logger,
});

// The dashboard runs all the time (when it's set up); restarted if it exits, at most once a minute.
let dashboard: Child | undefined;
let stopping = false;
const dashboardConfigured = Boolean(process.env.DASHBOARD_PASSWORD_HASH?.trim());
function startDashboard(): void {
  if (!dashboardConfigured || stopping) return;
  const child = startChild("dashboard", SCRIPTS.dashboard, 35);
  dashboard = child;
  void child.exited.then((code) => {
    dashboard = undefined;
    if (stopping) return;
    logger.warn("dashboard exited; restarting in a minute", { code });
    setTimeout(startDashboard, 60_000);
  });
}
if (dashboardConfigured) startDashboard();
else logger.info("dashboard not set up (run `bun run dashboard:setup`); running the bot only");

const say = (msg: string) => console.log(`${tag("scheduler", 33)} ${msg}`);
say("running: the bot starts and stops with the market calendar; Ctrl+C stops everything");

const run = () => scheduler.tick().catch((err) => logger.error("scheduler tick failed", { error: String(err) }));
await run();
const timer = setInterval(run, TICK_MS);

async function stop(forward: boolean): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  say("stopping: waiting for the bot to square off and exit…");
  // Ctrl+C already reached the children (same terminal); a kill/SIGTERM has to be passed on.
  const botExit = scheduler.shutdown();
  if (forward) {
    dashboard?.kill("SIGTERM");
    scheduler.forwardSignal("SIGTERM");
  }
  await botExit;
  await dashboard?.exited;
  await notifier.flush(3_000);
  db.close();
  process.exit(0);
}
process.on("SIGINT", () => void stop(false));
process.on("SIGTERM", () => void stop(true));
