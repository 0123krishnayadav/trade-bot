import type { Database } from "bun:sqlite";
import { buildReport } from "../../reports/report";
import { TradingStore } from "../../store/trading-store";
import type { HistoryResponse, HistorySummary, HistoryTrade, TradeFill } from "../api/types";

interface TradeRow {
  id: number;
  strategy_id: string;
  trade_date: string;
  opened_at: string;
  closed_at: string;
  exit_reason: string;
  gross_pnl: number;
  charges: number;
  net_pnl: number;
}

interface FillRow {
  strategy_id: string;
  instrument_key: string;
  symbol: string;
  side: "BUY" | "SELL";
  filled_quantity: number;
  average_price: number;
  placed_at: string;
}

/** Closed trades and their totals, from strategy_trades; what was bought and sold, from orders. */
export class HistoryService {
  constructor(
    private readonly db: Database,
    private readonly opts: { mode: "paper" | "live" },
  ) {}

  summary(): HistorySummary {
    return buildReport(new TradingStore(this.db, this.opts.mode).trades());
  }

  history(): HistoryResponse {
    const trades = this.db
      .query("SELECT * FROM strategy_trades WHERE mode = $mode ORDER BY closed_at")
      .all({ mode: this.opts.mode }) as TradeRow[];
    const fills = this.db
      .query(
        `SELECT strategy_id, instrument_key, symbol, side, filled_quantity, average_price, placed_at FROM orders
         WHERE mode = $mode AND strategy_id IS NOT NULL AND filled_quantity > 0 ORDER BY placed_at`,
      )
      .all({ mode: this.opts.mode }) as FillRow[];

    // A trade's orders are its strategy's orders placed after the strategy's previous trade closed
    // and up to this one's close. Works for any strategy, however many trades it makes a day.
    const fillsByStrategy = Map.groupBy(fills, (f) => f.strategy_id);
    const prevClose = new Map<string, string>();
    const result: HistoryTrade[] = trades.map((t) => {
      const after = prevClose.get(t.strategy_id) ?? "";
      prevClose.set(t.strategy_id, t.closed_at);
      const own = (fillsByStrategy.get(t.strategy_id) ?? []).filter((f) => f.placed_at > after && f.placed_at <= t.closed_at);
      return {
        id: t.id,
        tradeDate: t.trade_date,
        strategyId: t.strategy_id,
        exitReason: t.exit_reason,
        openedAt: t.opened_at,
        closedAt: t.closed_at,
        grossPnl: t.gross_pnl,
        charges: t.charges,
        netPnl: t.net_pnl,
        bought: combine(own.filter((f) => f.side === "BUY")),
        sold: combine(own.filter((f) => f.side === "SELL")),
      };
    });

    return { summary: this.summary(), trades: result.reverse() };
  }
}

/** One line per instrument: total quantity at the quantity-weighted average price. */
function combine(fills: FillRow[]): TradeFill[] {
  const byKey = new Map<string, TradeFill & { value: number }>();
  for (const f of fills) {
    const line = byKey.get(f.instrument_key) ?? { instrumentKey: f.instrument_key, symbol: f.symbol, quantity: 0, averagePrice: 0, value: 0 };
    line.quantity += f.filled_quantity;
    line.value += f.filled_quantity * f.average_price;
    byKey.set(f.instrument_key, line);
  }
  return [...byKey.values()]
    .map(({ value, ...line }) => ({ ...line, averagePrice: round2(value / line.quantity) }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

const round2 = (n: number) => Math.round(n * 100) / 100;
