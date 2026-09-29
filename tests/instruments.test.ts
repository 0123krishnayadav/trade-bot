import { expect, test } from "bun:test";
import { parseUpstoxInstruments, downloadUpstoxInstruments, type UpstoxInstrumentRow } from "../src/brokers/upstox/instruments";
import { migrate, openDatabase } from "../src/store/database";
import { migrations } from "../src/store/migrations";
import { InstrumentStore, refreshInstrumentsIfStale } from "../src/store/instrument-store";
import { createLogger, type LogLevel } from "../src/utils/logger";
import { istDateTime } from "../src/utils/time";

// Shapes copied from Upstox's real complete.json (expiry = 23:59:59 IST on the expiry date).
const expiryMs = (date: string) => istDateTime(date, "23:59").getTime() + 59_000;
const option = (strike: number, type: "CE" | "PE", expiry: string, weekly = true, token = `${strike}${type}${expiry}`): UpstoxInstrumentRow => ({
  segment: "NSE_FO",
  name: "NIFTY",
  exchange: "NSE",
  expiry: expiryMs(expiry),
  weekly,
  instrument_type: type,
  instrument_key: `NSE_FO|${token}`,
  lot_size: 65,
  freeze_quantity: 1755,
  tick_size: 5,
  trading_symbol: `NIFTY ${strike} ${type} ${expiry}`,
  strike_price: strike,
  underlying_symbol: "NIFTY",
  underlying_key: "NSE_INDEX|Nifty 50",
});

const ROWS: UpstoxInstrumentRow[] = [
  { segment: "NSE_INDEX", name: "Nifty 50", exchange: "NSE", instrument_type: "INDEX", instrument_key: "NSE_INDEX|Nifty 50", trading_symbol: "NIFTY" },
  { segment: "NSE_INDEX", name: "Nifty Bank", exchange: "NSE", instrument_type: "INDEX", instrument_key: "NSE_INDEX|Nifty Bank", trading_symbol: "BANKNIFTY" },
  { segment: "BSE_INDEX", name: "SENSEX", exchange: "BSE", instrument_type: "INDEX", instrument_key: "BSE_INDEX|SENSEX", trading_symbol: "SENSEX" },
  {
    segment: "NSE_EQ",
    name: "RELIANCE INDUSTRIES LTD",
    exchange: "NSE",
    isin: "INE002A01018",
    instrument_type: "EQ",
    instrument_key: "NSE_EQ|INE002A01018",
    lot_size: 1,
    freeze_quantity: 100000,
    tick_size: 10,
    trading_symbol: "RELIANCE",
  },
  // A debenture listed under the same symbol as the shares (real case in Upstox's file)
  { segment: "NSE_EQ", name: "SAMVARDHANA MOTHERSON INT", exchange: "NSE", isin: "INE775A08105", instrument_type: "D1", instrument_key: "NSE_EQ|INE775A08105", lot_size: 1, tick_size: 1, trading_symbol: "MOTHERSON" },
  { segment: "NSE_EQ", name: "SAMVRDHNA MTHRSN INTL LTD", exchange: "NSE", isin: "INE775A01035", instrument_type: "EQ", instrument_key: "NSE_EQ|INE775A01035", lot_size: 1, tick_size: 1, trading_symbol: "MOTHERSON" },
  {
    segment: "NSE_FO",
    name: "NIFTY",
    exchange: "NSE",
    expiry: expiryMs("2026-10-27"),
    weekly: false,
    instrument_type: "FUT",
    instrument_key: "NSE_FO|48704",
    lot_size: 65,
    tick_size: 10,
    trading_symbol: "NIFTY FUT 27 OCT 26",
    strike_price: 0,
    underlying_symbol: "NIFTY",
    underlying_key: "NSE_INDEX|Nifty 50",
  },
  option(25000, "CE", "2026-10-06"),
  option(25000, "PE", "2026-10-06"),
  option(25050, "CE", "2026-10-06"),
  option(24950, "PE", "2026-10-06"),
  option(25000, "CE", "2026-10-13"),
  option(25000, "CE", "2026-10-19"), // Monday expiry (holiday shift)
  option(25000, "CE", "2026-09-29", false), // already expired relative to "from" below
  // Left out: currency segment
  { segment: "NCD_FO", name: "USDINR", exchange: "NSE", instrument_type: "FUT", instrument_key: "NCD_FO|1", trading_symbol: "USDINR FUT", expiry: expiryMs("2026-10-28"), underlying_symbol: "USDINR" },
];

function store() {
  const db = openDatabase(":memory:");
  migrate(db, migrations);
  const s = new InstrumentStore(db, "upstox");
  s.replaceAll(parseUpstoxInstruments(ROWS), istDateTime("2026-10-05", "08:30"));
  return s;
}

test("parses Upstox rows into instruments", () => {
  const parsed = parseUpstoxInstruments(ROWS);
  expect(parsed).toHaveLength(ROWS.length - 1); // currency row dropped
  expect(parsed.find((i) => i.key === "NSE_EQ|INE002A01018")).toEqual({
    key: "NSE_EQ|INE002A01018",
    exchange: "NSE",
    segment: "NSE_EQ",
    kind: "equity",
    symbol: "RELIANCE",
    name: "RELIANCE INDUSTRIES LTD",
    lotSize: 1,
    tickSize: 0.1, // Upstox gives paise
    freezeQuantity: 100000,
    isin: "INE002A01018",
    series: "EQ",
  });
  expect(parsed.find((i) => i.symbol === "NIFTY 25000 CE 2026-10-06")).toEqual({
    key: "NSE_FO|25000CE2026-10-06",
    exchange: "NSE",
    segment: "NSE_FO",
    kind: "option",
    symbol: "NIFTY 25000 CE 2026-10-06",
    name: "NIFTY",
    underlying: "NIFTY",
    underlyingKey: "NSE_INDEX|Nifty 50",
    expiry: "2026-10-06", // IST date, not the UTC date of the timestamp
    weekly: true,
    strike: 25000,
    optionType: "CE",
    lotSize: 65,
    tickSize: 0.05,
    freezeQuantity: 1755,
  });
});

test("finds indices by symbol or name, any case", () => {
  const s = store();
  expect(s.findIndex("NIFTY")?.key).toBe("NSE_INDEX|Nifty 50");
  expect(s.findIndex("nifty bank")?.key).toBe("NSE_INDEX|Nifty Bank");
  expect(s.findIndex("SENSEX")?.exchange).toBe("BSE");
  expect(s.findIndex("NOPE")).toBeUndefined();
});

test("finds equities and instruments by key", () => {
  const s = store();
  expect(s.findEquity("reliance")?.key).toBe("NSE_EQ|INE002A01018");
  expect(s.findEquity("RELIANCE", "BSE")).toBeUndefined();
  expect(s.get("NSE_FO|48704")?.kind).toBe("future");
  expect(s.findEquity("MOTHERSON")?.key).toBe("NSE_EQ|INE775A01035"); // the shares, not the debenture
});

test("lists upcoming expiries in order, including holiday-shifted ones", () => {
  const s = store();
  expect(s.expiries("NIFTY", "option", "2026-10-05")).toEqual(["2026-10-06", "2026-10-13", "2026-10-19"]);
  expect(s.expiries("NIFTY", "option", "2026-10-06")[0]).toBe("2026-10-06"); // expiry day itself counts
  expect(s.expiries("NIFTY", "future", "2026-10-05")).toEqual(["2026-10-27"]);
});

test("option chain and single option lookups", () => {
  const s = store();
  const chain = s.optionChain("NIFTY", "2026-10-06");
  expect(chain.map((i) => `${i.strike}${i.optionType}`)).toEqual(["24950PE", "25000CE", "25000PE", "25050CE"]);
  expect(s.findOption({ underlying: "NIFTY", expiry: "2026-10-06", strike: 25000, optionType: "PE" })?.lotSize).toBe(65);
  expect(s.findOption({ underlying: "NIFTY", expiry: "2026-10-06", strike: 26000, optionType: "PE" })).toBeUndefined();
});

test("nearest future when no expiry is given", () => {
  const s = store();
  expect(s.findFuture("NIFTY")?.key).toBe("NSE_FO|48704");
  expect(s.findFuture("NIFTY", "2026-11-24")).toBeUndefined();
});

test("a new download replaces the old list completely", () => {
  const s = store();
  s.replaceAll(parseUpstoxInstruments(ROWS.slice(0, 1)), istDateTime("2026-10-06", "08:30"));
  expect(s.findEquity("RELIANCE")).toBeUndefined();
  expect(s.lastDownload()?.count).toBe(1);
});

test("needs a refresh once a newer daily file is out (08:00 IST)", () => {
  const s = store(); // downloaded 2026-10-05 08:30
  expect(s.needsRefresh(istDateTime("2026-10-05", "15:00"))).toBe(false);
  expect(s.needsRefresh(istDateTime("2026-10-06", "07:59"))).toBe(false); // today's file not out yet
  expect(s.needsRefresh(istDateTime("2026-10-06", "08:00"))).toBe(true);

  const early = store();
  early.replaceAll([], istDateTime("2026-10-05", "06:00")); // before that day's file
  expect(early.needsRefresh(istDateTime("2026-10-05", "09:00"))).toBe(true);

  const db = openDatabase(":memory:");
  migrate(db, migrations);
  expect(new InstrumentStore(db, "upstox").needsRefresh()).toBe(true); // never downloaded
});

function quietLogger() {
  const lines: { line: string; level: LogLevel }[] = [];
  return { lines, logger: createLogger({ level: "debug", format: "pretty", write: (line, level) => lines.push({ line, level }) }) };
}

test("refreshes when stale, and skips when fresh", async () => {
  const s = store();
  const { logger } = quietLogger();
  let downloads = 0;
  const download = async () => {
    downloads++;
    return parseUpstoxInstruments(ROWS);
  };
  await refreshInstrumentsIfStale(s, download, logger, istDateTime("2026-10-05", "12:00"));
  expect(downloads).toBe(0);
  await refreshInstrumentsIfStale(s, download, logger, istDateTime("2026-10-06", "08:15"));
  expect(downloads).toBe(1);
  expect(s.lastDownload()?.downloadedAt).toEqual(istDateTime("2026-10-06", "08:15"));
});

test("keeps the previous copy if a download fails, but fails with no copy", async () => {
  const s = store();
  const { logger, lines } = quietLogger();
  const failing = async () => {
    throw new Error("assets.upstox.com is down");
  };
  await refreshInstrumentsIfStale(s, failing, logger, istDateTime("2026-10-06", "09:00"));
  expect(s.findIndex("NIFTY")).toBeDefined();
  expect(lines.some((l) => l.level === "warn" && l.line.includes("using the previous copy"))).toBe(true);

  const db = openDatabase(":memory:");
  migrate(db, migrations);
  expect(refreshInstrumentsIfStale(new InstrumentStore(db, "upstox"), failing, logger)).rejects.toThrow("Could not download instruments");
});

test("rejects an empty download", async () => {
  const db = openDatabase(":memory:");
  migrate(db, migrations);
  const { logger } = quietLogger();
  expect(refreshInstrumentsIfStale(new InstrumentStore(db, "upstox"), async () => [], logger)).rejects.toThrow("empty");
});

test("downloads and un-gzips the Upstox file", async () => {
  const gz = Bun.gzipSync(new TextEncoder().encode(JSON.stringify(ROWS)));
  const urls: string[] = [];
  const instruments = await downloadUpstoxInstruments(async (url) => {
    urls.push(url);
    return new Response(gz);
  });
  expect(urls).toEqual(["https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz"]);
  expect(instruments).toHaveLength(ROWS.length - 1);
  expect(downloadUpstoxInstruments(async () => new Response("nope", { status: 404 }))).rejects.toThrow("HTTP 404");
});
