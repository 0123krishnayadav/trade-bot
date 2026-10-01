import type { Scrip, ScripStore } from "../store/scrip-store";
import type { Logger } from "../utils/logger";
import type { MarketEngine } from "./market-engine";

/**
 * Saves the latest price of every subscribed instrument to the `scrips` table, so other processes
 * (the dashboard) can show live P&L without their own broker connection. Ticks are batched and
 * written at most once per interval, only for instruments that changed.
 */
export class ScripRecorder {
  private readonly pending = new Map<string, Omit<Scrip, "updatedAt">>();
  private timer?: ReturnType<typeof setInterval>;
  private stopListening?: () => void;

  constructor(
    private readonly market: MarketEngine,
    private readonly store: ScripStore,
    private readonly opts: { intervalMs?: number; logger?: Logger } = {},
  ) {}

  start(): void {
    this.stopListening ??= this.market.onAnyTick((tick) => {
      this.pending.set(tick.instrumentKey, { instrumentKey: tick.instrumentKey, ltp: tick.ltp, cp: tick.prevClose });
    });
    this.timer ??= setInterval(() => this.flush(), this.opts.intervalMs ?? 1000);
  }

  stop(): void {
    this.stopListening?.();
    this.stopListening = undefined;
    clearInterval(this.timer);
    this.timer = undefined;
    this.flush();
  }

  flush(): void {
    if (this.pending.size === 0) return;
    const scrips = [...this.pending.values()];
    this.pending.clear();
    try {
      this.store.saveMany(scrips);
    } catch (err) {
      // Prices are for display only; never let this disturb trading.
      this.opts.logger?.warn("could not save scrips", { error: String(err) });
    }
  }
}
