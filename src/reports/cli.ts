// `bun run report [paper|live]`: trade statistics from the database (read-only).
import { Database } from "bun:sqlite";
import { TradingStore } from "../store/trading-store";
import { buildReport, formatReport } from "./report";

const mode = (process.argv[2] ?? process.env.TRADING_MODE ?? "paper") as "paper" | "live";
if (mode !== "paper" && mode !== "live") {
  console.error("usage: bun run report [paper|live]");
  process.exit(1);
}
const db = new Database(process.env.DB_PATH ?? "./db/trade-bot.sqlite", { readonly: true, strict: true });
const trades = new TradingStore(db, mode).trades();
console.log(formatReport(buildReport(trades), `Trade report (${mode})`));
db.close();
