import { expect, test } from "bun:test";
import type { MarketData, Tick } from "../src/core/types";
import { MarketEngine } from "../src/engine/market-engine";
import { ScripRecorder } from "../src/engine/scrip-recorder";
import { migrate, openDatabase } from "../src/store/database";
import { migrations } from "../src/store/migrations";
import { ScripStore } from "../src/store/scrip-store";
import { createLogger } from "../src/utils/logger";

function setup() {
  let emit: (t: Tick) => void = () => {};
  const md = {
    connect: async () => {},
    disconnect: () => {},
    subscribe: () => {},
    unsubscribe: () => {},
    onTick: (h: (t: Tick) => void) => (emit = h),
    onConnectionChange: () => {},
    getCandles: async () => [],
  } as unknown as MarketData;
  const quiet = createLogger({ level: "error", format: "pretty", write: () => {} });
  const market = new MarketEngine(md, { logger: quiet });
  const db = openDatabase(":memory:");
  migrate(db, migrations);
  const store = new ScripStore(db);
  const tick = (key: string, ltp: number, prevClose: number) => emit({ instrumentKey: key, ltp, prevClose, time: new Date() });
  return { market, db, store, tick };
}

test("saves the latest ltp and cp per instrument in batches", () => {
  const { market, db, store, tick } = setup();
  const recorder = new ScripRecorder(market, store, { intervalMs: 60_000 });
  recorder.start();
  tick("NIFTY", 22550, 22500);
  tick("NIFTY", 22560, 22500);
  tick("CE", 148.85, 160);
  expect(store.get(["NIFTY"]).size).toBe(0); // nothing written until the batch is flushed

  recorder.flush();
  const saved = store.get(["NIFTY", "CE", "UNKNOWN"]);
  expect([...saved.values()].map((s) => [s.instrumentKey, s.ltp, s.cp])).toEqual([
    ["CE", 148.85, 160],
    ["NIFTY", 22560, 22500],
  ]);

  tick("CE", 140, 160);
  recorder.stop(); // stop flushes what's left
  expect(store.get(["CE"]).get("CE")?.ltp).toBe(140);
  tick("CE", 1, 160);
  recorder.flush();
  expect(store.get(["CE"]).get("CE")?.ltp).toBe(140); // no longer listening
  db.close();
});

test("a failing write is logged, not thrown into the tick path", () => {
  const { market, db, store, tick } = setup();
  const warnings: string[] = [];
  const logger = createLogger({ level: "warn", format: "pretty", write: (line) => warnings.push(line) });
  const recorder = new ScripRecorder(market, store, { intervalMs: 60_000, logger });
  recorder.start();
  tick("NIFTY", 22550, 22500);
  db.close();
  expect(() => recorder.flush()).not.toThrow();
  expect(warnings.join()).toContain("could not save scrips");
  recorder.stop();
});
