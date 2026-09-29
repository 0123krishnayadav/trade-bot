import type { Instrument, InstrumentKind } from "../../core/types";
import { istDate } from "../../utils/time";
import type { FetchFn } from "./auth";
import { UPSTOX_INSTRUMENTS_URL } from "./constants";

/** One row of Upstox's instrument file. Derivative fields are absent on equities and indices. */
export interface UpstoxInstrumentRow {
  segment: string;
  name: string;
  exchange: string;
  instrument_type: string;
  instrument_key: string;
  trading_symbol: string;
  short_name?: string;
  isin?: string;
  lot_size?: number;
  /** In paise: 5 means ₹0.05. */
  tick_size?: number;
  freeze_quantity?: number;
  /** Epoch ms of 23:59:59 IST on the last trading day. */
  expiry?: number;
  weekly?: boolean;
  strike_price?: number;
  underlying_symbol?: string;
  underlying_key?: string;
}

/** Segments we trade or watch. Currency (NCD/BCD) and NSE commodity segments are left out. */
const SEGMENTS = new Set(["NSE_EQ", "NSE_INDEX", "NSE_FO", "BSE_EQ", "BSE_INDEX", "BSE_FO", "MCX_FO", "MCX_INDEX"]);

/** Downloads today's instrument master from Upstox (public file, no login needed). */
export async function downloadUpstoxInstruments(fetchFn: FetchFn = fetch): Promise<Instrument[]> {
  const res = await fetchFn(UPSTOX_INSTRUMENTS_URL);
  if (!res.ok) throw new Error(`Downloading the Upstox instrument file failed with HTTP ${res.status}`);
  const json = new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await res.arrayBuffer())));
  return parseUpstoxInstruments(JSON.parse(json) as UpstoxInstrumentRow[]);
}

export function parseUpstoxInstruments(rows: UpstoxInstrumentRow[]): Instrument[] {
  const out: Instrument[] = [];
  for (const row of rows) {
    const instrument = toInstrument(row);
    if (instrument) out.push(instrument);
  }
  return out;
}

function toInstrument(r: UpstoxInstrumentRow): Instrument | undefined {
  if (!SEGMENTS.has(r.segment)) return undefined;
  const kind = kindOf(r);
  if (!kind) return undefined;

  const i: Instrument = {
    key: r.instrument_key,
    exchange: r.exchange,
    segment: r.segment,
    kind,
    symbol: r.trading_symbol,
    name: r.name,
    lotSize: r.lot_size ?? 1,
    tickSize: (r.tick_size ?? 5) / 100,
  };
  if (r.freeze_quantity) i.freezeQuantity = r.freeze_quantity;
  if (r.isin) i.isin = r.isin;
  if (kind === "equity") i.series = r.instrument_type;
  if (kind === "future" || kind === "option") {
    if (r.expiry === undefined || !r.underlying_symbol) return undefined;
    i.underlying = r.underlying_symbol;
    if (r.underlying_key) i.underlyingKey = r.underlying_key;
    i.expiry = istDate(new Date(r.expiry));
    if (r.weekly !== undefined) i.weekly = r.weekly;
  }
  if (kind === "option") {
    i.strike = r.strike_price;
    i.optionType = r.instrument_type as "CE" | "PE";
  }
  return i;
}

function kindOf(r: UpstoxInstrumentRow): InstrumentKind | undefined {
  if (r.segment.endsWith("_INDEX")) return "index";
  if (r.segment.endsWith("_EQ")) return "equity"; // instrument_type here is the series: EQ, BE, SM, ...
  if (r.instrument_type === "FUT") return "future";
  if (r.instrument_type === "CE" || r.instrument_type === "PE") return "option";
  return undefined;
}
