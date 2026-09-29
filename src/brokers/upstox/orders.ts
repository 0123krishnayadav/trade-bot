import { UPSTOX_ENDPOINTS } from "./constants";
import type { UpstoxHttp } from "./http";
import type {
  ExitPositionsFilter,
  ModifyGttOrderRequest,
  ModifyOrderRequest,
  PlaceGttOrderRequest,
  PlaceOrderRequest,
  PlaceOrderResult,
  UpstoxGttOrder,
  UpstoxOrder,
  UpstoxTrade,
} from "./types";

/**
 * Regular and GTT orders. Order-changing calls are never retried automatically (see UpstoxHttp):
 * after a network error, check the order book before trying again.
 */
export class UpstoxOrdersApi {
  constructor(private readonly http: UpstoxHttp) {}

  // ---------- Regular orders ----------

  async placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult> {
    validateOrder(req);
    const res = await this.http.request<{ order_ids: string[] }>("POST", UPSTOX_ENDPOINTS.placeOrder, {
      host: "hft",
      body: { disclosed_quantity: 0, is_amo: false, slice: false, ...req },
    });
    return res.status === "partial_success"
      ? { orderIds: res.data.order_ids, errors: res.errors ?? [] }
      : { orderIds: res.data.order_ids };
  }

  async exitPositions(filter: ExitPositionsFilter = {}): Promise<PlaceOrderResult> {
    const res = await this.http.request<{ order_ids: string[] }>("POST", UPSTOX_ENDPOINTS.exitPositions, {
      query: { segment: filter.segment, tag: filter.tag },
    });
    const orderIds = res.data?.order_ids ?? [];
    return res.status === "partial_success" ? { orderIds, errors: res.errors ?? [] } : { orderIds };
  }

  async modifyOrder(req: ModifyOrderRequest): Promise<string> {
    const data = await this.http.call<{ order_id: string }>("PUT", UPSTOX_ENDPOINTS.modifyOrder, { host: "hft", body: req });
    return data.order_id;
  }

  async cancelOrder(orderId: string): Promise<string> {
    const data = await this.http.call<{ order_id: string }>("DELETE", UPSTOX_ENDPOINTS.cancelOrder, {
      host: "hft",
      query: { order_id: orderId },
    });
    return data.order_id;
  }

  /** Today's order book, one entry per order in its latest state. */
  fetchOrders(): Promise<UpstoxOrder[]> {
    return this.http.call("GET", UPSTOX_ENDPOINTS.orderBook);
  }

  fetchOrderDetails(orderId: string): Promise<UpstoxOrder> {
    return this.http.call("GET", UPSTOX_ENDPOINTS.orderDetails, { query: { order_id: orderId } });
  }

  /** Today's executed trades (fills). */
  fetchTrades(): Promise<UpstoxTrade[]> {
    return this.http.call("GET", UPSTOX_ENDPOINTS.tradesForDay);
  }

  // ---------- GTT orders ----------

  async placeGttOrder(req: PlaceGttOrderRequest): Promise<string[]> {
    validateGtt(req.type, req.quantity, req.rules);
    const data = await this.http.call<{ gtt_order_ids: string[] }>("POST", UPSTOX_ENDPOINTS.gttPlace, { body: req });
    return data.gtt_order_ids;
  }

  async modifyGttOrder(req: ModifyGttOrderRequest): Promise<string[]> {
    validateGtt(req.type, req.quantity, req.rules);
    const data = await this.http.call<{ gtt_order_ids: string[] }>("PUT", UPSTOX_ENDPOINTS.gttModify, { body: req });
    return data.gtt_order_ids;
  }

  async cancelGttOrder(gttOrderId: string): Promise<string[]> {
    const data = await this.http.call<{ gtt_order_ids: string[] }>("DELETE", UPSTOX_ENDPOINTS.gttCancel, {
      body: { gtt_order_id: gttOrderId },
    });
    return data.gtt_order_ids;
  }

  /** All GTT orders, or just one when an id is given. */
  fetchGttOrders(gttOrderId?: string): Promise<UpstoxGttOrder[]> {
    return this.http.call("GET", UPSTOX_ENDPOINTS.gttOrders, { query: { gtt_order_id: gttOrderId } });
  }
}

/** Catches mistakes before they reach the exchange. Upstox validates everything again. */
function validateOrder(req: PlaceOrderRequest): void {
  if (!Number.isInteger(req.quantity) || req.quantity <= 0) throw new Error(`quantity must be a positive whole number (got ${req.quantity})`);
  const needsPrice = req.order_type === "LIMIT" || req.order_type === "SL";
  const needsTrigger = req.order_type === "SL" || req.order_type === "SL-M";
  if (needsPrice && !(req.price > 0)) throw new Error(`${req.order_type} orders need a price`);
  if (!needsPrice && req.price !== 0) throw new Error(`${req.order_type} orders must have price 0`);
  if (needsTrigger && !(req.trigger_price > 0)) throw new Error(`${req.order_type} orders need a trigger_price`);
  if (!needsTrigger && req.trigger_price !== 0) throw new Error(`${req.order_type} orders must have trigger_price 0`);
  if (req.tag && req.tag.length > 20) throw new Error(`tag can be at most 20 characters (got "${req.tag}")`);
}

function validateGtt(type: "SINGLE" | "MULTIPLE", quantity: number, rules: PlaceGttOrderRequest["rules"]): void {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error(`quantity must be a positive whole number (got ${quantity})`);
  const entries = rules.filter((r) => r.strategy === "ENTRY").length;
  if (entries !== 1) throw new Error("GTT orders need exactly one ENTRY rule");
  if (type === "SINGLE" && rules.length !== 1) throw new Error("SINGLE GTT orders take only the ENTRY rule");
  if (type === "MULTIPLE" && rules.length < 2) throw new Error("MULTIPLE GTT orders need a TARGET and/or STOPLOSS rule");
  for (const r of rules) {
    if (!(r.trigger_price > 0)) throw new Error(`${r.strategy} rule needs a trigger_price`);
    if (r.trailing_gap !== undefined && r.strategy !== "STOPLOSS") throw new Error("trailing_gap only applies to the STOPLOSS rule");
  }
}
