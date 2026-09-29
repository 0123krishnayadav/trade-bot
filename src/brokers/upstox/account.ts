import { UPSTOX_ENDPOINTS } from "./constants";
import type { UpstoxHttp } from "./http";
import type { UpstoxFunds, UpstoxHolding, UpstoxPosition, UpstoxProfile } from "./types";

export interface UpstoxPortfolio {
  /** Intraday and carry-forward (F&O / NRML) positions. */
  positions: UpstoxPosition[];
  /** Delivery holdings in the demat account. */
  holdings: UpstoxHolding[];
}

export class UpstoxAccountApi {
  constructor(private readonly http: UpstoxHttp) {}

  /** Cheapest way to check the access token works. */
  fetchProfile(): Promise<UpstoxProfile> {
    return this.http.call("GET", UPSTOX_ENDPOINTS.profile);
  }

  /** Available and used margin. Upstox doesn't serve this API between about 00:00 and 05:30 IST. */
  fetchFunds(): Promise<UpstoxFunds> {
    return this.http.call("GET", UPSTOX_ENDPOINTS.fundsAndMargin);
  }

  fetchPositions(): Promise<UpstoxPosition[]> {
    return this.http.call("GET", UPSTOX_ENDPOINTS.positions);
  }

  fetchHoldings(): Promise<UpstoxHolding[]> {
    return this.http.call("GET", UPSTOX_ENDPOINTS.holdings);
  }

  async fetchPortfolio(): Promise<UpstoxPortfolio> {
    const [positions, holdings] = await Promise.all([this.fetchPositions(), this.fetchHoldings()]);
    return { positions, holdings };
  }
}
