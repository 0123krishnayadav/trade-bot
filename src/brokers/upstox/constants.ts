// Every Upstox URL the adapter uses. Add new endpoints here, not inline in the calling code.

/** Name this adapter uses for itself, e.g. as the key for saved sessions. Matches BROKER=upstox in config. */
export const UPSTOX_BROKER_NAME = "upstox";

export const UPSTOX_API_BASE = "https://api.upstox.com";

export const UPSTOX_ENDPOINTS = {
  /** Browser login page; redirects back with ?code=... */
  authorize: "/v2/login/authorization/dialog",
  /** Exchanges the login code for an access token. */
  token: "/v2/login/authorization/token",
} as const;

/** Full URL for an endpoint, e.g. upstoxUrl(UPSTOX_ENDPOINTS.token). */
export function upstoxUrl(path: string): string {
  return new URL(path, UPSTOX_API_BASE).toString();
}
