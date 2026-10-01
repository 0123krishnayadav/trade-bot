import { expect, test } from "bun:test";
import { UpstoxCalendarApi } from "../src/brokers/upstox/calendar";
import { MarketCalendar, refreshHolidaysIfStale } from "../src/calendar/market-calendar";
import { CalendarStore } from "../src/store/calendar-store";
import { migrate, openDatabase } from "../src/store/database";
import { migrations } from "../src/store/migrations";
import { createLogger } from "../src/utils/logger";
import { istDateTime } from "../src/utils/time";
import { fakeUpstox, ok } from "./upstox-helpers";

// Real rows from GET /v2/market/holidays (2026), trimmed.
const UPSTOX_HOLIDAYS = [
  { date: "2026-10-02", description: "Gandhi Jayanti", holiday_type: "TRADING_HOLIDAY", closed_exchanges: ["NSE", "NFO", "BSE"], open_exchanges: [] },
  {
    date: "2026-02-01",
    description: "Budget Day Session",
    holiday_type: "SPECIAL_TIMING",
    closed_exchanges: ["CDS", "BCD"],
    open_exchanges: [{ exchange: "NFO", start_time: 1769917500000, end_time: 1769940000000 }],
  },
  {
    date: "2026-01-15",
    description: "Municipal Corporation Election",
    holiday_type: "TRADING_HOLIDAY",
    closed_exchanges: ["NSE", "NFO"],
    open_exchanges: [{ exchange: "MCX", start_time: 1768476600000, end_time: 1768501500000 }],
  },
];

function setup() {
  const db = openDatabase(":memory:");
  migrate(db, migrations);
  const store = new CalendarStore(db);
  return { db, store, calendar: new MarketCalendar(store) };
}

test("Upstox holidays map to F&O closures and special sessions", async () => {
  const { http, calls } = fakeUpstox([ok(UPSTOX_HOLIDAYS)]);
  const holidays = await new UpstoxCalendarApi(http).fetchHolidays();
  expect(calls[0]!.url.pathname).toBe("/v2/market/holidays");
  expect(holidays).toEqual([
    { date: "2026-10-02", description: "Gandhi Jayanti" },
    { date: "2026-02-01", description: "Budget Day Session", session: { open: istDateTime("2026-02-01", "09:15"), close: istDateTime("2026-02-01", "15:30") } },
    { date: "2026-01-15", description: "Municipal Corporation Election" }, // only MCX open: closed for us
  ]);
});

test("sessions: weekdays, holidays, weekends and a Sunday special session", async () => {
  const { store, calendar } = setup();
  const { http } = fakeUpstox([ok(UPSTOX_HOLIDAYS)]);
  store.replaceAll(await new UpstoxCalendarApi(http).fetchHolidays());

  expect(calendar.session("2026-10-01")).toEqual({ open: istDateTime("2026-10-01", "09:15"), close: istDateTime("2026-10-01", "15:30") });
  expect(calendar.isTradingDay("2026-10-02")).toBe(false); // Gandhi Jayanti (Friday)
  expect(calendar.holiday("2026-10-02")?.description).toBe("Gandhi Jayanti");
  expect(calendar.isTradingDay("2026-10-03")).toBe(false); // Saturday
  expect(calendar.nextTradingDay("2026-10-01")).toBe("2026-10-05");
  expect(calendar.isTradingDay("2026-02-01")).toBe(true); // Sunday budget session
});

test("the holiday list is refreshed weekly, for a new year, and kept when a download fails", async () => {
  const { store, calendar } = setup();
  const quiet = createLogger({ level: "error", format: "pretty", write: () => {} });
  const now = new Date("2026-10-01T03:00:00Z");
  expect(calendar.needsRefresh(now)).toBe(true);

  let downloads = 0;
  const download = async () => {
    downloads++;
    return [{ date: "2026-10-02", description: "Gandhi Jayanti" }];
  };
  await refreshHolidaysIfStale(calendar, store, download, quiet, now);
  await refreshHolidaysIfStale(calendar, store, download, quiet, new Date("2026-10-07T03:00:00Z"));
  expect(downloads).toBe(1);
  expect(calendar.needsRefresh(new Date("2026-10-08T03:00:00Z"))).toBe(true); // a week later
  expect(calendar.needsRefresh(new Date("2027-01-01T03:00:00Z"))).toBe(true); // new year

  await refreshHolidaysIfStale(calendar, store, async () => { throw new Error("down"); }, quiet, new Date("2026-10-09T03:00:00Z"));
  expect(calendar.isTradingDay("2026-10-02")).toBe(false); // previous list kept
});
