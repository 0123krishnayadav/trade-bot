import { expect, test } from "bun:test";
import type { Candle, Tick } from "../src/core/types";
import { CandleSeries, candleBounds } from "../src/engine/candle-series";
import { formatIst, istDateTime } from "../src/utils/time";

const DAY = "2026-10-05";
const at = (hhmmss: string, date = DAY) =>
  new Date(istDateTime(date, hhmmss.slice(0, 5)).getTime() + Number(hhmmss.slice(6) || 0) * 1000);
const tick = (time: string, ltp: number, extra: Partial<Tick> = {}): Tick => ({ instrumentKey: "K", ltp, time: at(time), prevClose: 0, ...extra });
const bounds = (time: string, tf: Parameters<typeof candleBounds>[1]) => {
  const b = candleBounds(at(time), tf);
  return b && `${formatIst(b.start).slice(11, 16)}-${formatIst(b.end).slice(11, 16)}`;
};

test("candles align to the 09:15 open and the last one ends at 15:30", () => {
  expect(bounds("09:15:00", "5m")).toBe("09:15-09:20");
  expect(bounds("09:19:59", "5m")).toBe("09:15-09:20");
  expect(bounds("09:20:00", "5m")).toBe("09:20-09:25");
  expect(bounds("10:14:00", "1h")).toBe("09:15-10:15");
  expect(bounds("15:20:00", "1h")).toBe("15:15-15:30");
  expect(bounds("15:20:00", "30m")).toBe("15:15-15:30");
  expect(bounds("11:00:00", "1d")).toBe("00:00-15:30");
  expect(bounds("09:14:59", "1m")).toBeUndefined();
  expect(bounds("15:30:00", "1m")).toBeUndefined();
});

test("builds OHLC from ticks and completes on the next candle's first tick", () => {
  const s = new CandleSeries("K", "5m");
  expect(s.applyTick(tick("09:15:01", 100))).toEqual([]);
  s.applyTick(tick("09:16:00", 104));
  s.applyTick(tick("09:17:00", 98));
  s.applyTick(tick("09:19:59", 101));
  expect(s.forming()).toMatchObject({ open: 100, high: 104, low: 98, close: 101 });
  const done = s.applyTick(tick("09:20:02", 102));
  expect(done).toHaveLength(1);
  expect(done[0]).toMatchObject({ instrumentKey: "K", timeframe: "5m", time: at("09:15:00"), open: 100, high: 104, low: 98, close: 101 });
  expect(s.forming()).toMatchObject({ time: at("09:20:00"), open: 102 });
});

test("completes on time even when no further tick arrives", () => {
  const s = new CandleSeries("K", "1m");
  s.applyTick(tick("09:15:10", 100));
  expect(s.closeDue(at("09:15:59"))).toEqual([]);
  expect(s.closeDue(at("09:16:00"))).toHaveLength(1);
  expect(s.forming()).toBeUndefined();
  expect(s.closeDue(at("09:17:00"))).toEqual([]); // nothing forming
});

test("skips empty periods without inventing candles", () => {
  const s = new CandleSeries("K", "1m");
  s.applyTick(tick("09:15:10", 100));
  const done = s.applyTick(tick("09:18:05", 101)); // no ticks 09:16-09:18
  expect(done.map((c) => c.time)).toEqual([at("09:15:00")]);
  expect(s.forming()?.time).toEqual(at("09:18:00"));
});

test("ignores ticks outside the session and late ticks for finished candles", () => {
  const s = new CandleSeries("K", "5m");
  expect(s.applyTick(tick("09:10:00", 99))).toEqual([]); // pre-open
  expect(s.forming()).toBeUndefined();
  s.applyTick(tick("09:21:00", 100));
  s.applyTick(tick("09:19:00", 50)); // late / out of order
  expect(s.forming()).toMatchObject({ low: 100, high: 100 });
  const prevDay: Tick = { instrumentKey: "K", ltp: 1, time: at("15:29:00", "2026-10-02"), prevClose: 0 };
  expect(s.applyTick(prevDay)).toEqual([]); // yesterday's last trade, as brokers send on connect
  expect(s.forming()?.low).toBe(100);
});

test("candle volume from the running day total, resetting on a new day", () => {
  const s = new CandleSeries("K", "1m");
  s.applyTick(tick("09:15:01", 100, { volume: 1000 })); // first total we see: count from here
  s.applyTick(tick("09:15:30", 100, { volume: 1600 }));
  const [first] = s.applyTick(tick("09:16:10", 100, { volume: 2000 }));
  expect(first!.volume).toBe(600);
  s.closeDue(at("09:17:00"));
  expect(s.candles().at(-1)!.volume).toBe(400); // 2000 - 1600
  s.applyTick({ ...tick("09:15:05", 100, { volume: 300 }), time: at("09:15:05", "2026-10-06") }); // next day
  expect(s.forming()?.volume).toBe(300);
});

test("daily volume is the broker's day total, including pre-open trades", () => {
  const s = new CandleSeries("K", "1d");
  s.applyTick(tick("11:00:00", 100, { volume: 5_000_000 })); // bot started mid-day
  s.applyTick(tick("11:00:05", 100, { volume: 5_000_700 }));
  expect(s.forming()?.volume).toBe(5_000_700);
});

test("keeps OI from the latest tick", () => {
  const s = new CandleSeries("K", "5m");
  s.applyTick(tick("09:15:01", 100, { oi: 5000 }));
  s.applyTick(tick("09:16:01", 101, { oi: 5200 }));
  expect(s.forming()?.oi).toBe(5200);
});

const hist = (time: string, close: number, extra: Partial<Candle> = {}): Candle => ({
  instrumentKey: "K",
  timeframe: "5m",
  time: at(time),
  open: close,
  high: close,
  low: close,
  close,
  volume: 10,
  oi: 0,
  ...extra,
});

test("history fills completed candles and seeds the forming one", () => {
  const s = new CandleSeries("K", "5m");
  s.mergeHistory([hist("09:15:00", 1), hist("09:20:00", 2), hist("09:25:00", 3, { open: 2.5, high: 3.5, low: 2, volume: 40 })], at("09:27:00"));
  expect(s.candles().map((c) => c.close)).toEqual([1, 2]);
  expect(s.forming()).toMatchObject({ time: at("09:25:00"), open: 2.5, high: 3.5, volume: 40 });

  s.applyTick(tick("09:28:00", 4, { volume: 5000 }));
  s.applyTick(tick("09:29:00", 1.5, { volume: 5100 }));
  expect(s.forming()).toMatchObject({ open: 2.5, high: 4, low: 1.5, close: 1.5, volume: 140 }); // 40 from history + 100 live
});

test("history loaded after live ticks corrects the forming candle's open, high and low", () => {
  const s = new CandleSeries("K", "5m");
  s.applyTick(tick("09:27:00", 3));
  s.mergeHistory([hist("09:20:00", 2), hist("09:25:00", 3, { open: 2.2, high: 3.8, low: 2.1 })], at("09:27:30"));
  expect(s.candles().map((c) => c.close)).toEqual([2]);
  expect(s.forming()).toMatchObject({ open: 2.2, high: 3.8, low: 2.1, close: 3 });
});

test("history refill after a gap fills holes without duplicates", () => {
  const s = new CandleSeries("K", "1m");
  s.applyTick(tick("09:15:10", 1));
  s.applyTick(tick("09:18:10", 4)); // 09:16 and 09:17 missed while disconnected
  s.mergeHistory([hist("09:15:00", 1), hist("09:16:00", 2), hist("09:17:00", 3), hist("09:18:00", 4)], at("09:18:30"));
  expect(s.candles().map((c) => formatIst(c.time).slice(11, 16))).toEqual(["09:15", "09:16", "09:17"]);
  expect(s.forming()?.time).toEqual(at("09:18:00"));
});

test("keeps at most maxLength candles", () => {
  const s = new CandleSeries("K", "1m", 3);
  for (let m = 15; m < 25; m++) s.applyTick(tick(`09:${m}:01`, m));
  expect(s.candles().map((c) => c.close)).toEqual([21, 22, 23]);
});

test("daily candles merge with history stamped 00:00", () => {
  const s = new CandleSeries("K", "1d");
  const daily = (date: string, close: number): Candle => ({ ...hist("09:15:00", close), timeframe: "1d", time: istDateTime(date, "00:00") });
  s.mergeHistory([daily("2026-10-01", 1), daily("2026-10-05", 2)], at("11:00:00"));
  expect(s.candles().map((c) => c.close)).toEqual([1]);
  expect(s.forming()).toMatchObject({ close: 2 });
  s.applyTick(tick("11:00:01", 5));
  expect(s.forming()).toMatchObject({ time: istDateTime(DAY, "00:00"), close: 5, high: 5 });
  expect(s.closeDue(at("15:30:00"))).toHaveLength(1);
});
