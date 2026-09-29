import type { Logger } from "../../utils/logger";
import { UPSTOX_ENDPOINTS } from "./constants";
import { UpstoxAuthError } from "./errors";
import type { UpstoxHttp } from "./http";
import { decodeFeed, type FeedMode, type FeedTick } from "./feed-decoder";
import type { InstrumentKey } from "./types";

/** The parts of the standard WebSocket we use, so tests can pass a fake. */
export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface MarketFeedOptions {
  logger?: Logger;
  createSocket?: (url: string) => WebSocketLike;
  /** First reconnect delay; doubles each failed attempt up to maxReconnectDelayMs. */
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

const OPEN = 1;

/**
 * Live prices over Upstox's market data websocket. Keeps track of subscriptions and, if the
 * connection drops, reconnects with backoff and subscribes to everything again. Stops trying only
 * on an authentication error (the session expired) or when close() is called.
 */
export class UpstoxMarketFeed {
  private socket?: WebSocketLike;
  private connecting?: Promise<void>;
  private readonly subscriptions = new Map<InstrumentKey, FeedMode>();
  private readonly tickHandlers: ((tick: FeedTick) => void)[] = [];
  private readonly statusHandlers: ((status: Record<string, string>) => void)[] = [];
  private readonly connectionHandlers: ((connected: boolean) => void)[] = [];
  private closedByUser = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly http: UpstoxHttp,
    private readonly opts: MarketFeedOptions = {},
  ) {}

  onTick(handler: (tick: FeedTick) => void): void {
    this.tickHandlers.push(handler);
  }

  /** Market open/close per segment, e.g. {"NSE_FO": "NORMAL_OPEN"}. Sent on connect and on changes. */
  onMarketStatus(handler: (status: Record<string, string>) => void): void {
    this.statusHandlers.push(handler);
  }

  onConnectionChange(handler: (connected: boolean) => void): void {
    this.connectionHandlers.push(handler);
  }

  get connected(): boolean {
    return this.socket?.readyState === OPEN;
  }

  /** Resolves once the socket is open. Safe to call again while connecting or connected. */
  connect(): Promise<void> {
    this.closedByUser = false;
    if (this.connected) return Promise.resolve();
    this.connecting ??= this.open().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  subscribe(instrumentKeys: InstrumentKey[], mode: FeedMode = "ltpc"): void {
    for (const key of instrumentKeys) this.subscriptions.set(key, mode);
    this.send("sub", instrumentKeys, mode);
  }

  /** Switch already-subscribed instruments to another mode, e.g. ltpc → full. */
  changeMode(instrumentKeys: InstrumentKey[], mode: FeedMode): void {
    for (const key of instrumentKeys) if (this.subscriptions.has(key)) this.subscriptions.set(key, mode);
    this.send("change_mode", instrumentKeys, mode);
  }

  unsubscribe(instrumentKeys: InstrumentKey[]): void {
    for (const key of instrumentKeys) this.subscriptions.delete(key);
    this.send("unsub", instrumentKeys);
  }

  close(): void {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "closed by client");
  }

  private async open(): Promise<void> {
    // The authorize call returns a one-time wss:// URL, so it's repeated on every (re)connect.
    const data = await this.http.call<{ authorizedRedirectUri?: string; authorized_redirect_uri?: string }>(
      "GET",
      UPSTOX_ENDPOINTS.marketFeedAuthorize,
    );
    const url = data.authorizedRedirectUri ?? data.authorized_redirect_uri;
    if (!url) throw new Error("Upstox didn't return a websocket URL");

    const socket = (this.opts.createSocket ?? ((u) => new WebSocket(u) as unknown as WebSocketLike))(url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    let opened = false;
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => {
        opened = true;
        this.reconnectAttempt = 0;
        this.opts.logger?.info("market feed connected", { subscriptions: this.subscriptions.size });
        this.resubscribe();
        this.connectionHandlers.forEach((h) => h(true));
        resolve();
      };
      socket.onerror = (ev) => {
        this.opts.logger?.warn("market feed socket error", { error: String((ev as { message?: string })?.message ?? ev) });
        reject(new Error("Could not open the Upstox market feed websocket"));
      };
      socket.onclose = (ev) => {
        reject(new Error(`Upstox market feed closed (${ev.code})`));
        // Failing before opening is reported to whoever called connect(); only drops of a live
        // connection trigger a reconnect here.
        if (!opened || socket !== this.socket) return;
        this.opts.logger?.warn("market feed disconnected", { code: ev.code, reason: ev.reason });
        this.connectionHandlers.forEach((h) => h(false));
        if (!this.closedByUser) this.scheduleReconnect();
      };
      socket.onmessage = (ev) => this.handleMessage(ev.data);
    });
  }

  private scheduleReconnect(): void {
    const base = this.opts.reconnectDelayMs ?? 1000;
    const delay = Math.min(base * 2 ** this.reconnectAttempt, this.opts.maxReconnectDelayMs ?? 30_000);
    this.reconnectAttempt++;
    this.opts.logger?.info("market feed reconnecting", { attempt: this.reconnectAttempt, inMs: delay });
    this.reconnectTimer = setTimeout(() => {
      if (this.closedByUser) return;
      this.connect().catch((err) => {
        if (err instanceof UpstoxAuthError) {
          this.opts.logger?.error("market feed stopped: not logged in", { error: err.message });
          return;
        }
        this.opts.logger?.warn("market feed reconnect failed", { error: String(err) });
        if (!this.connected && !this.closedByUser) this.scheduleReconnect();
      });
    }, delay);
  }

  private resubscribe(): void {
    const byMode = new Map<FeedMode, InstrumentKey[]>();
    for (const [key, mode] of this.subscriptions) byMode.set(mode, [...(byMode.get(mode) ?? []), key]);
    for (const [mode, keys] of byMode) this.send("sub", keys, mode);
  }

  private send(method: "sub" | "unsub" | "change_mode", instrumentKeys: InstrumentKey[], mode?: FeedMode): void {
    if (!this.connected || instrumentKeys.length === 0) return; // sent on (re)connect instead
    const message = { guid: crypto.randomUUID(), method, data: { instrumentKeys, ...(mode ? { mode } : {}) } };
    // Upstox only accepts these requests as binary frames.
    this.socket!.send(new TextEncoder().encode(JSON.stringify(message)));
  }

  private handleMessage(data: unknown): void {
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return;
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    let decoded;
    try {
      decoded = decodeFeed(bytes);
    } catch (err) {
      this.opts.logger?.warn("market feed: could not decode message", { error: String(err), bytes: bytes.length });
      return;
    }
    if (decoded.marketStatus) this.statusHandlers.forEach((h) => h(decoded.marketStatus!));
    for (const tick of decoded.ticks) {
      for (const handler of this.tickHandlers) {
        try {
          handler(tick);
        } catch (err) {
          this.opts.logger?.error("market feed tick handler failed", { error: String(err) });
        }
      }
    }
  }
}
