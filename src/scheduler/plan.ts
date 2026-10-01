import type { MarketCalendar, Session } from "../calendar/market-calendar";
import type { MarketHoliday } from "../core/types";

/** Minutes relative to the session: when to check the login, start the bot and stop it. */
export const SCHEDULE = {
  /** Alert if not logged in from this long before the open. */
  loginCheckBeforeOpen: 45,
  /** The bot starts this long before the open (instruments refresh, feed connects). */
  startBeforeOpen: 20,
  /** And stops this long after the close (strategies square off at 15:15 anyway). */
  stopAfterClose: 5,
};

export interface DayPlan {
  date: string;
  /** Undefined when the market is closed that day. */
  session?: Session;
  holiday?: MarketHoliday;
  loginCheckAt?: Date;
  startAt?: Date;
  stopAt?: Date;
}

/** waiting: before the login check · login-check: until start · trading: bot should run · after: bot should be stopped. */
export type Phase = "closed" | "waiting" | "login-check" | "trading" | "after";

const minutes = (d: Date, n: number) => new Date(d.getTime() + n * 60_000);

export function planDay(date: string, calendar: MarketCalendar): DayPlan {
  const session = calendar.session(date);
  const holiday = calendar.holiday(date);
  if (!session) return { date, ...(holiday ? { holiday } : {}) };
  return {
    date,
    session,
    ...(holiday ? { holiday } : {}),
    loginCheckAt: minutes(session.open, -SCHEDULE.loginCheckBeforeOpen),
    startAt: minutes(session.open, -SCHEDULE.startBeforeOpen),
    stopAt: minutes(session.close, SCHEDULE.stopAfterClose),
  };
}

export function phaseAt(plan: DayPlan, now: Date): Phase {
  if (!plan.session) return "closed";
  if (now < plan.loginCheckAt!) return "waiting";
  if (now < plan.startAt!) return "login-check";
  if (now < plan.stopAt!) return "trading";
  return "after";
}
