import type { Notifier } from "../alerts/notifier";
import type { MarketCalendar } from "../calendar/market-calendar";
import type { Child } from "../process/child";
import type { Logger } from "../utils/logger";
import { formatIst, istDate } from "../utils/time";
import { phaseAt, planDay, type Phase } from "./plan";

/** Restarts allowed after the bot exits unexpectedly during a session. */
export const MAX_RESTARTS_PER_DAY = 3;

export interface SchedulerDeps {
  calendar: MarketCalendar;
  /** Downloads the holiday list if stale; only called when logged in. */
  refreshCalendar(): Promise<void>;
  /** Whether the broker session (today's login) is valid. */
  loggedIn(): boolean;
  startBot(): Child;
  /** Daily housekeeping, e.g. deleting old log files. */
  onNewDay?(date: string): void;
  notifier: Notifier;
  logger: Logger;
  now?: () => Date;
}

/**
 * Runs the bot on trading days only: alerts if not logged in before the open, starts the bot
 * before the open, restarts it (a few times) if it crashes, and stops it after the close. Call
 * tick() every 30 seconds; it decides what should be happening right now.
 */
export class Scheduler {
  private day = "";
  private bot?: Child;
  private stopRequested = false;
  private startsToday = 0;
  private loginAlerted = false;
  private closedNoticeSent = false;
  private calendarChecked = false;
  private gaveUp = false;
  private shuttingDown = false;
  private readonly now: () => Date;

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  get botRunning(): boolean {
    return this.bot !== undefined;
  }

  async tick(): Promise<Phase> {
    const now = this.now();
    const today = istDate(now);
    if (today !== this.day) this.newDay(today);

    if (!this.calendarChecked && this.deps.loggedIn()) {
      this.calendarChecked = true;
      await this.deps.refreshCalendar().catch((err) => this.deps.logger.warn("calendar refresh failed", { error: String(err) }));
    }

    const plan = planDay(today, this.deps.calendar);
    const phase = phaseAt(plan, now);
    switch (phase) {
      case "closed":
        if (!this.closedNoticeSent) {
          this.closedNoticeSent = true;
          this.deps.logger.info("market closed today", { date: today, reason: plan.holiday?.description ?? "weekend" });
          if (plan.holiday) this.deps.notifier.notify(`📅 Market closed today (${plan.holiday.description}); the bot stays off.`);
        }
        this.stopBot("market closed");
        break;
      case "login-check":
        this.checkLogin(plan.startAt!);
        break;
      case "trading":
        if (!this.bot && !this.stopRequested && !this.gaveUp && this.checkLogin(plan.startAt!)) this.startBot();
        break;
      case "after":
        this.stopBot("session over");
        break;
      case "waiting":
        break;
    }
    return phase;
  }

  /** On Ctrl+C / SIGTERM: no more starts or restarts; the caller signals and waits for the bot. */
  shutdown(): Promise<number | undefined> {
    this.shuttingDown = true;
    return this.bot ? this.bot.exited : Promise.resolve(undefined);
  }

  /** Passes a signal on to the running bot (for a SIGTERM the bot wouldn't otherwise get). */
  forwardSignal(signal: "SIGINT" | "SIGTERM"): void {
    this.bot?.kill(signal);
  }

  private newDay(date: string): void {
    this.day = date;
    this.stopRequested = false;
    this.startsToday = 0;
    this.loginAlerted = false;
    this.closedNoticeSent = false;
    this.calendarChecked = false;
    this.gaveUp = false;
    this.deps.onNewDay?.(date);
  }

  /** True when logged in; otherwise alerts (once a day) and returns false. */
  private checkLogin(startAt: Date): boolean {
    if (this.deps.loggedIn()) return true;
    if (!this.loginAlerted) {
      this.loginAlerted = true;
      this.deps.logger.warn("not logged in to the broker; the bot can't start until you run `bun run login`");
      this.deps.notifier.notify(`🔑 Log in to the broker for today: run \`bun run login\`. The bot starts at ${formatIst(startAt).slice(11, 16)} IST once logged in.`);
    }
    return false;
  }

  private startBot(): void {
    if (this.shuttingDown) return;
    if (this.startsToday > MAX_RESTARTS_PER_DAY) {
      this.gaveUp = true;
      this.deps.logger.error("the bot keeps exiting; not restarting it again today");
      this.deps.notifier.notify(`⚠️ The bot exited ${this.startsToday} times today; not restarting it again. Check the logs.`);
      return;
    }
    this.startsToday++;
    const bot = this.deps.startBot();
    this.bot = bot;
    this.deps.logger.info("bot started", { pid: bot.pid, startsToday: this.startsToday });
    void bot.exited.then((code) => {
      if (this.bot === bot) this.bot = undefined;
      if (this.stopRequested || this.shuttingDown) {
        this.deps.logger.info("bot stopped", { code });
        return;
      }
      this.deps.logger.error("bot exited unexpectedly", { code });
      this.deps.notifier.notify(`⚠️ Bot exited unexpectedly (code ${code}); restarting it shortly.`);
    });
  }

  private stopBot(reason: string): void {
    if (this.stopRequested) return;
    this.stopRequested = true;
    if (!this.bot) return;
    this.deps.logger.info("stopping the bot", { reason });
    this.bot.kill("SIGINT"); // the bot squares off and exits
  }
}
