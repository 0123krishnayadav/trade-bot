// Estimated trading charges in India: brokerage, STT, exchange fees, SEBI fee, stamp duty, GST.
// Used for paper fills and to estimate net P&L. Rates change with budgets and exchange circulars
// and differ slightly between brokers, so treat results as estimates and check your contract notes.
//
// Rates last checked against Upstox's brokerage calculator (GET /v2/charges/brokerage) on
// 2026-09-30; tests/charges.test.ts pins those results. Re-check after each Union Budget.
import type { Instrument, Product, Side } from "../core/types";

interface Rates {
  /** Percent of turnover (price x quantity). */
  sttSell: number;
  sttBuy: number;
  exchange: number;
  stampBuy: number;
}

// STT on option sells is on the premium; on futures sells on the contract value.
const OPTIONS: Rates = { sttSell: 0.15, sttBuy: 0, exchange: 0.0354, stampBuy: 0.003 };
const FUTURES: Rates = { sttSell: 0.05, sttBuy: 0, exchange: 0.00173, stampBuy: 0.002 };
const EQUITY_INTRADAY: Rates = { sttSell: 0.025, sttBuy: 0, exchange: 0.00297, stampBuy: 0.003 };
const EQUITY_DELIVERY: Rates = { sttSell: 0.1, sttBuy: 0.1, exchange: 0.00297, stampBuy: 0.015 };

const SEBI_PCT = 0.0001; // ₹10 per crore
const GST_PCT = 18; // on brokerage + exchange + SEBI fees
const BROKERAGE_PER_ORDER = 20;
/** Upstox's equity intraday brokerage: this % of turnover, capped at BROKERAGE_PER_ORDER. */
const EQUITY_INTRADAY_BROKERAGE_PCT = 0.06;

export interface ChargeBreakdown {
  brokerage: number;
  stt: number;
  exchange: number;
  sebi: number;
  stamp: number;
  gst: number;
  total: number;
}

/** Charges for one executed order (or one fill), in rupees. */
export function estimateCharges(instrument: Pick<Instrument, "kind">, side: Side, product: Product, price: number, quantity: number): ChargeBreakdown {
  const turnover = price * quantity;
  const rates =
    instrument.kind === "option"
      ? OPTIONS
      : instrument.kind === "future"
        ? FUTURES
        : product === "MIS"
          ? EQUITY_INTRADAY
          : EQUITY_DELIVERY;
  const pct = (p: number) => (turnover * p) / 100;
  // Equity intraday brokerage is a small percentage, capped at the flat per-order fee.
  const brokerage = rates === EQUITY_INTRADAY ? Math.min(BROKERAGE_PER_ORDER, pct(EQUITY_INTRADAY_BROKERAGE_PCT)) : BROKERAGE_PER_ORDER;
  const stt = pct(side === "SELL" ? rates.sttSell : rates.sttBuy);
  const exchange = pct(rates.exchange);
  const sebi = pct(SEBI_PCT);
  const stamp = side === "BUY" ? pct(rates.stampBuy) : 0;
  const gst = ((brokerage + exchange + sebi) * GST_PCT) / 100;
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    brokerage: r(brokerage),
    stt: r(stt),
    exchange: r(exchange),
    sebi: r(sebi),
    stamp: r(stamp),
    gst: r(gst),
    total: r(brokerage + stt + exchange + sebi + stamp + gst),
  };
}
