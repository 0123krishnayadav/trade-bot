import type { BrokerSession } from "../../core/types";
import { addDays, istDate, istDateTime } from "../../utils/time";
import { UpstoxError } from "./errors";
import { UPSTOX_BROKER_NAME, UPSTOX_ENDPOINTS, upstoxUrl } from "./constants";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface UpstoxAppCredentials {
  apiKey: string;
  apiSecret: string;
  redirectUri: string;
}

/** The Upstox page where the user logs in. `state` comes back unchanged on the redirect. */
export function authorizationUrl(apiKey: string, redirectUri: string, state: string): string {
  const url = new URL(upstoxUrl(UPSTOX_ENDPOINTS.authorize));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", apiKey);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Upstox access tokens stop working at 03:30 IST, whatever time they were issued: a token from
 * 10:00 on Monday lasts until 03:30 on Tuesday.
 */
export function upstoxTokenExpiry(issuedAt: Date): Date {
  const date = istDate(issuedAt);
  const sameDay = istDateTime(date, "03:30");
  return issuedAt < sameDay ? sameDay : istDateTime(addDays(date, 1), "03:30");
}

interface TokenResponse {
  access_token?: unknown;
  user_id?: unknown;
  user_name?: unknown;
}

/** Trades the one-time `code` from the login redirect for an access token. */
export async function exchangeCode(
  creds: UpstoxAppCredentials,
  code: string,
  deps: { fetchFn?: FetchFn; now?: () => Date } = {},
): Promise<BrokerSession> {
  const fetchFn = deps.fetchFn ?? fetch;
  const res = await fetchFn(upstoxUrl(UPSTOX_ENDPOINTS.token), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      code,
      client_id: creds.apiKey,
      client_secret: creds.apiSecret,
      redirect_uri: creds.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const body = (await res.json().catch(() => undefined)) as TokenResponse | undefined;
  if (!res.ok) throw UpstoxError.fromResponse(res.status, body);
  if (typeof body?.access_token !== "string" || typeof body.user_id !== "string") {
    throw new UpstoxError("Upstox token response is missing access_token or user_id", res.status);
  }

  const issuedAt = (deps.now ?? (() => new Date()))();
  return {
    broker: UPSTOX_BROKER_NAME,
    userId: body.user_id,
    userName: typeof body.user_name === "string" ? body.user_name : undefined,
    accessToken: body.access_token,
    issuedAt,
    expiresAt: upstoxTokenExpiry(issuedAt),
  };
}
