// The only place the React app talks to the server. Pages call `api.*` and get typed results.
import type { ApiErrorBody, HistoryResponse, HistorySummary, KillSwitchResponse, LoginRequest, MeResponse, PositionsResponse, StatusResponse } from "../api/types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};

/** Called when any request (other than login) finds the session gone, e.g. it expired. */
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "cannot reach the dashboard server");
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as Partial<ApiErrorBody>;
  if (!res.ok) {
    if (res.status === 401 && path !== "/api/auth/login") onUnauthorized();
    throw new ApiError(res.status, data.error ?? res.statusText, data.retryAfterSeconds);
  }
  return data as T;
}

export const api = {
  login: (body: LoginRequest) => request<void>("POST", "/api/auth/login", body),
  logout: () => request<void>("POST", "/api/auth/logout"),
  me: () => request<MeResponse>("GET", "/api/auth/me"),
  status: () => request<StatusResponse>("GET", "/api/status"),
  positions: () => request<PositionsResponse>("GET", "/api/positions"),
  historySummary: () => request<HistorySummary>("GET", "/api/history/summary"),
  history: () => request<HistoryResponse>("GET", "/api/history"),
  killSwitch: () => request<KillSwitchResponse>("POST", "/api/kill-switch", { confirm: true }),
};
