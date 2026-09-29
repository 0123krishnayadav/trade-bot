import type { Logger } from "../../utils/logger";
import type { FetchFn } from "./auth";
import { UPSTOX_HOSTS, type UpstoxHost } from "./constants";
import { UpstoxAuthError, UpstoxError, type UpstoxApiError } from "./errors";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/** Upstox's response envelope: {"status":"success","data":...}. Multi-order calls can be "partial_success". */
export interface UpstoxEnvelope<T> {
  status: "success" | "partial_success" | "error";
  data: T;
  errors?: UpstoxApiError[];
  metadata?: { latency?: number };
}

export interface UpstoxHttpOptions {
  /** Current access token, read on every request so a new login takes effect immediately. */
  getAccessToken: () => string | undefined;
  fetchFn?: FetchFn;
  logger?: Logger;
  /** Upstox allows 50 requests/second per API; stay well under by default. */
  maxRequestsPerSecond?: number;
  /** Retries for GET requests on network errors, HTTP 429 and 5xx. */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface RequestOptions {
  host?: UpstoxHost;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

/**
 * The one place that talks HTTP to Upstox: adds the token, unwraps the response envelope, turns
 * errors into UpstoxError, rate-limits, and retries safe requests.
 *
 * Only GET requests are retried. Retrying a POST/PUT/DELETE could place or cancel an order twice
 * if the first attempt actually reached Upstox before the connection failed.
 */
export class UpstoxHttp {
  private readonly fetchFn: FetchFn;
  private readonly maxPerSecond: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly recent: number[] = []; // start times of requests in the last second

  constructor(private readonly opts: UpstoxHttpOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.maxPerSecond = opts.maxRequestsPerSecond ?? 20;
    this.maxRetries = opts.maxRetries ?? 2;
    this.sleep = opts.sleep ?? Bun.sleep;
    this.now = opts.now ?? Date.now;
  }

  /** Returns the full envelope; use `call` when only `data` matters. */
  async request<T>(method: HttpMethod, path: string, opts: RequestOptions = {}): Promise<UpstoxEnvelope<T>> {
    const token = this.opts.getAccessToken();
    if (!token) throw new UpstoxAuthError("Not logged in to Upstox. Run `bun run login`.");

    const url = new URL(path, UPSTOX_HOSTS[opts.host ?? "api"]);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    };

    const retries = method === "GET" ? this.maxRetries : 0;
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      const started = this.now();
      let res: Response;
      try {
        res = await this.fetchFn(url.toString(), init);
      } catch (err) {
        if (attempt < retries) {
          await this.backoff(attempt, method, url, String(err));
          continue;
        }
        throw new UpstoxError(`Network error calling Upstox ${method} ${url.pathname}: ${err}`, 0);
      }

      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await this.backoff(attempt, method, url, `HTTP ${res.status}`);
        continue;
      }

      const body = (await res.json().catch(() => undefined)) as UpstoxEnvelope<T> | undefined;
      this.opts.logger?.debug("upstox request", { method, path: url.pathname, status: res.status, ms: this.now() - started });
      if (!res.ok || !body || body.status === "error") throw UpstoxError.fromResponse(res.status, body);
      return body;
    }
  }

  async call<T>(method: HttpMethod, path: string, opts?: RequestOptions): Promise<T> {
    return (await this.request<T>(method, path, opts)).data;
  }

  private async throttle(): Promise<void> {
    for (;;) {
      const now = this.now();
      while (this.recent.length && now - this.recent[0]! >= 1000) this.recent.shift();
      if (this.recent.length < this.maxPerSecond) {
        this.recent.push(now);
        return;
      }
      await this.sleep(1000 - (now - this.recent[0]!));
    }
  }

  private async backoff(attempt: number, method: HttpMethod, url: URL, reason: string): Promise<void> {
    const ms = 500 * 2 ** attempt;
    this.opts.logger?.warn("upstox request failed, retrying", { method, path: url.pathname, reason, retryInMs: ms });
    await this.sleep(ms);
  }
}
