import type { Logger } from "../../utils/logger";
import { UpstoxAuthError } from "./errors";
import type { UpstoxHttp } from "./http";

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

export interface SocketOptions {
  logger?: Logger;
  createSocket?: (url: string) => WebSocketLike;
  /** First reconnect delay; doubles each failed attempt up to maxReconnectDelayMs. */
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

interface ReconnectingSocketOptions extends SocketOptions {
  /** For log messages, e.g. "market feed". */
  name: string;
  /** Returns a fresh wss:// URL; Upstox's are one-time, so this runs on every (re)connect. */
  getUrl: () => Promise<string>;
  /** Runs each time the connection opens, e.g. to resubscribe. */
  onOpen?: () => void;
  onMessage: (data: unknown) => void;
}

const OPEN = 1;

/**
 * A websocket that reconnects with backoff after drops. Stops only on an authentication error
 * (the session expired) or when close() is called. Shared by the market and portfolio feeds.
 */
export class ReconnectingSocket {
  private socket?: WebSocketLike;
  private connecting?: Promise<void>;
  private readonly connectionHandlers: ((connected: boolean) => void)[] = [];
  private closedByUser = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly opts: ReconnectingSocketOptions) {}

  get connected(): boolean {
    return this.socket?.readyState === OPEN;
  }

  onConnectionChange(handler: (connected: boolean) => void): void {
    this.connectionHandlers.push(handler);
  }

  /** Resolves once the socket is open. Safe to call again while connecting or connected. */
  connect(): Promise<void> {
    this.closedByUser = false;
    if (this.connected) return Promise.resolve();
    this.connecting ??= this.open().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  /** Sends if connected; returns false otherwise. */
  send(data: Uint8Array | string): boolean {
    if (!this.connected) return false;
    this.socket!.send(data);
    return true;
  }

  close(): void {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "closed by client");
  }

  private async open(): Promise<void> {
    const { name, logger } = this.opts;
    const url = await this.opts.getUrl();
    const socket = (this.opts.createSocket ?? ((u) => new WebSocket(u) as unknown as WebSocketLike))(url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    let opened = false;
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => {
        opened = true;
        this.reconnectAttempt = 0;
        logger?.info(`${name} connected`);
        this.opts.onOpen?.();
        this.connectionHandlers.forEach((h) => h(true));
        resolve();
      };
      socket.onerror = (ev) => {
        logger?.warn(`${name} socket error`, { error: String((ev as { message?: string })?.message ?? ev) });
        reject(new Error(`Could not open the Upstox ${name} websocket`));
      };
      socket.onclose = (ev) => {
        reject(new Error(`Upstox ${name} closed (${ev.code})`));
        // Failing before opening is reported to whoever called connect(); only drops of a live
        // connection trigger a reconnect here.
        if (!opened || socket !== this.socket) return;
        logger?.warn(`${name} disconnected`, { code: ev.code, reason: ev.reason });
        this.connectionHandlers.forEach((h) => h(false));
        if (!this.closedByUser) this.scheduleReconnect();
      };
      socket.onmessage = (ev) => this.opts.onMessage(ev.data);
    });
  }

  private scheduleReconnect(): void {
    const { name, logger } = this.opts;
    const delay = Math.min((this.opts.reconnectDelayMs ?? 1000) * 2 ** this.reconnectAttempt, this.opts.maxReconnectDelayMs ?? 30_000);
    this.reconnectAttempt++;
    logger?.info(`${name} reconnecting`, { attempt: this.reconnectAttempt, inMs: delay });
    this.reconnectTimer = setTimeout(() => {
      if (this.closedByUser) return;
      this.connect().catch((err) => {
        if (err instanceof UpstoxAuthError) {
          logger?.error(`${name} stopped: not logged in`, { error: err.message });
          return;
        }
        logger?.warn(`${name} reconnect failed`, { error: String(err) });
        if (!this.connected && !this.closedByUser) this.scheduleReconnect();
      });
    }, delay);
  }
}

/** Calls an Upstox feed "authorize" endpoint and returns the one-time wss:// URL it hands out. */
export async function authorizedFeedUrl(http: UpstoxHttp, endpoint: string, query?: Record<string, string>): Promise<string> {
  const data = await http.call<{ authorizedRedirectUri?: string; authorized_redirect_uri?: string }>("GET", endpoint, { query });
  const url = data.authorizedRedirectUri ?? data.authorized_redirect_uri;
  if (!url) throw new Error("Upstox didn't return a websocket URL");
  return url;
}
