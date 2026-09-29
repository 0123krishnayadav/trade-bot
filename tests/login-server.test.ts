import { expect, test } from "bun:test";
import { waitForLogin } from "../src/brokers/upstox/login-server";
import type { BrokerSession } from "../src/core/types";

const session: BrokerSession = {
  broker: "upstox",
  userId: "AB1234",
  accessToken: "tok",
  issuedAt: new Date("2026-10-05T03:40:00Z"),
  expiresAt: new Date("2026-10-05T22:00:00Z"),
};

let nextPort = 15_400;

/** Starts a login and returns what the browser would be redirected to. */
function startLogin(exchange: (code: string) => Promise<BrokerSession>, timeoutMs?: number) {
  const redirectUri = `http://127.0.0.1:${nextPort++}/callback`;
  let state = "";
  const result = waitForLogin({
    apiKey: "key",
    redirectUri,
    exchange,
    timeoutMs,
    onAuthorizeUrl: (url) => (state = new URL(url).searchParams.get("state")!),
  });
  const callback = (params: Record<string, string>, path = "/callback") =>
    fetch(`${new URL(redirectUri).origin}${path}?${new URLSearchParams(params)}`);
  return { result, callback, state: () => state };
}

test("completes the login when Upstox redirects back with a code", async () => {
  const codes: string[] = [];
  const login = startLogin(async (code) => {
    codes.push(code);
    return session;
  });
  const res = await login.callback({ code: "code-1", state: login.state() });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Logged in to Upstox as AB1234");
  expect(await login.result).toEqual(session);
  expect(codes).toEqual(["code-1"]);
});

test("ignores redirects with the wrong state or path, and keeps waiting", async () => {
  const login = startLogin(async () => session);
  expect((await login.callback({ code: "evil", state: "guess" })).status).toBe(400);
  expect((await login.callback({ code: "c", state: login.state() }, "/other")).status).toBe(404);
  expect((await login.callback({ state: login.state() })).status).toBe(400);
  expect((await login.callback({ code: "real", state: login.state() })).status).toBe(200);
  expect(await login.result).toEqual(session);
});

test("fails when the code exchange fails", async () => {
  const login = startLogin(async () => {
    throw new Error("Invalid Auth code <script>");
  });
  const failed = login.result.catch((e) => e);
  const res = await login.callback({ code: "c", state: login.state() });
  expect(res.status).toBe(502);
  expect(await res.text()).toContain("Invalid Auth code &#60;script&#62;");
  expect((await failed).message).toBe("Invalid Auth code <script>");
});

test("times out if nobody logs in", async () => {
  const login = startLogin(async () => session, 50);
  expect((await login.result.catch((e) => e)).message).toBe("No Upstox login within 0.05s");
});

test("refuses a redirect URL that isn't on this machine", async () => {
  const err = await waitForLogin({
    apiKey: "key",
    redirectUri: "https://example.com/callback",
    exchange: async () => session,
    onAuthorizeUrl: () => {},
  }).catch((e) => e);
  expect(err.message).toContain("must point at this machine");
});
