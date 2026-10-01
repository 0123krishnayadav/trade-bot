import type { BunRequest } from "bun";
import type { Logger } from "../../utils/logger";
import { LoginLockout } from "../auth/lockout";
import { verifyCredentials } from "../auth/credentials";
import { SESSION_COOKIE, SessionManager } from "../auth/session";
import { KillSwitchUnavailable } from "../services/kill-switch-service";
import type { ApiErrorBody, HistoryResponse, HistorySummary, KillSwitchRequest, KillSwitchResponse, LoginRequest, MeResponse, PositionsResponse, StatusResponse } from "./types";

export interface ApiDeps {
  sessions: SessionManager;
  lockout: LoginLockout;
  hashes: { passwordHash: string; pinHash: string };
  secureCookie: boolean;
  mode: "paper" | "live";
  status: () => StatusResponse;
  positions: () => PositionsResponse;
  historySummary: () => HistorySummary;
  history: () => HistoryResponse;
  killSwitch: () => KillSwitchResponse;
  logger: Logger;
}

type Handler = (req: BunRequest) => Response | Promise<Response>;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
const fail = (status: number, error: string, extra: Partial<ApiErrorBody> = {}, headers: Record<string, string> = {}) =>
  json({ error, ...extra } satisfies ApiErrorBody, status, headers);
const noContent = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });

/** The /api routes for Bun.serve. Every route except login needs a valid session cookie. */
export function createApiRoutes(deps: ApiDeps) {
  const { sessions, lockout, logger } = deps;

  /** Rejects requests without a valid session. */
  const authed =
    (handler: (req: BunRequest, session: { exp: number }) => Response | Promise<Response>): Handler =>
    (req) => {
      const session = sessions.verify(req.cookies.get(SESSION_COOKIE));
      return session ? handler(req, session) : fail(401, "not logged in");
    };

  /**
   * Requests that change something must be JSON. A plain HTML form on another site can't send
   * that, which (with the SameSite=Strict cookie) blocks cross-site request forgery.
   */
  const jsonOnly =
    (handler: Handler): Handler =>
    (req) =>
      req.headers.get("content-type")?.split(";")[0]?.trim() === "application/json" ? handler(req) : fail(415, "expected application/json");

  const login: Handler = async (req) => {
    const locked = lockout.remainingMs();
    if (locked > 0) {
      const seconds = Math.ceil(locked / 1000);
      return fail(429, "too many failed attempts; try again later", { retryAfterSeconds: seconds }, { "Retry-After": String(seconds) });
    }
    const body = (await req.json().catch(() => null)) as Partial<LoginRequest> | null;
    if (typeof body?.password !== "string" || typeof body?.pin !== "string" || body.password.length > 1024 || body.pin.length > 64) {
      return fail(400, "password and pin are required");
    }
    if (!(await verifyCredentials(body.password, body.pin, deps.hashes))) {
      lockout.recordFailure();
      logger.warn("dashboard login failed", { lockedForSeconds: Math.ceil(lockout.remainingMs() / 1000) });
      return fail(401, "invalid credentials");
    }
    lockout.recordSuccess();
    const { token, expiresAt } = sessions.create();
    req.cookies.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "strict", secure: deps.secureCookie, path: "/", expires: expiresAt });
    logger.info("dashboard login");
    return noContent();
  };

  const killSwitch: Handler = async (req) => {
    const body = (await req.json().catch(() => null)) as Partial<KillSwitchRequest> | null;
    if (body?.confirm !== true) return fail(400, "confirm the kill switch");
    logger.warn("dashboard: KILL SWITCH pressed");
    try {
      return json(deps.killSwitch());
    } catch (err) {
      if (err instanceof KillSwitchUnavailable) return fail(503, err.message);
      throw err;
    }
  };

  const logout: Handler = (req) => {
    sessions.revoke(req.cookies.get(SESSION_COOKIE));
    req.cookies.delete(SESSION_COOKIE, { path: "/" });
    return noContent();
  };

  return {
    "/api/auth/login": { POST: jsonOnly(login) },
    "/api/auth/logout": { POST: logout },
    "/api/auth/me": { GET: authed((_req, s) => json({ sessionExpiresAt: new Date(s.exp).toISOString(), mode: deps.mode } satisfies MeResponse)) },
    "/api/status": { GET: authed(() => json(deps.status())) },
    "/api/positions": { GET: authed(() => json(deps.positions())) },
    "/api/history/summary": { GET: authed(() => json(deps.historySummary())) },
    "/api/history": { GET: authed(() => json(deps.history())) },
    "/api/kill-switch": { POST: authed(jsonOnly(killSwitch)) },
    "/api/*": () => fail(404, "not found"),
  };
}
