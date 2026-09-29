import type { BrokerSession } from "../../core/types";
import { authorizationUrl } from "./auth";

export interface LoginServerOptions {
  apiKey: string;
  redirectUri: string;
  /** Exchanges the redirect's code for a session (exchangeCode in production). */
  exchange: (code: string) => Promise<BrokerSession>;
  /** Called with the Upstox login URL once the callback server is listening. */
  onAuthorizeUrl: (url: string) => void;
  timeoutMs?: number;
}

const LOCAL_HOSTS = ["127.0.0.1", "localhost"];

/**
 * Runs a local server on the redirect URL, waits for Upstox to redirect back after the user logs
 * in, and resolves with the session. Only redirects carrying our random `state` are accepted,
 * so another page can't feed us its own login code.
 */
export async function waitForLogin(opts: LoginServerOptions): Promise<BrokerSession> {
  const redirect = new URL(opts.redirectUri);
  if (redirect.protocol !== "http:" || !LOCAL_HOSTS.includes(redirect.hostname)) {
    throw new Error(
      `UPSTOX_REDIRECT_URI must point at this machine, e.g. http://127.0.0.1:5000/callback (got ${opts.redirectUri})`,
    );
  }

  const state = crypto.randomUUID();
  const { promise, resolve, reject } = Promise.withResolvers<BrokerSession>();

  const server = Bun.serve({
    hostname: redirect.hostname,
    port: Number(redirect.port || 80),
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== redirect.pathname) return page(404, "Not found.");
      if (url.searchParams.get("state") !== state) {
        return page(400, "This login link is out of date. Run <code>bun run login</code> again.");
      }
      const code = url.searchParams.get("code");
      if (!code) return page(400, "Upstox didn't send a login code. Try logging in again.");
      try {
        const session = await opts.exchange(code);
        resolve(session);
        return page(200, `Logged in to Upstox as ${escapeHtml(session.userId)}. You can close this tab.`);
      } catch (err) {
        reject(err);
        return page(502, `Login failed: ${escapeHtml(String(err instanceof Error ? err.message : err))}`);
      }
    },
  });

  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const timer = setTimeout(() => reject(new Error(`No Upstox login within ${timeoutMs / 1000}s`)), timeoutMs);
  opts.onAuthorizeUrl(authorizationUrl(opts.apiKey, opts.redirectUri, state));

  try {
    return await promise;
  } finally {
    clearTimeout(timer);
    server.stop(); // lets the in-flight response finish
  }
}

function page(status: number, message: string): Response {
  return new Response(`<!doctype html><title>trade-bot login</title><p style="font:16px system-ui">${message}</p>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
