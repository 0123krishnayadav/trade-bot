// Indian market time helpers. Dates are "YYYY-MM-DD" strings, times of day are "HH:MM".
import dayjs, { type Dayjs } from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import customParseFormat from "dayjs/plugin/customParseFormat";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

export const IST = "Asia/Kolkata";

/** NSE equity and F&O regular session. Exchange holidays are handled by the market calendar (step 15). */
export const MARKET_OPEN = "09:15";
export const MARKET_CLOSE = "15:30";

/** A dayjs object in IST, e.g. ist().format("HH:mm") or ist(order.createdAt).add(5, "minute"). */
export function ist(d: Date | number = new Date()): Dayjs {
  return dayjs(d).tz(IST);
}

/** IST calendar date, e.g. "2026-10-05". */
export function istDate(d: Date): string {
  return ist(d).format("YYYY-MM-DD");
}

/** Minutes since IST midnight, e.g. 09:20 -> 560. */
export function istMinutes(d: Date): number {
  const t = ist(d);
  return t.hour() * 60 + t.minute();
}

/** "2026-10-05 09:20:00" in IST. */
export function formatIst(d: Date): string {
  return ist(d).format("YYYY-MM-DD HH:mm:ss");
}

/** "09:20" -> 560 */
export function parseHHMM(hhmm: string): number {
  const t = dayjs(hhmm, "HH:mm", true);
  if (!t.isValid()) throw new Error(`Invalid time "${hhmm}", expected HH:MM`);
  return t.hour() * 60 + t.minute();
}

/** The instant for an IST date and time of day, e.g. ("2026-10-06", "15:30"). */
export function istDateTime(date: string, hhmm: string): Date {
  if (!dayjs(date, "YYYY-MM-DD", true).isValid()) throw new Error(`Invalid date "${date}", expected YYYY-MM-DD`);
  parseHHMM(hhmm);
  return dayjs.tz(`${date} ${hhmm}`, "YYYY-MM-DD HH:mm", IST).toDate();
}

export function addDays(date: string, days: number): string {
  return dayjs.utc(date).add(days, "day").format("YYYY-MM-DD");
}

/** 0 = Sunday ... 6 = Saturday */
export function weekdayOf(date: string): number {
  return dayjs.utc(date).day();
}

export function isWeekend(date: string): boolean {
  const day = weekdayOf(date);
  return day === 0 || day === 6;
}

/** Whether `d` falls in the regular session on a weekday. Doesn't know about holidays yet. */
export function isWithinMarketHours(d: Date): boolean {
  const minute = istMinutes(d);
  return !isWeekend(istDate(d)) && minute >= parseHHMM(MARKET_OPEN) && minute < parseHHMM(MARKET_CLOSE);
}
