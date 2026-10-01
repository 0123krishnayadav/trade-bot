import type { Database } from "bun:sqlite";
import { TradingStore } from "../../store/trading-store";
import { istDate } from "../../utils/time";
import type { KillSwitchResponse } from "../api/types";

export class KillSwitchUnavailable extends Error {}

/**
 * Turns the kill switch on for today by writing one row; the bot sees it within a second (it
 * checks on every clock tick) and squares off. The dashboard's only write to the database.
 */
export class KillSwitchService {
  private readonly store: TradingStore;

  constructor(
    private readonly db: Database,
    private readonly opts: { mode: "paper" | "live"; now?: () => Date },
  ) {
    this.store = new TradingStore(db, opts.mode);
  }

  activate(): KillSwitchResponse {
    if (!this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kill_switch'").get()) {
      throw new KillSwitchUnavailable("the kill switch table doesn't exist yet: restart the bot on this version first");
    }
    const tradeDate = istDate(this.opts.now?.() ?? new Date());
    const activatedAt = this.store.activateKillSwitch(tradeDate, "dashboard", this.opts.now?.());
    return { tradeDate, activatedAt: activatedAt.toISOString() };
  }
}
