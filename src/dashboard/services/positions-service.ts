import type { Database } from "bun:sqlite";
import { ScripStore } from "../../store/scrip-store";
import { istDate, istDateTime } from "../../utils/time";
import type { OpenPosition, PositionsResponse } from "../api/types";

interface FillRow {
  strategy_id: string | null;
  instrument_key: string;
  symbol: string;
  side: "BUY" | "SELL";
  filled_quantity: number;
  average_price: number;
}

/**
 * Today's open positions and their unrealised P&L, all from the bot's database: positions from
 * order fills, prices from the scrips table the bot keeps up to date.
 */
export class PositionsService {
  private readonly scrips: ScripStore;

  constructor(
    private readonly db: Database,
    private readonly opts: { mode: "paper" | "live"; now?: () => Date },
  ) {
    this.scrips = new ScripStore(db);
  }

  positions(): PositionsResponse {
    const now = this.opts.now?.() ?? new Date();
    const since = istDateTime(istDate(now), "00:00").toISOString();
    const fills = this.db
      .query(
        `SELECT strategy_id, instrument_key, symbol, side, filled_quantity, average_price FROM orders
         WHERE mode = $mode AND placed_at >= $since AND filled_quantity > 0`,
      )
      .all({ mode: this.opts.mode, since }) as FillRow[];

    // Net each instrument per strategy: bought vs sold quantity and value.
    const books = new Map<string, { row: FillRow; buyQty: number; buyValue: number; sellQty: number; sellValue: number }>();
    for (const f of fills) {
      const id = `${f.strategy_id ?? ""}\u0000${f.instrument_key}`;
      const book = books.get(id) ?? { row: f, buyQty: 0, buyValue: 0, sellQty: 0, sellValue: 0 };
      if (f.side === "BUY") {
        book.buyQty += f.filled_quantity;
        book.buyValue += f.filled_quantity * f.average_price;
      } else {
        book.sellQty += f.filled_quantity;
        book.sellValue += f.filled_quantity * f.average_price;
      }
      books.set(id, book);
    }
    const open = [...books.values()].filter((b) => b.buyQty !== b.sellQty);

    const pricesRecorded = this.hasScripsTable();
    const latest = pricesRecorded ? this.scrips.get([...new Set(open.map((b) => b.row.instrument_key))]) : new Map();
    const positions: OpenPosition[] = open
      .map((b) => {
        const quantity = b.buyQty - b.sellQty;
        const averagePrice = quantity > 0 ? b.buyValue / b.buyQty : b.sellValue / b.sellQty;
        const scrip = latest.get(b.row.instrument_key);
        return {
          strategyId: b.row.strategy_id ?? undefined,
          instrumentKey: b.row.instrument_key,
          symbol: b.row.symbol,
          quantity,
          averagePrice: round2(averagePrice),
          ...(scrip
            ? { ltp: scrip.ltp, cp: scrip.cp, priceTime: scrip.updatedAt.toISOString(), pnl: round2((scrip.ltp - averagePrice) * quantity) }
            : {}),
        };
      })
      .sort((a, b) => (a.strategyId ?? "").localeCompare(b.strategyId ?? "") || a.symbol.localeCompare(b.symbol));

    const priced = positions.filter((p) => p.pnl !== undefined);
    const times = priced.map((p) => p.priceTime!).sort();
    return {
      positions,
      openPnl: round2(priced.reduce((sum, p) => sum + p.pnl!, 0)),
      missingPrices: positions.length - priced.length,
      pricesAsOf: times[0],
      pricesRecorded,
    };
  }

  private hasScripsTable(): boolean {
    return this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scrips'").get() !== null;
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
