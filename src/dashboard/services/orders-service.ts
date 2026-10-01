import type { Database } from "bun:sqlite";
import { istDate, istDateTime } from "../../utils/time";
import type { OrdersResponse } from "../api/types";

/** Today's orders (newest first), as the bot saved them. */
export class OrdersService {
  constructor(
    private readonly db: Database,
    private readonly opts: { mode: "paper" | "live"; now?: () => Date },
  ) {}

  today(): OrdersResponse {
    const since = istDateTime(istDate(this.opts.now?.() ?? new Date()), "00:00").toISOString();
    const rows = this.db
      .query(
        `SELECT id, strategy_id, symbol, side, quantity, filled_quantity, average_price, status, status_message, placed_at
         FROM orders WHERE mode = $mode AND placed_at >= $since ORDER BY placed_at DESC, id DESC`,
      )
      .all({ mode: this.opts.mode, since }) as {
      id: string;
      strategy_id: string | null;
      symbol: string;
      side: "BUY" | "SELL";
      quantity: number;
      filled_quantity: number;
      average_price: number;
      status: string;
      status_message: string | null;
      placed_at: string;
    }[];
    return {
      orders: rows.map((r) => ({
        id: r.id,
        ...(r.strategy_id ? { strategyId: r.strategy_id } : {}),
        symbol: r.symbol,
        side: r.side,
        quantity: r.quantity,
        filledQuantity: r.filled_quantity,
        averagePrice: r.average_price,
        status: r.status,
        ...(r.status_message ? { statusMessage: r.status_message } : {}),
        placedAt: r.placed_at,
      })),
    };
  }
}
