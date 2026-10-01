import { FINAL_ORDER_STATUSES, type Broker, type InstrumentLookup, type Order, type RunMode, type Tick } from "../core/types";
import type { TradingStore } from "../store/trading-store";
import type { Notifier } from "../alerts/notifier";
import type { Logger } from "../utils/logger";
import { istDate } from "../utils/time";
import type { MarketEngine } from "./market-engine";
import type { Strategy, StrategyContext } from "./strategy";

export interface StrategyEngineOptions {
  market: MarketEngine;
  broker: Broker;
  instruments: InstrumentLookup;
  store: TradingStore;
  mode: RunMode;
  logger: Logger;
  /** Alerts for entries, exits, the kill switch and errors; none when omitted. */
  notifier?: Notifier;
  now?: () => Date;
  clockIntervalMs?: number;
  /** Longest a strategy's stop() may take on shutdown. */
  stopTimeoutMs?: number;
}

/**
 * Runs strategies. Each strategy's events (ticks, candles, order updates, clock) are handled one
 * at a time in arrival order, so a strategy never sees two events at once. If it falls behind,
 * only the newest tick per instrument and the newest clock event are kept; candles and order
 * updates are never dropped. A strategy that throws is logged and keeps running.
 */
export class StrategyEngine {
  private readonly runners: StrategyRunner[] = [];
  /** orderId -> strategy that placed it */
  private readonly orderOwners = new Map<string, StrategyRunner>();
  /** Updates for orders not yet known to belong to a strategy (a fill can beat placeOrder's result). */
  private readonly unrouted = new Map<string, Order>();
  private clock?: ReturnType<typeof setInterval>;
  /** IST date the kill switch was last carried out, so it runs once per day. */
  private killedOn?: string;
  private killCheckFailed = false;
  readonly now: () => Date;

  constructor(readonly opts: StrategyEngineOptions) {
    this.now = opts.now ?? (() => new Date());
    opts.broker.onOrderUpdate((order) => this.routeOrder(order));
  }

  add(strategy: Strategy): void {
    if (strategy.id.length > 20) throw new Error(`Strategy id "${strategy.id}" is longer than 20 characters (it's used as the order tag)`);
    if (this.runners.some((r) => r.strategy.id === strategy.id)) throw new Error(`Duplicate strategy id "${strategy.id}"`);
    this.runners.push(new StrategyRunner(strategy, this));
  }

  async start(): Promise<void> {
    await this.opts.broker.start();
    for (const runner of this.runners) await runner.start();
    this.checkKillSwitch(this.now()); // pressed earlier today, before a restart
    this.clock ??= setInterval(() => this.tick(this.now()), this.opts.clockIntervalMs ?? 1000);
  }

  /** Sends a clock event to every strategy. Runs every second after start(); exposed for tests. */
  tick(now: Date): void {
    this.checkKillSwitch(now);
    for (const runner of this.runners) runner.clock(now);
  }

  /**
   * The kill switch check, once per clock tick: a primary-key lookup in the local database (the
   * dashboard's button writes the row). When today's row appears, every strategy squares off, once.
   */
  private checkKillSwitch(now: Date): void {
    const today = istDate(now);
    if (this.killedOn === today) return;
    let pressed: { activatedAt: Date; source: string } | undefined;
    try {
      pressed = this.opts.store.killSwitch(today);
      this.killCheckFailed = false;
    } catch (err) {
      if (!this.killCheckFailed) this.opts.logger.error("could not check the kill switch", { error: String(err) });
      this.killCheckFailed = true;
      return;
    }
    if (!pressed) return;
    this.killedOn = today;
    this.opts.logger.warn("KILL SWITCH is on for today", { activatedAt: pressed.activatedAt.toISOString(), source: pressed.source });
    this.opts.notifier?.notify(`🛑 Kill switch on (${pressed.source}): squaring off, no new trades today`);
    void this.killSwitch().then((results) => {
      const failed = results.filter((r) => !r.ok);
      if (failed.length) {
        this.opts.logger.error("kill switch: some strategies did not square off; check the broker", { failed });
        this.opts.notifier?.notify(`⚠️ Kill switch: ${failed.map((f) => f.strategyId).join(", ")} did not square off. Check the broker!`);
      } else this.opts.logger.warn("kill switch: every strategy squared off; no new trades today");
    });
  }

  /** Lets each strategy finish its queued events and run stop() (e.g. square off), then detaches it. */
  async stop(): Promise<void> {
    clearInterval(this.clock);
    this.clock = undefined;
    for (const runner of this.runners) await runner.stop();
  }

  /**
   * Kill switch: every strategy squares off and stops trading for the day. Resolves once each one
   * has made its attempt; an exit that didn't fully fill is retried by the strategy as usual.
   */
  async killSwitch(): Promise<KillSwitchResult[]> {
    this.opts.logger.warn("KILL SWITCH: squaring off every strategy");
    return Promise.all(this.runners.map((r) => r.squareOff()));
  }

  /** Records that `runner` placed these orders and delivers any updates that arrived first. */
  claimOrders(runner: StrategyRunner, orderIds: string[]): void {
    for (const id of orderIds) {
      this.orderOwners.set(id, runner);
      const early = this.unrouted.get(id);
      if (early) {
        this.unrouted.delete(id);
        this.routeOrder(early);
      }
    }
  }

  private routeOrder(order: Order): void {
    const owner = this.orderOwners.get(order.id) ?? this.runners.find((r) => r.strategy.id === order.tag);
    this.opts.store.saveOrder(this.opts.broker.name, order, owner?.strategy.id);
    if (!owner) {
      this.unrouted.set(order.id, order);
      if (this.unrouted.size > 500) this.unrouted.delete(this.unrouted.keys().next().value!);
      return;
    }
    this.orderOwners.set(order.id, owner);
    owner.orderUpdated(order);
  }
}

export interface KillSwitchResult {
  strategyId: string;
  ok: boolean;
  error?: string;
}

/** One strategy's context, event queue and bookkeeping. */
class StrategyRunner {
  readonly ctx: StrategyContext;
  private readonly log: Logger;
  private queue: Promise<void> = Promise.resolve();
  private readonly pendingTicks = new Map<string, Tick>();
  private clockPending?: Date;
  private readonly detach: (() => void)[] = [];
  private readonly tickListeners = new Set<string>();
  private readonly orders = new Map<string, Order>();
  private readonly waiters = new Set<() => void>();
  private stopped = false;

  constructor(
    readonly strategy: Strategy,
    private readonly engine: StrategyEngine,
  ) {
    const { market, broker, instruments, store, mode } = engine.opts;
    const id = strategy.id;
    this.log = engine.opts.logger.child(id);
    const own = (orderIds: string[]) => engine.claimOrders(this, orderIds);

    this.ctx = {
      strategyId: id,
      mode,
      instruments,
      log: this.log,
      now: () => engine.now(),
      notify: (text) => engine.opts.notifier?.notify(`${id}: ${text}`),
      subscribe: (keys, subMode) => {
        market.subscribe(id, keys, subMode);
        for (const key of keys) {
          if (this.tickListeners.has(key)) continue;
          this.tickListeners.add(key);
          this.detach.push(market.onTick(key, (tick) => this.queueTick(tick)));
        }
      },
      unsubscribe: (keys) => market.unsubscribe(id, keys),
      ltp: (key) => market.ltp(key),
      lastTick: (key) => market.lastTick(key),
      candles: (key, tf, count) => market.candles(key, tf, count),
      watchCandles: (key, tf) => {
        this.detach.push(market.onCandleClose(key, tf, (candle) => this.enqueue(() => this.strategy.onCandle?.(candle, this.ctx))));
      },
      placeOrder: async (req) => {
        const result = await broker.placeOrder({ ...req, tag: id });
        own(result.orderIds);
        return result;
      },
      modifyOrder: (orderId, changes) => broker.modifyOrder(orderId, changes),
      cancelOrder: (orderId) => broker.cancelOrder(orderId),
      closePosition: async (key, opts) => {
        const result = await broker.closePosition(key, { ...opts, tag: id });
        own(result.orderIds);
        return result;
      },
      waitForOrders: (orderIds, timeoutMs) => this.waitForOrders(orderIds, timeoutMs),
      positions: () => broker.getPositions(),
      funds: () => broker.getFunds(),
      recordTrade: (trade) => store.saveTrade({ ...trade, strategyId: id }),
      loadState: () => store.loadState(id),
      saveState: (state) => store.saveState(id, state),
    };
  }

  async start(): Promise<void> {
    this.log.info("starting");
    await this.strategy.start(this.ctx);
  }

  clock(now: Date): void {
    if (this.stopped || !this.strategy.onClock) return;
    const alreadyQueued = this.clockPending !== undefined;
    this.clockPending = now;
    if (alreadyQueued) return;
    this.enqueue(() => {
      const latest = this.clockPending!;
      this.clockPending = undefined;
      return this.strategy.onClock?.(latest, this.ctx);
    });
  }

  orderUpdated(order: Order): void {
    this.orders.set(order.id, order);
    for (const wake of [...this.waiters]) wake();
    this.enqueue(() => this.strategy.onOrderUpdate?.(order, this.ctx));
  }

  async stop(): Promise<void> {
    await this.queue;
    this.stopped = true;
    const timeoutMs = this.engine.opts.stopTimeoutMs ?? 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve(this.strategy.stop?.(this.ctx)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`stop() took longer than ${timeoutMs / 1000}s`)), timeoutMs);
        }),
      ]);
    } catch (err) {
      this.log.error("stop failed; check open positions at the broker", { error: String(err) });
    } finally {
      clearTimeout(timer);
    }
    for (const off of this.detach) off();
    this.engine.opts.market.unsubscribe(this.strategy.id);
    this.log.info("stopped");
  }

  /** Queued behind any event in progress (e.g. an entry), so it never runs alongside one. */
  squareOff(): Promise<KillSwitchResult> {
    const strategyId = this.strategy.id;
    if (this.stopped) return Promise.resolve({ strategyId, ok: false, error: "already stopped" });
    if (!this.strategy.squareOff) {
      this.log.error("kill switch: this strategy has no squareOff(); it keeps running");
      return Promise.resolve({ strategyId, ok: false, error: "kill switch not supported by this strategy" });
    }
    return new Promise((resolve) => {
      this.enqueue(async () => {
        try {
          await this.strategy.squareOff!(this.ctx);
          resolve({ strategyId, ok: true });
        } catch (err) {
          resolve({ strategyId, ok: false, error: err instanceof Error ? err.message : String(err) });
          throw err; // logged by enqueue
        }
      });
    });
  }

  private queueTick(tick: Tick): void {
    if (this.stopped || !this.strategy.onTick) return;
    const alreadyQueued = this.pendingTicks.has(tick.instrumentKey);
    this.pendingTicks.set(tick.instrumentKey, tick);
    if (alreadyQueued) return; // the queued handler will pick up this newer tick
    this.enqueue(() => {
      const latest = this.pendingTicks.get(tick.instrumentKey)!;
      this.pendingTicks.delete(tick.instrumentKey);
      return this.strategy.onTick?.(latest, this.ctx);
    });
  }

  private enqueue(handler: () => Promise<void> | void): void {
    this.queue = this.queue.then(async () => {
      try {
        await handler();
      } catch (err) {
        this.log.error("strategy handler failed", { error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
        this.engine.opts.notifier?.notify(`⚠️ ${this.strategy.id} error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  /** Resolves on order updates, independently of the event queue (so a handler may await it). */
  private waitForOrders(orderIds: string[], timeoutMs: number): Promise<Order[]> {
    const latest = () => orderIds.map((id) => this.orders.get(id)).filter((o): o is Order => o !== undefined);
    const done = () => orderIds.every((id) => {
      const o = this.orders.get(id);
      return o !== undefined && FINAL_ORDER_STATUSES.includes(o.status);
    });
    if (done()) return Promise.resolve(latest());
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(latest());
      };
      const check = () => {
        if (done()) finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.waiters.add(check);
    });
  }
}

