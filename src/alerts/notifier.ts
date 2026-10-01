import type { Logger } from "../utils/logger";

/** Sends short messages to the user's phone (or nowhere). Never throws, never blocks trading. */
export interface Notifier {
  notify(text: string): void;
  /** Waits for queued messages to go out (e.g. before the process exits), at most `timeoutMs`. */
  flush(timeoutMs?: number): Promise<void>;
}

/** Used when no alert channel is configured: messages only go to the log. */
export class LogNotifier implements Notifier {
  constructor(private readonly logger?: Logger) {}
  notify(text: string): void {
    this.logger?.info("alert", { text });
  }
  async flush(): Promise<void> {}
}

export interface TelegramOptions {
  botToken: string;
  chatId: string;
  /** Put before every message, e.g. "[paper]". */
  prefix?: string;
  logger?: Logger;
  fetchFn?: typeof fetch;
  /** Gap between messages (Telegram allows about one per second per chat). */
  minIntervalMs?: number;
  /** The same text isn't sent again within this window (e.g. an error repeating every second). */
  dedupeMs?: number;
  now?: () => number;
}

/** Telegram bot messages: create a bot with @BotFather, then message it once to get your chat id. */
export class TelegramNotifier implements Notifier {
  private readonly queue: string[] = [];
  private readonly lastSent = new Map<string, number>();
  private sending?: Promise<void>;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: TelegramOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  notify(text: string): void {
    const now = this.now();
    const last = this.lastSent.get(text);
    if (last !== undefined && now - last < (this.opts.dedupeMs ?? 10 * 60_000)) return;
    this.lastSent.set(text, now);
    if (this.lastSent.size > 500) this.lastSent.delete(this.lastSent.keys().next().value!);
    this.queue.push(this.opts.prefix ? `${this.opts.prefix} ${text}` : text);
    this.sending ??= this.drain().finally(() => (this.sending = undefined));
  }

  async flush(timeoutMs = 5_000): Promise<void> {
    if (!this.sending) return;
    await Promise.race([this.sending, Bun.sleep(timeoutMs)]);
  }

  private async drain(): Promise<void> {
    for (let text = this.queue.shift(); text !== undefined; text = this.queue.shift()) {
      try {
        const res = await this.fetchFn(`https://api.telegram.org/bot${this.opts.botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: this.opts.chatId, text, disable_web_page_preview: true }),
          signal: AbortSignal.timeout(10_000),
        });
        // The URL holds the bot token, so only the status is logged.
        if (!res.ok) this.opts.logger?.warn("telegram alert not sent", { status: res.status });
      } catch (err) {
        this.opts.logger?.warn("telegram alert not sent", { error: err instanceof Error ? err.name : "error" });
      }
      if (this.queue.length) await Bun.sleep(this.opts.minIntervalMs ?? 1_000);
    }
  }
}

/** Telegram when configured, otherwise the log. */
export function createNotifier(config: { telegram?: { botToken: string; chatId: string } }, opts: { prefix?: string; logger?: Logger }): Notifier {
  if (!config.telegram) return new LogNotifier(opts.logger);
  return new TelegramNotifier({ ...config.telegram, ...opts });
}
