import { expect, test } from "bun:test";
import {
  addDays,
  formatIst,
  isWeekend,
  isWithinMarketHours,
  istDate,
  istDateTime,
  istMinutes,
  parseHHMM,
  weekdayOf,
} from "../src/utils/time";

test("converts UTC instants to IST", () => {
  const d = new Date("2026-10-05T03:50:00Z"); // 09:20 IST
  expect(istDate(d)).toBe("2026-10-05");
  expect(istMinutes(d)).toBe(560);
  expect(formatIst(d)).toBe("2026-10-05 09:20:00");
});

test("IST date can differ from the UTC date", () => {
  const d = new Date("2026-10-05T19:00:00Z"); // 00:30 IST on the 6th
  expect(istDate(d)).toBe("2026-10-06");
  expect(istMinutes(d)).toBe(30);
});

test("istDateTime round-trips and rejects bad input", () => {
  const d = istDateTime("2026-10-06", "15:30");
  expect(d.toISOString()).toBe("2026-10-06T10:00:00.000Z");
  expect(formatIst(d)).toBe("2026-10-06 15:30:00");
  expect(() => istDateTime("2026-02-30", "09:15")).toThrow("Invalid date");
  expect(() => istDateTime("2026-10-06", "9:15")).toThrow("Invalid time");
});

test("parses HH:MM", () => {
  expect(parseHHMM("09:15")).toBe(555);
  expect(parseHHMM("23:59")).toBe(1439);
  expect(() => parseHHMM("24:00")).toThrow();
  expect(() => parseHHMM("09:60")).toThrow();
});

test("date arithmetic across months and years", () => {
  expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  expect(weekdayOf("2026-10-05")).toBe(1); // Monday
  expect(isWeekend("2026-10-03")).toBe(true);
  expect(isWeekend("2026-10-05")).toBe(false);
});

test("market hours are 09:15 up to (not including) 15:30 on weekdays", () => {
  expect(isWithinMarketHours(istDateTime("2026-10-05", "09:14"))).toBe(false);
  expect(isWithinMarketHours(istDateTime("2026-10-05", "09:15"))).toBe(true);
  expect(isWithinMarketHours(istDateTime("2026-10-05", "15:29"))).toBe(true);
  expect(isWithinMarketHours(istDateTime("2026-10-05", "15:30"))).toBe(false);
  expect(isWithinMarketHours(istDateTime("2026-10-03", "11:00"))).toBe(false); // Saturday
});
