import type { Database } from "bun:sqlite";
import { SessionStore } from "../../store/session-store";
import { TradingStore } from "../../store/trading-store";
import { istDate } from "../../utils/time";
import type { StatusResponse, StrategyStatus, TradePlan } from "../api/types";

export interface StatusServiceOptions {
  broker: string;
  mode: "paper" | "live";
  risk: StatusResponse["risk"];
  now?: () => Date;
}

/** Builds the overview shown on the home page from the bot's database (read-only). */
export class StatusService {
  private readonly sessions: SessionStore;
  private readonly trading: TradingStore;
  private readonly now: () => Date;

  constructor(
    private readonly db: Database,
    private readonly opts: StatusServiceOptions,
  ) {
    this.sessions = new SessionStore(db);
    this.trading = new TradingStore(db, opts.mode);
    this.now = opts.now ?? (() => new Date());
  }

  status(): StatusResponse {
    const now = this.now();
    const today = istDate(now);
    // Only safe fields leave the server: never the access token.
    const session = this.sessions.get(this.opts.broker, now);
    const trades = this.trading.trades().filter((t) => t.tradeDate === today);
    const sum = (pick: (t: (typeof trades)[number]) => number) => Math.round(trades.reduce((s, t) => s + pick(t), 0) * 100) / 100;

    return {
      serverTime: now.toISOString(),
      mode: this.opts.mode,
      broker: session
        ? { name: this.opts.broker, loggedIn: true, userId: session.userId, userName: session.userName, validUntil: session.expiresAt.toISOString() }
        : { name: this.opts.broker, loggedIn: false },
      strategies: this.strategies(),
      ...this.killSwitch(today),
      risk: this.opts.risk,
      today: {
        date: today,
        closedTrades: trades.length,
        grossPnl: sum((t) => t.grossPnl),
        charges: sum((t) => t.charges),
        netPnl: sum((t) => t.netPnl),
      },
    };
  }

  private killSwitch(today: string): Pick<StatusResponse, "killSwitch"> {
    try {
      const pressed = this.trading.killSwitch(today);
      return pressed ? { killSwitch: { activatedAt: pressed.activatedAt.toISOString() } } : {};
    } catch {
      return {}; // table not created yet: the bot hasn't run this version
    }
  }

  private strategies(): StrategyStatus[] {
    const rows = this.db
      .query("SELECT strategy_id, state, updated_at FROM strategy_state WHERE mode = $mode ORDER BY strategy_id")
      .all({ mode: this.opts.mode }) as { strategy_id: string; state: string; updated_at: string }[];
    return rows.map((row) => {
      let state: Record<string, unknown> = {};
      try {
        state = JSON.parse(row.state);
      } catch {
        // shown as "unknown" below
      }
      const text = (v: unknown) => (typeof v === "string" ? v : undefined);
      const num = (v: unknown) => (typeof v === "number" ? v : undefined);
      const plan: TradePlan = {
        atm: num(state.atm),
        expiry: text(state.expiry),
        spot: num(state.spot),
        credit: num(state.credit),
        maxProfit: num(state.maxProfit),
        maxLoss: num(state.maxLoss),
        target: num(state.target),
        stopLoss: num(state.stopLoss),
        openedAt: text(state.openedAt),
      };
      const defined = Object.fromEntries(Object.entries(plan).filter(([, v]) => v !== undefined)) as TradePlan;
      return {
        id: row.strategy_id,
        phase: text(state.phase) ?? "unknown",
        date: text(state.date),
        note: text(state.note),
        exitReason: text(state.exitReason),
        updatedAt: row.updated_at,
        ...(Object.keys(defined).length ? { trade: defined } : {}),
      };
    });
  }
}
