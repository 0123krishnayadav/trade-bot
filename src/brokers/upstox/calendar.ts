import type { MarketHoliday } from "../../core/types";
import { UPSTOX_ENDPOINTS } from "./constants";
import type { UpstoxHttp } from "./http";

/** The exchange whose hours we follow: NSE F&O. */
const FO_EXCHANGE = "NFO";

interface UpstoxHoliday {
  date: string;
  description: string;
  holiday_type: string;
  closed_exchanges: string[];
  open_exchanges: { exchange: string; start_time: number; end_time: number }[];
}

export class UpstoxCalendarApi {
  constructor(private readonly http: UpstoxHttp) {}

  /**
   * This year's holidays and special sessions, as they affect F&O. Upstox also lists days that
   * are only settlement holidays (F&O trades normal hours); those come back with their session.
   */
  async fetchHolidays(): Promise<MarketHoliday[]> {
    const rows = await this.http.call<UpstoxHoliday[]>("GET", UPSTOX_ENDPOINTS.holidays);
    return rows.map((h) => {
      const open = h.open_exchanges.find((e) => e.exchange === FO_EXCHANGE);
      const closed = h.closed_exchanges.includes(FO_EXCHANGE) || !open;
      return {
        date: h.date,
        description: h.description,
        ...(closed ? {} : { session: { open: new Date(open!.start_time), close: new Date(open!.end_time) } }),
      };
    });
  }
}
