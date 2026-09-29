import type { Database } from "bun:sqlite";
import type { Order, RunMode } from "../core/types";

/** One completed round trip of a strategy, e.g. all legs of an iron butterfly opened and closed. */
export interface TradeRecord {
  strategyId: string;
  /** IST date the trade was opened, YYYY-MM-DD. */
  tradeDate: string;
  openedAt: Date;
  closedAt: Date;
  exitReason: string;
  grossPnl: number;
  /** Estimated brokerage and taxes. */
  charges: number;
  netPnl: number;
  details?: unknown;
}

/** Orders, completed trades and per-strategy saved state, kept apart by mode (paper/live). */
export class TradingStore {
  constructor(
    private readonly db: Database,
    private readonly mode: RunMode,
  ) {}

  /** Inserts or updates an order's latest state. */
  saveOrder(broker: string, order: Order, strategyId?: string): void {
    this.db
      .query(
        `INSERT INTO orders (mode, broker, id, strategy_id, instrument_key, symbol, side, type, product, quantity, price,
           trigger_price, status, filled_quantity, average_price, status_message, tag, placed_at, updated_at)
         VALUES ($mode, $broker, $id, $strategyId, $instrumentKey, $symbol, $side, $type, $product, $quantity, $price,
           $triggerPrice, $status, $filledQuantity, $averagePrice, $statusMessage, $tag, $placedAt, $updatedAt)
         ON CONFLICT (mode, broker, id) DO UPDATE SET
           strategy_id = COALESCE(excluded.strategy_id, orders.strategy_id), quantity = excluded.quantity,
           price = excluded.price, trigger_price = excluded.trigger_price, type = excluded.type, status = excluded.status,
           filled_quantity = excluded.filled_quantity, average_price = excluded.average_price,
           status_message = excluded.status_message, updated_at = excluded.updated_at`,
      )
      .run({
        mode: this.mode,
        broker,
        id: order.id,
        strategyId: strategyId ?? null,
        instrumentKey: order.instrumentKey,
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        product: order.product,
        quantity: order.quantity,
        price: order.price,
        triggerPrice: order.triggerPrice,
        status: order.status,
        filledQuantity: order.filledQuantity,
        averagePrice: order.averagePrice,
        statusMessage: order.statusMessage ?? null,
        tag: order.tag ?? null,
        placedAt: order.placedAt.toISOString(),
        updatedAt: new Date().toISOString(),
      });
  }

  saveTrade(t: TradeRecord): void {
    this.db
      .query(
        `INSERT INTO strategy_trades (mode, strategy_id, trade_date, opened_at, closed_at, exit_reason, gross_pnl, charges, net_pnl, details)
         VALUES ($mode, $strategyId, $tradeDate, $openedAt, $closedAt, $exitReason, $grossPnl, $charges, $netPnl, $details)`,
      )
      .run({
        mode: this.mode,
        strategyId: t.strategyId,
        tradeDate: t.tradeDate,
        openedAt: t.openedAt.toISOString(),
        closedAt: t.closedAt.toISOString(),
        exitReason: t.exitReason,
        grossPnl: t.grossPnl,
        charges: t.charges,
        netPnl: t.netPnl,
        details: t.details === undefined ? null : JSON.stringify(t.details),
      });
  }

  trades(strategyId?: string): TradeRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM strategy_trades WHERE mode = $mode ${strategyId ? "AND strategy_id = $strategyId" : ""} ORDER BY id`,
      )
      .all({ mode: this.mode, ...(strategyId ? { strategyId } : {}) }) as {
      strategy_id: string;
      trade_date: string;
      opened_at: string;
      closed_at: string;
      exit_reason: string;
      gross_pnl: number;
      charges: number;
      net_pnl: number;
      details: string | null;
    }[];
    return rows.map((r) => ({
      strategyId: r.strategy_id,
      tradeDate: r.trade_date,
      openedAt: new Date(r.opened_at),
      closedAt: new Date(r.closed_at),
      exitReason: r.exit_reason,
      grossPnl: r.gross_pnl,
      charges: r.charges,
      netPnl: r.net_pnl,
      details: r.details === null ? undefined : JSON.parse(r.details),
    }));
  }

  /** A strategy's saved state (e.g. its open legs), so a restart can pick up where it left off. */
  loadState<T>(strategyId: string): T | undefined {
    const row = this.db
      .query("SELECT state FROM strategy_state WHERE mode = $mode AND strategy_id = $strategyId")
      .get({ mode: this.mode, strategyId }) as { state: string } | null;
    return row ? (JSON.parse(row.state) as T) : undefined;
  }

  /** Saves state, or clears it when `state` is undefined. */
  saveState(strategyId: string, state: unknown): void {
    if (state === undefined) {
      this.db.query("DELETE FROM strategy_state WHERE mode = $mode AND strategy_id = $strategyId").run({ mode: this.mode, strategyId });
      return;
    }
    this.db
      .query(
        `INSERT INTO strategy_state (mode, strategy_id, state, updated_at) VALUES ($mode, $strategyId, $state, $updatedAt)
         ON CONFLICT (mode, strategy_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run({ mode: this.mode, strategyId, state: JSON.stringify(state), updatedAt: new Date().toISOString() });
  }
}
