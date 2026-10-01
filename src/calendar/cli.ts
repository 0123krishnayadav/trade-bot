// `bun run holidays`: downloads the market holiday list now (needs today's login) and prints what's
// coming up. The bot and the scheduler also refresh it by themselves when it's a week old.
import { downloadHolidays } from "../brokers";
import { loadConfig } from "../config";
import { CalendarStore } from "../store/calendar-store";
import { migrate, openDatabase } from "../store/database";
import { migrations } from "../store/migrations";
import { SessionStore } from "../store/session-store";
import { createLogger } from "../utils/logger";
import { formatIst, istDate } from "../utils/time";
import { MarketCalendar } from "./market-calendar";

const config = loadConfig();
const logger = createLogger({ level: "info", format: "pretty" });
const db = openDatabase(config.db.path);
migrate(db, migrations);
const sessions = new SessionStore(db);
if (!sessions.get(config.broker)) {
  console.error(`Not logged in to ${config.broker}. Run \`bun run login\` first.`);
  process.exit(1);
}

const store = new CalendarStore(db);
const holidays = await downloadHolidays(config.broker, { getAccessToken: () => sessions.get(config.broker)?.accessToken, logger });
store.replaceAll(holidays);
const calendar = new MarketCalendar(store);
const today = istDate(new Date());

console.log(`Saved ${holidays.length} holidays and special sessions.\n`);
for (const h of holidays.filter((h) => h.date >= today)) {
  const when = h.session ? `special session ${formatIst(h.session.open).slice(11, 16)}–${formatIst(h.session.close).slice(11, 16)} IST` : "closed";
  console.log(`  ${h.date}  ${h.description.padEnd(32)} ${when}`);
}
console.log(`\nToday (${today}): ${calendar.isTradingDay(today) ? "trading day" : "market closed"}. Next trading day: ${calendar.nextTradingDay(today)}.`);
db.close();
