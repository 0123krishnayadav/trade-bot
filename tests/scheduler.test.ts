import { expect, test } from "bun:test";
import type { Notifier } from "../src/alerts/notifier";
import { MarketCalendar } from "../src/calendar/market-calendar";
import type { Child } from "../src/process/child";
import { planDay, phaseAt } from "../src/scheduler/plan";
import { MAX_RESTARTS_PER_DAY, Scheduler } from "../src/scheduler/scheduler";
import { CalendarStore } from "../src/store/calendar-store";
import { migrate, openDatabase } from "../src/store/database";
import { migrations } from "../src/store/migrations";
import { createLogger } from "../src/utils/logger";
import { istDateTime } from "../src/utils/time";

class FakeBot implements Child {
  readonly name = "bot";
  readonly pid = 1;
  exitCode: number | null = null;
  signals: string[] = [];
  private resolve!: (code: number) => void;
  readonly exited = new Promise<number>((r) => (this.resolve = r));
  kill(signal: "SIGINT" | "SIGTERM") {
    this.signals.push(signal);
    this.exit(0);
  }
  exit(code: number) {
    this.exitCode = code;
    this.resolve(code);
  }
}

function setup() {
  const db = openDatabase(":memory:");
  migrate(db, migrations);
  const store = new CalendarStore(db);
  store.replaceAll([{ date: "2026-10-02", description: "Gandhi Jayanti" }]);
  let now = istDateTime("2026-10-01", "08:00");
  let loggedIn = false;
  const bots: FakeBot[] = [];
  const sent: string[] = [];
  const newDays: string[] = [];
  const notifier: Notifier = { notify: (t) => void sent.push(t), flush: async () => {} };
  const scheduler = new Scheduler({
    calendar: new MarketCalendar(store),
    refreshCalendar: async () => {},
    loggedIn: () => loggedIn,
    startBot: () => {
      const bot = new FakeBot();
      bots.push(bot);
      return bot;
    },
    onNewDay: (d) => void newDays.push(d),
    notifier,
    logger: createLogger({ level: "error", format: "pretty", write: () => {} }),
    now: () => now,
  });
  return {
    scheduler,
    bots,
    sent,
    newDays,
    calendar: new MarketCalendar(store),
    at: (date: string, hhmm: string) => (now = istDateTime(date, hhmm)),
    login: () => (loggedIn = true),
  };
}

test("the day plan: login check 08:30, start 08:55, stop 15:35", () => {
  const { calendar } = setup();
  const plan = planDay("2026-10-01", calendar);
  expect([plan.loginCheckAt, plan.startAt, plan.stopAt]).toEqual([
    istDateTime("2026-10-01", "08:30"),
    istDateTime("2026-10-01", "08:55"),
    istDateTime("2026-10-01", "15:35"),
  ]);
  expect(phaseAt(plan, istDateTime("2026-10-01", "08:29"))).toBe("waiting");
  expect(phaseAt(plan, istDateTime("2026-10-01", "08:30"))).toBe("login-check");
  expect(phaseAt(plan, istDateTime("2026-10-01", "08:55"))).toBe("trading");
  expect(phaseAt(plan, istDateTime("2026-10-01", "15:35"))).toBe("after");
  expect(phaseAt(planDay("2026-10-02", calendar), istDateTime("2026-10-02", "10:00"))).toBe("closed");
});

test("a normal day: login alert once, start when logged in, stop after the close", async () => {
  const s = setup();
  expect(await s.scheduler.tick()).toBe("waiting");
  s.at("2026-10-01", "08:30");
  await s.scheduler.tick();
  await s.scheduler.tick();
  expect(s.sent.filter((t) => t.includes("Log in"))).toHaveLength(1);

  s.at("2026-10-01", "08:55");
  await s.scheduler.tick();
  expect(s.bots).toHaveLength(0); // still not logged in
  s.login();
  await s.scheduler.tick();
  expect(s.bots).toHaveLength(1);
  await s.scheduler.tick();
  expect(s.bots).toHaveLength(1); // already running

  s.at("2026-10-01", "15:35");
  await s.scheduler.tick();
  expect(s.bots[0]!.signals).toEqual(["SIGINT"]); // squares off and exits
  await Bun.sleep(1);
  await s.scheduler.tick();
  expect(s.bots).toHaveLength(1); // not started again after the close
});

test("a crash during the session restarts the bot, up to a limit", async () => {
  const s = setup();
  s.login();
  s.at("2026-10-01", "10:00");
  await s.scheduler.tick();
  for (let i = 0; i < MAX_RESTARTS_PER_DAY + 2; i++) {
    s.bots.at(-1)!.exit(1);
    await Bun.sleep(1);
    await s.scheduler.tick();
  }
  expect(s.bots).toHaveLength(1 + MAX_RESTARTS_PER_DAY);
  expect(s.sent.filter((t) => t.includes("exited unexpectedly"))).toHaveLength(1 + MAX_RESTARTS_PER_DAY);
  expect(s.sent.some((t) => t.includes("not restarting it again"))).toBe(true);
});

test("holidays: no bot, one notice; the next trading day starts fresh", async () => {
  const s = setup();
  s.login();
  s.at("2026-10-02", "10:00");
  expect(await s.scheduler.tick()).toBe("closed");
  await s.scheduler.tick();
  expect(s.bots).toHaveLength(0);
  expect(s.sent).toEqual(["📅 Market closed today (Gandhi Jayanti); the bot stays off."]);

  s.at("2026-10-03", "10:00"); // Saturday: closed, no notice
  await s.scheduler.tick();
  expect(s.sent).toHaveLength(1);

  s.at("2026-10-05", "09:00"); // Monday
  await s.scheduler.tick();
  expect(s.bots).toHaveLength(1);
  expect(s.newDays).toEqual(["2026-10-02", "2026-10-03", "2026-10-05"]);
});

test("after shutdown() nothing is started or restarted", async () => {
  const s = setup();
  s.login();
  s.at("2026-10-01", "10:00");
  await s.scheduler.tick();
  const exited = s.scheduler.shutdown();
  s.bots[0]!.exit(0);
  expect(await exited).toBe(0);
  await s.scheduler.tick();
  expect(s.bots).toHaveLength(1);
  expect(s.sent.filter((t) => t.includes("unexpectedly"))).toHaveLength(0);
});
