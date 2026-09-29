import { UPSTOX_ENDPOINTS } from "./constants";
import type { UpstoxHttp } from "./http";
import { decodeFeed, type FeedMode, type FeedTick } from "./feed-decoder";
import { authorizedFeedUrl, ReconnectingSocket, type SocketOptions } from "./reconnecting-socket";
import type { InstrumentKey } from "./types";

export type { WebSocketLike } from "./reconnecting-socket";
export type MarketFeedOptions = SocketOptions;

/**
 * Live prices over Upstox's market data websocket. Keeps track of subscriptions and sends them
 * again whenever the connection (re)opens.
 */
export class UpstoxMarketFeed {
  private readonly socket: ReconnectingSocket;
  private readonly subscriptions = new Map<InstrumentKey, FeedMode>();
  private readonly tickHandlers: ((tick: FeedTick) => void)[] = [];
  private readonly statusHandlers: ((status: Record<string, string>) => void)[] = [];

  constructor(
    http: UpstoxHttp,
    private readonly opts: MarketFeedOptions = {},
  ) {
    this.socket = new ReconnectingSocket({
      ...opts,
      name: "market feed",
      getUrl: () => authorizedFeedUrl(http, UPSTOX_ENDPOINTS.marketFeedAuthorize),
      onOpen: () => this.resubscribe(),
      onMessage: (data) => this.handleMessage(data),
    });
  }

  onTick(handler: (tick: FeedTick) => void): void {
    this.tickHandlers.push(handler);
  }

  /** Market open/close per segment, e.g. {"NSE_FO": "NORMAL_OPEN"}. Sent on connect and on changes. */
  onMarketStatus(handler: (status: Record<string, string>) => void): void {
    this.statusHandlers.push(handler);
  }

  onConnectionChange(handler: (connected: boolean) => void): void {
    this.socket.onConnectionChange(handler);
  }

  get connected(): boolean {
    return this.socket.connected;
  }

  connect(): Promise<void> {
    return this.socket.connect();
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
    this.socket.close();
  }

  private resubscribe(): void {
    this.opts.logger?.info("market feed subscriptions restored", { instruments: this.subscriptions.size });
    const byMode = new Map<FeedMode, InstrumentKey[]>();
    for (const [key, mode] of this.subscriptions) byMode.set(mode, [...(byMode.get(mode) ?? []), key]);
    for (const [mode, keys] of byMode) this.send("sub", keys, mode);
  }

  private send(method: "sub" | "unsub" | "change_mode", instrumentKeys: InstrumentKey[], mode?: FeedMode): void {
    if (instrumentKeys.length === 0) return;
    const message = { guid: crypto.randomUUID(), method, data: { instrumentKeys, ...(mode ? { mode } : {}) } };
    // Upstox only accepts these requests as binary frames. If not connected, they're sent on (re)connect.
    this.socket.send(new TextEncoder().encode(JSON.stringify(message)));
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
