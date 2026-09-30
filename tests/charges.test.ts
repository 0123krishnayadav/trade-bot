import { expect, test } from "bun:test";
import { estimateCharges } from "../src/brokers/charges";
import type { Product, Side } from "../src/core/types";

// Totals from Upstox's own brokerage calculator (GET /v2/charges/brokerage) on 2026-09-30.
// If rates change (e.g. after a Union Budget), re-check against Upstox and update both.
const UPSTOX_TOTALS: [string, "option" | "future" | "equity", Side, Product, number, number, number][] = [
  ["NIFTY ATM option sell", "option", "SELL", "MIS", 150, 65, 42.31],
  ["NIFTY ATM option buy", "option", "BUY", "MIS", 150, 65, 27.97],
  ["NIFTY wing option buy", "option", "BUY", "MIS", 20, 65, 24.18],
  ["NIFTY wing option sell", "option", "SELL", "MIS", 20, 65, 26.09],
  ["NIFTY future buy", "future", "BUY", "MIS", 22750, 65, 85.11],
  ["NIFTY future sell", "future", "SELL", "MIS", 22750, 65, 794.91],
  ["RELIANCE intraday buy", "equity", "BUY", "MIS", 1200, 10, 9.3],
  ["RELIANCE intraday sell", "equity", "SELL", "MIS", 1200, 10, 11.94],
  ["RELIANCE delivery buy", "equity", "BUY", "CNC", 1200, 10, 37.85],
];

for (const [label, kind, side, product, price, quantity, upstox] of UPSTOX_TOTALS) {
  test(`matches Upstox's calculator: ${label}`, () => {
    expect(Math.abs(estimateCharges({ kind }, side, product, price, quantity).total - upstox)).toBeLessThanOrEqual(0.05);
  });
}

test("breakdown of an option sell", () => {
  expect(estimateCharges({ kind: "option" }, "SELL", "MIS", 150, 65)).toEqual({
    brokerage: 20,
    stt: 14.63, // 0.15% of ₹9,750 premium
    exchange: 3.45,
    sebi: 0.01,
    stamp: 0, // stamp duty only on buys
    gst: 4.22, // 18% of brokerage + exchange + SEBI
    total: 42.31,
  });
});
