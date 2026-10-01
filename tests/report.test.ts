import { expect, test } from "bun:test";
import { buildReport, formatReport, type ReportTrade } from "../src/reports/report";

const trade = (date: string, hhmm: string, net: number, reason = "TIME_EXIT"): ReportTrade => ({
  tradeDate: date,
  closedAt: new Date(`${date}T${hhmm}:00+05:30`),
  exitReason: reason,
  grossPnl: net + 100,
  charges: 100,
  netPnl: net,
});

test("win rate, averages, expectancy, profit factor and drawdown", () => {
  const r = buildReport([
    trade("2026-10-05", "15:15", 1000),
    trade("2026-10-06", "11:00", -1500, "STOP_LOSS"),
    trade("2026-10-07", "12:00", 600, "TARGET"),
    trade("2026-10-07", "15:15", -300),
    trade("2026-10-08", "15:15", 2000),
  ]);
  expect(r).toMatchObject({
    trades: 5,
    wins: 3,
    losses: 2,
    winRate: 60,
    netPnl: 1800,
    grossPnl: 2300,
    charges: 500,
    avgWin: 1200,
    avgLoss: -900,
    expectancy: 360,
    profitFactor: 2,
    bestTrade: 2000,
    worstTrade: -1500,
    since: "2026-10-05",
  });
  // cumulative: 1000, -500, 100, -200, 1800 -> peak 1000, lowest after it -500 -> drawdown 1500
  expect(r.maxDrawdown).toBe(1500);
  expect(r.exitReasons).toEqual([
    { reason: "TIME_EXIT", trades: 3, netPnl: 2700 },
    { reason: "STOP_LOSS", trades: 1, netPnl: -1500 },
    { reason: "TARGET", trades: 1, netPnl: 600 },
  ]);
  expect(r.daily).toEqual([
    { date: "2026-10-05", trades: 1, netPnl: 1000, cumulative: 1000 },
    { date: "2026-10-06", trades: 1, netPnl: -1500, cumulative: -500 },
    { date: "2026-10-07", trades: 2, netPnl: 300, cumulative: -200 },
    { date: "2026-10-08", trades: 1, netPnl: 2000, cumulative: 1800 },
  ]);
});

test("a losing first trade counts as drawdown from zero; no losses means no profit factor", () => {
  expect(buildReport([trade("2026-10-05", "15:15", -400), trade("2026-10-06", "15:15", 100)]).maxDrawdown).toBe(400);
  expect(buildReport([trade("2026-10-05", "15:15", 400)]).profitFactor).toBeUndefined();
});

test("empty report, and the text version", () => {
  expect(buildReport([])).toMatchObject({ trades: 0, winRate: 0, expectancy: 0, maxDrawdown: 0, daily: [], exitReasons: [] });
  expect(formatReport(buildReport([]), "Report")).toContain("No closed trades yet.");
  const text = formatReport(buildReport([trade("2026-10-05", "15:15", 1000)]), "Report");
  expect(text).toContain("Win rate      100%");
  expect(text).toContain("2026-10-05");
});
