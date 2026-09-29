// Order checks every broker applies before sending, so mistakes are caught before the exchange.
import type { Instrument, InstrumentLookup, OrderRequest } from "../core/types";

/** Whether `price` is a whole number of ticks, allowing for floating-point noise (e.g. 20.15 / 0.05). */
export function isOnTick(price: number, tickSize: number): boolean {
  const ticks = price / tickSize;
  return Math.abs(ticks - Math.round(ticks)) < 1e-6;
}

/** Rounds to the nearest tick, e.g. 150.03 → 150.05 for a 0.05 tick. */
export function roundToTick(price: number, tickSize: number): number {
  return Number((Math.round(price / tickSize) * tickSize).toFixed(2));
}

/** Returns the order's instrument, or throws if the order can't be valid for it. */
export function checkOrder(req: OrderRequest, instruments: InstrumentLookup): Instrument {
  const instrument = instruments.get(req.instrumentKey);
  if (!instrument) throw new Error(`Unknown instrument ${req.instrumentKey}; is the instrument master up to date?`);
  if (!Number.isInteger(req.quantity) || req.quantity <= 0) {
    throw new Error(`${instrument.symbol}: quantity must be a positive whole number (got ${req.quantity})`);
  }
  if (req.quantity % instrument.lotSize !== 0) {
    throw new Error(`${instrument.symbol}: quantity ${req.quantity} is not a multiple of the lot size ${instrument.lotSize}`);
  }
  const needsPrice = req.type === "LIMIT" || req.type === "SL";
  const needsTrigger = req.type === "SL" || req.type === "SL-M";
  if (needsPrice && !(req.price !== undefined && req.price > 0)) throw new Error(`${instrument.symbol}: ${req.type} orders need a price`);
  if (needsTrigger && !(req.triggerPrice !== undefined && req.triggerPrice > 0)) {
    throw new Error(`${instrument.symbol}: ${req.type} orders need a triggerPrice`);
  }
  for (const [name, value] of [["price", req.price], ["triggerPrice", req.triggerPrice]] as const) {
    if (value !== undefined && value !== 0 && !isOnTick(value, instrument.tickSize)) {
      throw new Error(`${instrument.symbol}: ${name} ${value} is not a multiple of the tick size ${instrument.tickSize}`);
    }
  }
  if (req.tag && req.tag.length > 20) throw new Error(`tag can be at most 20 characters (got "${req.tag}")`);
  return instrument;
}
