// Trade statistics: the numbers that decide whether a strategy is worth running live.

export interface ReportTrade {
  /** IST date, YYYY-MM-DD. */
  tradeDate: string;
  closedAt: Date;
  exitReason: string;
  grossPnl: number;
  charges: number;
  netPnl: number;
}

export interface Report {
  trades: number;
  wins: number;
  losses: number;
  /** Percent of trades with a positive net P&L. */
  winRate: number;
  grossPnl: number;
  charges: number;
  netPnl: number;
  /** Average net P&L of winning / losing trades (losses are negative). */
  avgWin: number;
  avgLoss: number;
  /** Average net P&L per trade, after costs: what one more trade is expected to make. */
  expectancy: number;
  /** Sum of wins / sum of losses; undefined with no losing trade. */
  profitFactor?: number;
  /** Largest fall of cumulative net P&L from a previous high, in rupees (positive). */
  maxDrawdown: number;
  bestTrade: number;
  worstTrade: number;
  /** IST date of the first trade. */
  since?: string;
  exitReasons: { reason: string; trades: number; netPnl: number }[];
  /** Oldest first, with the running total. */
  daily: { date: string; trades: number; netPnl: number; cumulative: number }[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function buildReport(input: ReportTrade[]): Report {
  const trades = [...input].sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime());
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl <= 0);
  const sum = (list: ReportTrade[], pick: (t: ReportTrade) => number) => list.reduce((s, t) => s + pick(t), 0);
  const winSum = sum(wins, (t) => t.netPnl);
  const lossSum = sum(losses, (t) => t.netPnl);

  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const t of trades) {
    cumulative += t.netPnl;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }

  const byReason = new Map<string, { trades: number; netPnl: number }>();
  const byDay = new Map<string, { trades: number; netPnl: number }>();
  for (const t of trades) {
    for (const [map, k] of [[byReason, t.exitReason], [byDay, t.tradeDate]] as const) {
      const row = map.get(k) ?? { trades: 0, netPnl: 0 };
      row.trades++;
      row.netPnl += t.netPnl;
      map.set(k, row);
    }
  }
  let running = 0;
  const daily = [...byDay]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({ date, trades: d.trades, netPnl: round2(d.netPnl), cumulative: round2((running += d.netPnl)) }));

  const net = trades.map((t) => t.netPnl);
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? round2((wins.length / trades.length) * 100) : 0,
    grossPnl: round2(sum(trades, (t) => t.grossPnl)),
    charges: round2(sum(trades, (t) => t.charges)),
    netPnl: round2(sum(trades, (t) => t.netPnl)),
    avgWin: wins.length ? round2(winSum / wins.length) : 0,
    avgLoss: losses.length ? round2(lossSum / losses.length) : 0,
    expectancy: trades.length ? round2(sum(trades, (t) => t.netPnl) / trades.length) : 0,
    ...(lossSum < 0 ? { profitFactor: round2(winSum / -lossSum) } : {}),
    maxDrawdown: round2(maxDrawdown),
    bestTrade: net.length ? round2(Math.max(...net)) : 0,
    worstTrade: net.length ? round2(Math.min(...net)) : 0,
    ...(trades.length ? { since: daily[0]!.date } : {}),
    exitReasons: [...byReason]
      .map(([reason, r]) => ({ reason, trades: r.trades, netPnl: round2(r.netPnl) }))
      .sort((a, b) => b.trades - a.trades || a.reason.localeCompare(b.reason)),
    daily,
  };
}

/** The report as plain text for the terminal (`bun run report`). */
export function formatReport(r: Report, title: string): string {
  const inr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (r.trades === 0) return `${title}\n\nNo closed trades yet.`;
  const lines = [
    title,
    "",
    `Trades        ${r.trades} (${r.wins} won, ${r.losses} lost) since ${r.since}`,
    `Win rate      ${r.winRate}%`,
    `Net P&L       ${inr(r.netPnl)}  (gross ${inr(r.grossPnl)}, charges ${inr(r.charges)})`,
    `Avg win       ${inr(r.avgWin)}`,
    `Avg loss      ${inr(r.avgLoss)}`,
    `Expectancy    ${inr(r.expectancy)} per trade, after costs`,
    `Profit factor ${r.profitFactor ?? "n/a (no losing trade)"}`,
    `Max drawdown  ${inr(r.maxDrawdown)}`,
    `Best / worst  ${inr(r.bestTrade)} / ${inr(r.worstTrade)}`,
    "",
    "Exit reasons",
    ...r.exitReasons.map((e) => `  ${e.reason.padEnd(13)} ${String(e.trades).padStart(3)}  ${inr(e.netPnl)}`),
    "",
    "Per day",
    ...r.daily.map((d) => `  ${d.date}  ${String(d.trades).padStart(2)}  ${inr(d.netPnl).padStart(12)}  total ${inr(d.cumulative)}`),
  ];
  return lines.join("\n");
}
