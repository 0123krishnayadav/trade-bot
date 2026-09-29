import type { Database } from "bun:sqlite";
import type { Instrument, InstrumentKind, InstrumentLookup, OptionQuery } from "../core/types";
import type { Logger } from "../utils/logger";
import { addDays, formatIst, istDate, istDateTime } from "../utils/time";

/** Brokers publish the day's instrument file early in the morning; a download before this is stale. */
export const INSTRUMENTS_READY_AT = "08:00";

interface Row {
  key: string;
  exchange: string;
  segment: string;
  kind: InstrumentKind;
  symbol: string;
  name: string;
  underlying: string | null;
  underlying_key: string | null;
  expiry: string | null;
  strike: number | null;
  option_type: "CE" | "PE" | null;
  weekly: number | null;
  lot_size: number;
  tick_size: number;
  freeze_quantity: number | null;
  isin: string | null;
  series: string | null;
}

/** The instrument master for one broker, kept in SQLite so restarts don't need a download. */
export class InstrumentStore implements InstrumentLookup {
  constructor(
    private readonly db: Database,
    private readonly broker: string,
  ) {}

  /** Replaces this broker's instruments in one transaction; readers never see a half-written list. */
  replaceAll(instruments: Instrument[], downloadedAt: Date = new Date()): void {
    const insert = this.db.query(
      `INSERT INTO instruments (broker, key, exchange, segment, kind, symbol, name, underlying, underlying_key,
         expiry, strike, option_type, weekly, lot_size, tick_size, freeze_quantity, isin, series)
       VALUES ($broker, $key, $exchange, $segment, $kind, $symbol, $name, $underlying, $underlyingKey,
         $expiry, $strike, $optionType, $weekly, $lotSize, $tickSize, $freezeQuantity, $isin, $series)`,
    );
    this.db.transaction(() => {
      this.db.query("DELETE FROM instruments WHERE broker = $broker").run({ broker: this.broker });
      for (const i of instruments) {
        insert.run({
          broker: this.broker,
          key: i.key,
          exchange: i.exchange,
          segment: i.segment,
          kind: i.kind,
          symbol: i.symbol,
          name: i.name,
          underlying: i.underlying ?? null,
          underlyingKey: i.underlyingKey ?? null,
          expiry: i.expiry ?? null,
          strike: i.strike ?? null,
          optionType: i.optionType ?? null,
          weekly: i.weekly === undefined ? null : Number(i.weekly),
          lotSize: i.lotSize,
          tickSize: i.tickSize,
          freezeQuantity: i.freezeQuantity ?? null,
          isin: i.isin ?? null,
          series: i.series ?? null,
        });
      }
      this.db
        .query(
          `INSERT INTO instrument_downloads (broker, downloaded_at, count) VALUES ($broker, $downloadedAt, $count)
           ON CONFLICT (broker) DO UPDATE SET downloaded_at = excluded.downloaded_at, count = excluded.count`,
        )
        .run({ broker: this.broker, downloadedAt: downloadedAt.toISOString(), count: instruments.length });
    })();
  }

  lastDownload(): { downloadedAt: Date; count: number } | undefined {
    const row = this.db
      .query("SELECT downloaded_at, count FROM instrument_downloads WHERE broker = $broker")
      .get({ broker: this.broker }) as { downloaded_at: string; count: number } | null;
    return row ? { downloadedAt: new Date(row.downloaded_at), count: row.count } : undefined;
  }

  /** True when there's no download since the latest day's file was published (08:00 IST). */
  needsRefresh(now: Date = new Date()): boolean {
    const last = this.lastDownload();
    if (!last) return true;
    const today = istDate(now);
    const readyToday = istDateTime(today, INSTRUMENTS_READY_AT);
    const latestFile = now >= readyToday ? readyToday : istDateTime(addDays(today, -1), INSTRUMENTS_READY_AT);
    return last.downloadedAt < latestFile;
  }

  get(key: string): Instrument | undefined {
    return this.one("key = $key", { key });
  }

  findIndex(symbolOrName: string): Instrument | undefined {
    return this.one("kind = 'index' AND (symbol = $s COLLATE NOCASE OR name = $s COLLATE NOCASE) ORDER BY exchange", {
      s: symbolOrName,
    });
  }

  /** Prefers normal shares (series EQ) when bonds or warrants share the symbol, e.g. MOTHERSON. */
  findEquity(symbol: string, exchange = "NSE"): Instrument | undefined {
    return this.one(
      "kind = 'equity' AND exchange = $exchange AND symbol = $symbol COLLATE NOCASE ORDER BY series = 'EQ' DESC, series = 'BE' DESC",
      { symbol, exchange },
    );
  }

  expiries(underlying: string, kind: "option" | "future", from: string = istDate(new Date())): string[] {
    const rows = this.db
      .query(
        `SELECT DISTINCT expiry FROM instruments
         WHERE broker = $broker AND underlying = $underlying AND kind = $kind AND expiry >= $from
         ORDER BY expiry`,
      )
      .all({ broker: this.broker, underlying, kind, from }) as { expiry: string }[];
    return rows.map((r) => r.expiry);
  }

  optionChain(underlying: string, expiry: string): Instrument[] {
    return this.many("underlying = $underlying AND kind = 'option' AND expiry = $expiry ORDER BY strike, option_type", {
      underlying,
      expiry,
    });
  }

  findOption(q: OptionQuery): Instrument | undefined {
    return this.one(
      "underlying = $underlying AND kind = 'option' AND expiry = $expiry AND strike = $strike AND option_type = $optionType",
      { underlying: q.underlying, expiry: q.expiry, strike: q.strike, optionType: q.optionType },
    );
  }

  findFuture(underlying: string, expiry?: string): Instrument | undefined {
    if (expiry) return this.one("underlying = $underlying AND kind = 'future' AND expiry = $expiry", { underlying, expiry });
    const nearest = this.expiries(underlying, "future")[0];
    return nearest ? this.findFuture(underlying, nearest) : undefined;
  }

  private one(where: string, params: Record<string, string | number>): Instrument | undefined {
    return this.many(`${where} LIMIT 1`, params)[0];
  }

  private many(where: string, params: Record<string, string | number>): Instrument[] {
    const rows = this.db
      .query(`SELECT * FROM instruments WHERE broker = $broker AND ${where}`)
      .all({ broker: this.broker, ...params }) as Row[];
    return rows.map(toInstrument);
  }
}

/**
 * Downloads the instrument master if the stored copy is from before today's file. If the download
 * fails but an older copy exists, keeps using it (expiries and lot sizes rarely change overnight)
 * and logs a warning; with no copy at all, the error is thrown.
 */
export async function refreshInstrumentsIfStale(
  store: InstrumentStore,
  download: () => Promise<Instrument[]>,
  logger: Logger,
  now: Date = new Date(),
): Promise<void> {
  if (!store.needsRefresh(now)) {
    const last = store.lastDownload()!;
    logger.info("instruments up to date", { count: last.count, downloadedAt: formatIst(last.downloadedAt) + " IST" });
    return;
  }
  const started = Date.now();
  try {
    const instruments = await download();
    if (instruments.length === 0) throw new Error("the instrument file was empty");
    store.replaceAll(instruments, now);
    logger.info("instruments downloaded", { count: instruments.length, ms: Date.now() - started });
  } catch (err) {
    const last = store.lastDownload();
    if (!last) throw new Error(`Could not download instruments: ${err instanceof Error ? err.message : err}`);
    logger.warn("instrument download failed, using the previous copy", {
      error: String(err),
      downloadedAt: formatIst(last.downloadedAt) + " IST",
    });
  }
}

function toInstrument(r: Row): Instrument {
  const i: Instrument = {
    key: r.key,
    exchange: r.exchange,
    segment: r.segment,
    kind: r.kind,
    symbol: r.symbol,
    name: r.name,
    lotSize: r.lot_size,
    tickSize: r.tick_size,
  };
  if (r.underlying !== null) i.underlying = r.underlying;
  if (r.underlying_key !== null) i.underlyingKey = r.underlying_key;
  if (r.expiry !== null) i.expiry = r.expiry;
  if (r.strike !== null) i.strike = r.strike;
  if (r.option_type !== null) i.optionType = r.option_type;
  if (r.weekly !== null) i.weekly = r.weekly === 1;
  if (r.freeze_quantity !== null) i.freezeQuantity = r.freeze_quantity;
  if (r.isin !== null) i.isin = r.isin;
  if (r.series !== null) i.series = r.series;
  return i;
}
