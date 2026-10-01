import { FINAL_ORDER_STATUSES, type Instrument, type OptionType, type Order, type Side, type Tick } from "../../core/types";
import type { Strategy, StrategyContext } from "../../engine/strategy";
import { estimateCharges } from "../../brokers/charges";
import { addDays, istDate, istMinutes, isWeekend, MARKET_OPEN, parseHHMM } from "../../utils/time";

export interface IronButterflyConfig {
  /** Index symbol, e.g. "NIFTY"; used for the spot price and as the options' underlying. */
  underlying: string;
  /** Strike spacing, e.g. 50 for NIFTY. */
  strikeStep: number;
  lots: number;
  /** Points between the ATM short strike and each bought wing. */
  wingDistance: number;
  /** HH:MM IST window for entering, and the square-off time. */
  entryTime: string;
  lastEntryTime: string;
  exitTime: string;
  capital: number;
  /** Exit when combined MTM falls to -capital × this %. */
  stopLossPctOfCapital: number;
  /** Exit when combined MTM reaches this % of the maximum possible profit. */
  targetPctOfMaxProfit: number;
  /** 0 trades the nearest expiry even on expiry day; 1 moves to the next expiry on expiry day. */
  minDaysToExpiry: number;
  /** Dates (YYYY-MM-DD) not to trade, e.g. RBI policy, budget, election results. */
  skipDates: string[];
  /** How long to wait for an order to fill before treating it as not filled. */
  fillTimeoutMs: number;
  /** How long to wait for the chosen legs' first quotes after subscribing, per entry attempt. */
  quoteWaitMs: number;
  /** Square off open legs when the bot shuts down. */
  squareOffOnStop: boolean;
}

export const DEFAULT_IRON_BUTTERFLY: IronButterflyConfig = {
  underlying: "NIFTY",
  strikeStep: 50,
  lots: 1,
  wingDistance: 400,
  entryTime: "09:20",
  lastEntryTime: "09:30",
  exitTime: "15:15",
  capital: 500_000,
  stopLossPctOfCapital: 1,
  targetPctOfMaxProfit: 40,
  minDaysToExpiry: 0,
  skipDates: [],
  fillTimeoutMs: 30_000,
  quoteWaitMs: 5_000,
  squareOffOnStop: true,
};

type ExitReason = "TARGET" | "STOP_LOSS" | "TIME_EXIT" | "SHUTDOWN" | "ENTRY_FAILED" | "KILL_SWITCH";

/** One option leg. Fills are accumulated, so partial fills and retries are exact. */
export interface Leg {
  key: string;
  symbol: string;
  /** How the leg is opened: BUY for the wings, SELL for the ATM shorts. */
  side: Side;
  /** Quantity we intend to hold. */
  quantity: number;
  filledIn: number;
  valueIn: number;
  filledOut: number;
  valueOut: number;
  /** Estimated brokerage and taxes on this leg's fills. */
  charges: number;
  /** Orders sent for this leg whose outcome isn't known yet; settled before anything new is sent. */
  pending?: string[];
}

interface State {
  date: string;
  phase: "idle" | "entering" | "open" | "exiting" | "done";
  expiry?: string;
  atm?: number;
  spot?: number;
  legs: Leg[];
  openedAt?: string;
  /** Per-unit net premium received. */
  credit?: number;
  maxProfit?: number;
  maxLoss?: number;
  target?: number;
  stopLoss?: number;
  exitReason?: ExitReason;
  note?: string;
}

const RETRY_MS = 5_000;
const MARKET_OPEN_MINUTE = parseHHMM(MARKET_OPEN);
const openQty = (l: Leg) => l.filledIn - l.filledOut;
const entryPrice = (l: Leg) => (l.filledIn ? l.valueIn / l.filledIn : 0);

/**
 * Intraday iron butterfly: sell the ATM call and put of the nearest expiry, buy a call and put
 * `wingDistance` points away as protection. Wings are bought before the shorts are sold, and the
 * shorts are bought back before the wings are sold, so the position is never naked short. Exits
 * at the MTM target, the stop loss, or the square-off time. One trade per day.
 */
export class IronButterfly implements Strategy {
  readonly id: string;
  private state!: State;
  private spotKey!: string;
  private lastAttempt = 0;
  private lastQuoteWarning = -1;
  private readonly entry: number;
  private readonly lastEntry: number;
  private readonly exit: number;

  constructor(
    private readonly cfg: IronButterflyConfig = DEFAULT_IRON_BUTTERFLY,
    id = "iron-butterfly",
  ) {
    this.id = id;
    this.entry = parseHHMM(cfg.entryTime);
    this.lastEntry = parseHHMM(cfg.lastEntryTime);
    this.exit = parseHHMM(cfg.exitTime);
    if (!(this.entry <= this.lastEntry && this.lastEntry < this.exit)) throw new Error("iron butterfly: need entryTime <= lastEntryTime < exitTime");
  }

  async start(ctx: StrategyContext): Promise<void> {
    const index = ctx.instruments.findIndex(this.cfg.underlying);
    if (!index) throw new Error(`iron butterfly: no index "${this.cfg.underlying}" in the instrument master`);
    this.spotKey = index.key;
    ctx.subscribe([this.spotKey], "ltp");

    const today = istDate(ctx.now());
    const saved = ctx.loadState<State>();
    this.state = { date: today, phase: "idle", legs: [] };
    if (!saved || !["entering", "open", "exiting"].includes(saved.phase)) {
      if (saved?.date === today) this.state = saved; // e.g. already "done" today: don't trade again
      return;
    }

    // A trade was in progress when the bot stopped. Paper positions don't survive a restart;
    // live ones do and must be managed (or squared off) again.
    if (ctx.mode === "paper") {
      ctx.log.warn("discarding an unfinished paper trade from a previous run", { date: saved.date, phase: saved.phase });
      this.save(ctx, { ...this.state, phase: saved.date === today ? "done" : "idle", note: "previous run's paper trade discarded" });
      return;
    }
    const open = await ctx.positions();
    const held = saved.legs.filter((l) => openQty(l) !== 0 && open.some((p) => p.instrumentKey === l.key && p.quantity !== 0));
    if (held.length === 0 && !saved.legs.some((l) => l.pending?.length)) {
      ctx.log.warn("saved trade has no open legs at the broker any more; clearing it", { date: saved.date });
      this.save(ctx, { ...this.state, phase: saved.date === today ? "done" : "idle" });
      return;
    }
    this.state = saved;
    ctx.subscribe(saved.legs.map((l) => l.key), "full");
    ctx.log.warn("resuming a trade from before the restart", { date: saved.date, phase: saved.phase, openLegs: held.length });
    if (saved.date !== today || saved.phase !== "open") await this.exitTrade(ctx, saved.exitReason ?? "SHUTDOWN");
  }

  async onTick(_tick: Tick, ctx: StrategyContext): Promise<void> {
    await this.evaluate(ctx);
  }

  async onClock(_now: Date, ctx: StrategyContext): Promise<void> {
    await this.evaluate(ctx);
  }

  async stop(ctx: StrategyContext): Promise<void> {
    if (!this.state || !["entering", "open", "exiting"].includes(this.state.phase)) return;
    if (this.cfg.squareOffOnStop) await this.exitTrade(ctx, this.state.exitReason ?? "SHUTDOWN");
    else ctx.log.warn("stopping with an open trade (squareOffOnStop is off); it resumes on the next start");
  }

  /** Kill switch: exit now if a trade is on; either way, no (new) trade today. */
  async squareOff(ctx: StrategyContext): Promise<void> {
    // A finished day's state rolls over first, so "no trade today" is marked on today.
    const today = istDate(ctx.now());
    if (this.state.date !== today && !["entering", "open", "exiting"].includes(this.state.phase)) {
      this.state = { date: today, phase: "idle", legs: [] };
    }
    switch (this.state.phase) {
      case "entering":
      case "open":
      case "exiting": // keeps the original exit reason if an exit was already under way
        ctx.log.warn("kill switch: squaring off", { phase: this.state.phase });
        return this.exitTrade(ctx, "KILL_SWITCH");
      case "idle":
        return this.finishDay(ctx, "kill switch");
      default:
        ctx.log.info("kill switch: nothing open");
    }
  }

  // ---------- Rules ----------

  private async evaluate(ctx: StrategyContext): Promise<void> {
    const now = ctx.now();
    const today = istDate(now);
    const minute = istMinutes(now);
    const active = ["entering", "open", "exiting"].includes(this.state.phase);
    if (this.state.date !== today && !active) this.state = { date: today, phase: "idle", legs: [] };

    switch (this.state.phase) {
      case "idle":
        if (isWeekend(today) || minute < this.entry) return;
        if (this.cfg.skipDates.includes(today)) return this.finishDay(ctx, "skip date");
        if (minute > this.lastEntry) return this.finishDay(ctx, "entry window missed");
        return this.enter(ctx);
      case "open": {
        if (minute >= this.exit || this.state.date !== today) return this.exitTrade(ctx, "TIME_EXIT");
        const mtm = this.mtm(ctx);
        if (mtm <= -this.state.stopLoss!) return this.exitTrade(ctx, "STOP_LOSS");
        if (mtm >= this.state.target!) return this.exitTrade(ctx, "TARGET");
        return;
      }
      case "entering": // an entry was interrupted (e.g. an error mid-way): unwind what was filled
      case "exiting":
        if (ctx.now().getTime() - this.lastAttempt >= RETRY_MS) await this.exitTrade(ctx, this.state.exitReason ?? "ENTRY_FAILED");
        return;
      default:
        return;
    }
  }

  private async enter(ctx: StrategyContext): Promise<void> {
    // Only a price from today's session will do: on connect, brokers send yesterday's last price.
    const today = istDate(ctx.now());
    const spotTick = ctx.lastTick(this.spotKey);
    if (!spotTick || istDate(spotTick.time) !== today || istMinutes(spotTick.time) < MARKET_OPEN_MINUTE) return; // wait within the window
    const spot = spotTick.ltp;

    const expiry = ctx.instruments.expiries(this.cfg.underlying, "option", addDays(today, this.cfg.minDaysToExpiry))[0];
    if (!expiry) return this.finishDay(ctx, "no option expiry found");
    const atm = Math.round(spot / this.cfg.strikeStep) * this.cfg.strikeStep;
    const find = (strike: number, optionType: OptionType) => ctx.instruments.findOption({ underlying: this.cfg.underlying, expiry, strike, optionType });
    const [wingCe, wingPe, shortCe, shortPe] = [find(atm + this.cfg.wingDistance, "CE"), find(atm - this.cfg.wingDistance, "PE"), find(atm, "CE"), find(atm, "PE")];
    if (!wingCe || !wingPe || !shortCe || !shortPe) return this.finishDay(ctx, `strikes around ${atm} not listed for ${expiry}`);

    // Quotes for newly subscribed contracts arrive a moment after subscribing. Ordering before
    // they do would be rejected (paper) or blind (live), so wait for all four; if they don't come,
    // stay idle and try again on the next event within the entry window.
    const legKeys = [wingCe, wingPe, shortCe, shortPe].map((i) => i.key);
    ctx.subscribe(legKeys, "full");
    if (!(await this.waitForQuotes(ctx, legKeys))) {
      const minute = istMinutes(ctx.now());
      if (minute !== this.lastQuoteWarning) {
        this.lastQuoteWarning = minute;
        const missing = [wingCe, wingPe, shortCe, shortPe].filter((i) => !hasQuote(ctx, i.key)).map((i) => i.symbol);
        ctx.log.warn("waiting for option quotes before entering", { missing });
      }
      return;
    }

    const quantity = this.cfg.lots * shortCe.lotSize;
    const leg = (i: Instrument, side: Side): Leg => ({ key: i.key, symbol: i.symbol, side, quantity, filledIn: 0, valueIn: 0, filledOut: 0, valueOut: 0, charges: 0 });
    this.lastAttempt = ctx.now().getTime();
    this.save(ctx, {
      ...this.state,
      phase: "entering",
      expiry,
      atm,
      spot,
      openedAt: ctx.now().toISOString(),
      legs: [leg(wingCe, "BUY"), leg(wingPe, "BUY"), leg(shortCe, "SELL"), leg(shortPe, "SELL")],
    });
    ctx.log.info("entering", { spot, atm, expiry, quantity });

    // Hedges first: brokers only give the lower hedged margin once the wings exist.
    for (const side of ["BUY", "SELL"] as const) {
      const results = await Promise.all(this.state.legs.filter((l) => l.side === side).map((l) => this.fillLeg(ctx, l, "entry")));
      if (!results.every(Boolean)) {
        ctx.log.error("entry failed, closing the legs that did fill");
        ctx.notify("⚠️ entry failed, closing the legs that did fill");
        return this.exitTrade(ctx, "ENTRY_FAILED");
      }
    }

    const credit = this.state.legs.reduce((sum, l) => sum + (l.side === "SELL" ? entryPrice(l) : -entryPrice(l)), 0);
    if (!(credit > 0)) {
      // An iron butterfly always takes in premium; anything else means bad quotes or fills.
      ctx.log.error("entry gave no net credit, closing", { credit: round2(credit) });
      return this.exitTrade(ctx, "ENTRY_FAILED");
    }
    const maxProfit = credit * quantity;
    this.save(ctx, {
      ...this.state,
      phase: "open",
      credit: round2(credit),
      maxProfit: round2(maxProfit),
      maxLoss: round2((this.cfg.wingDistance - credit) * quantity),
      target: round2((maxProfit * this.cfg.targetPctOfMaxProfit) / 100),
      stopLoss: round2((this.cfg.capital * this.cfg.stopLossPctOfCapital) / 100),
    });
    const { credit: c, maxProfit: mp, maxLoss, target, stopLoss } = this.state;
    ctx.log.info("entered", { credit: c, maxProfit: mp, maxLoss, target, stopLoss });
    ctx.notify(`entered ${this.cfg.underlying} ${this.state.atm} (expiry ${this.state.expiry}): credit ${c}, target ₹${target}, stop ₹${stopLoss}`);
  }

  /** Buys back the shorts, then sells the wings. Whatever doesn't fill is retried on the next evaluation. */
  private async exitTrade(ctx: StrategyContext, reason: ExitReason): Promise<void> {
    this.lastAttempt = ctx.now().getTime();
    if (this.state.phase !== "exiting") {
      this.save(ctx, { ...this.state, phase: "exiting", exitReason: reason });
      ctx.log.info("exiting", { reason, mtm: round2(this.mtm(ctx)) });
    }
    for (const openedWith of ["SELL", "BUY"] as const) {
      const legs = this.state.legs.filter((l) => l.side === openedWith && (openQty(l) !== 0 || l.pending?.length));
      const results = await Promise.all(legs.map((l) => this.fillLeg(ctx, l, "exit")));
      if (!results.every(Boolean)) {
        const stillOpen = this.state.legs.filter((l) => openQty(l) !== 0 || l.pending?.length).map((l) => l.symbol);
        ctx.log.error("EXIT INCOMPLETE, retrying shortly", { stillOpen });
        ctx.notify(`⚠️ exit incomplete, retrying: ${stillOpen.join(", ")}`);
        return;
      }
    }
    this.record(ctx);
  }

  /**
   * Brings one leg to its target: fully bought/sold for entry, fully closed for exit. Orders from
   * an earlier attempt are settled first (cancelled if still working), so a retry never doubles up.
   * Returns true when the leg reached its target.
   */
  private async fillLeg(ctx: StrategyContext, leg: Leg, stage: "entry" | "exit"): Promise<boolean> {
    const side: Side = stage === "entry" ? leg.side : leg.side === "BUY" ? "SELL" : "BUY";
    const remaining = () => (stage === "entry" ? leg.quantity - leg.filledIn : openQty(leg));

    if (leg.pending?.length) {
      let orders = await ctx.waitForOrders(leg.pending, 1_000);
      for (const o of orders) if (!FINAL_ORDER_STATUSES.includes(o.status)) await ctx.cancelOrder(o.id).catch(() => {});
      orders = await ctx.waitForOrders(leg.pending, this.cfg.fillTimeoutMs);
      if (orders.length < leg.pending.length || orders.some((o) => !FINAL_ORDER_STATUSES.includes(o.status))) return false;
      this.addFills(leg, orders, side, stage);
      leg.pending = undefined;
      this.save(ctx, this.state);
    }

    const quantity = remaining();
    if (quantity <= 0) return true;
    try {
      const result = await ctx.placeOrder({ instrumentKey: leg.key, side, quantity, type: "MARKET", product: "MIS" });
      if (result.error) ctx.log.warn("order partly placed", { symbol: leg.symbol, error: result.error });
      leg.pending = result.orderIds;
      this.save(ctx, this.state);
    } catch (err) {
      ctx.log.error(`${stage} order failed`, { symbol: leg.symbol, error: String(err) });
      return false;
    }

    const orders = await ctx.waitForOrders(leg.pending, this.cfg.fillTimeoutMs);
    if (orders.length < leg.pending.length || orders.some((o) => !FINAL_ORDER_STATUSES.includes(o.status))) {
      ctx.log.error(`${stage} order not final in time`, { symbol: leg.symbol, statuses: orders.map(describe) });
      return false; // settled on the next attempt
    }
    this.addFills(leg, orders, side, stage);
    leg.pending = undefined;
    this.save(ctx, this.state);
    if (remaining() > 0) ctx.log.error(`${stage} leg not fully filled`, { symbol: leg.symbol, remaining: remaining(), statuses: orders.map(describe) });
    return remaining() <= 0;
  }

  private addFills(leg: Leg, orders: Order[], side: Side, stage: "entry" | "exit"): void {
    for (const o of orders) {
      if (o.filledQuantity === 0) continue;
      const value = o.averagePrice * o.filledQuantity;
      if (stage === "entry") {
        leg.filledIn += o.filledQuantity;
        leg.valueIn += value;
      } else {
        leg.filledOut += o.filledQuantity;
        leg.valueOut += value;
      }
      leg.charges += estimateCharges({ kind: "option" }, side, "MIS", o.averagePrice, o.filledQuantity).total;
    }
  }

  private record(ctx: StrategyContext): void {
    const legs = this.state.legs.filter((l) => l.filledIn > 0);
    const gross = legs.reduce((sum, l) => sum + (l.side === "BUY" ? l.valueOut - l.valueIn : l.valueIn - l.valueOut), 0);
    const charges = legs.reduce((sum, l) => sum + l.charges, 0);
    if (legs.length) {
      ctx.recordTrade({
        tradeDate: this.state.date,
        openedAt: new Date(this.state.openedAt!),
        closedAt: ctx.now(),
        exitReason: this.state.exitReason!,
        grossPnl: round2(gross),
        charges: round2(charges),
        netPnl: round2(gross - charges),
        details: {
          expiry: this.state.expiry,
          atm: this.state.atm,
          spot: this.state.spot,
          credit: this.state.credit,
          legs: legs.map((l) => ({ symbol: l.symbol, side: l.side, quantity: l.filledIn, entry: round2(entryPrice(l)), exit: round2(l.valueOut / (l.filledOut || 1)) })),
        },
      });
    }
    ctx.log.info("exited", { reason: this.state.exitReason, grossPnl: round2(gross), charges: round2(charges), netPnl: round2(gross - charges) });
    if (legs.length) ctx.notify(`exited (${this.state.exitReason}): net ₹${round2(gross - charges)} (gross ₹${round2(gross)}, charges ₹${round2(charges)})`);
    this.save(ctx, { ...this.state, phase: "done" });
  }

  /** Combined P&L of all legs at current prices (closed parts at their fill prices), before charges. */
  private mtm(ctx: StrategyContext): number {
    return this.state.legs.reduce((sum, l) => {
      if (l.filledIn === 0) return sum;
      const markValue = (ctx.ltp(l.key) ?? entryPrice(l)) * openQty(l);
      return sum + (l.side === "BUY" ? l.valueOut + markValue - l.valueIn : l.valueIn - l.valueOut - markValue);
    }, 0);
  }

  /** True once every key has a live bid or ask, polling until quoteWaitMs passes. */
  private async waitForQuotes(ctx: StrategyContext, keys: string[]): Promise<boolean> {
    const deadline = Date.now() + this.cfg.quoteWaitMs;
    while (!keys.every((k) => hasQuote(ctx, k))) {
      if (Date.now() >= deadline) return false;
      await Bun.sleep(Math.min(100, this.cfg.quoteWaitMs));
    }
    return true;
  }

  private finishDay(ctx: StrategyContext, note: string): void {
    ctx.log.info("no trade today", { reason: note });
    this.save(ctx, { ...this.state, phase: "done", note });
  }

  private save(ctx: StrategyContext, state: State): void {
    this.state = state;
    ctx.saveState(state);
  }
}

function hasQuote(ctx: StrategyContext, key: string): boolean {
  const tick = ctx.lastTick(key);
  return !!tick && ((tick.bestBid ?? 0) > 0 || (tick.bestAsk ?? 0) > 0);
}

function describe(o: Order): string {
  return `${o.status}${o.statusMessage ? ` (${o.statusMessage})` : ""}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
