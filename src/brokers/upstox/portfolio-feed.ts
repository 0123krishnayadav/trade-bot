import { UPSTOX_ENDPOINTS } from "./constants";
import type { UpstoxHttp } from "./http";
import { authorizedFeedUrl, ReconnectingSocket, type SocketOptions } from "./reconnecting-socket";
import type { UpstoxOrder, UpstoxProduct } from "./types";

/** Position update message. Unlike the positions API, it has no P&L, last price or symbol. */
export interface UpstoxPositionMessage {
  instrument_token: string;
  product: UpstoxProduct;
  quantity: number;
  average_price: number;
  buy_price: number;
  sell_price: number;
  buy_value: number;
  sell_value: number;
  day_buy_quantity: number;
  day_sell_quantity: number;
  overnight_buy_quantity: number;
  overnight_sell_quantity: number;
  multiplier: number;
}

export type PortfolioUpdateType = "order" | "position" | "holding" | "gtt_order";

/**
 * Upstox's portfolio stream: JSON messages for order status changes and position changes in the
 * account, pushed as they happen. Holding and GTT updates exist too but aren't used yet.
 */
export class UpstoxPortfolioFeed {
  private readonly socket: ReconnectingSocket;
  private readonly orderHandlers: ((order: UpstoxOrder) => void)[] = [];
  private readonly positionHandlers: ((position: UpstoxPositionMessage) => void)[] = [];

  constructor(
    http: UpstoxHttp,
    private readonly opts: SocketOptions & { updateTypes?: PortfolioUpdateType[] } = {},
  ) {
    const updateTypes = (opts.updateTypes ?? ["order", "position"]).join(",");
    this.socket = new ReconnectingSocket({
      ...opts,
      name: "portfolio feed",
      getUrl: () => authorizedFeedUrl(http, UPSTOX_ENDPOINTS.portfolioFeedAuthorize, { update_types: updateTypes }),
      onMessage: (data) => this.handleMessage(data),
    });
  }

  onOrder(handler: (order: UpstoxOrder) => void): void {
    this.orderHandlers.push(handler);
  }

  onPosition(handler: (position: UpstoxPositionMessage) => void): void {
    this.positionHandlers.push(handler);
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

  close(): void {
    this.socket.close();
  }

  private handleMessage(data: unknown): void {
    const text = typeof data === "string" ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : undefined;
    if (text === undefined) return;
    let message: { update_type?: string };
    try {
      message = JSON.parse(text);
    } catch {
      this.opts.logger?.warn("portfolio feed: message is not JSON", { length: text.length });
      return;
    }
    const handlers =
      message.update_type === "order" ? this.orderHandlers : message.update_type === "position" ? this.positionHandlers : undefined;
    for (const handler of (handlers ?? []) as ((m: unknown) => void)[]) {
      try {
        handler(message);
      } catch (err) {
        this.opts.logger?.error("portfolio feed handler failed", { updateType: message.update_type, error: String(err) });
      }
    }
  }
}
