import { expect, test } from "bun:test";
import { UpstoxHttp } from "../src/brokers/upstox/http";
import { UpstoxAuthError, UpstoxError } from "../src/brokers/upstox/errors";
import { fail, fakeUpstox, ok } from "./upstox-helpers";

test("sends the token, picks the host and unwraps data", async () => {
  const { http, calls } = fakeUpstox([ok({ user_id: "AB1234" }), ok({ order_id: "1" })]);
  expect(await http.call<any>("GET", "/v2/user/profile", { query: { a: "x|y", skip: undefined } })).toEqual({ user_id: "AB1234" });
  await http.call<any>("DELETE", "/v3/order/cancel", { host: "hft", query: { order_id: "1" } });

  expect(calls[0]!.url.toString()).toBe("https://api.upstox.com/v2/user/profile?a=x%7Cy");
  expect(calls[0]!.headers).toEqual({ Authorization: "Bearer test-token", Accept: "application/json" });
  expect(calls[1]!.url.toString()).toBe("https://api-hft.upstox.com/v3/order/cancel?order_id=1");
});

test("sends JSON bodies", async () => {
  const { http, calls } = fakeUpstox([ok({})]);
  await http.call<any>("POST", "/x", { body: { a: 1 } });
  expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
  expect(calls[0]!.body).toEqual({ a: 1 });
});

test("refuses to call without a token", async () => {
  const { http, calls } = fakeUpstox([], { token: undefined });
  expect(await http.call<any>("GET", "/x").catch((e) => e as UpstoxError)).toBeInstanceOf(UpstoxAuthError);
  expect(calls).toHaveLength(0);
});

test("maps Upstox errors, and 401 to an auth error", async () => {
  const { http } = fakeUpstox([fail(400, "UDAPI1026", "Instrument key is invalid"), fail(401, "UDAPI100050", "Invalid token")]);
  const bad = await http.call<any>("GET", "/x").catch((e) => e as UpstoxError);
  expect(bad).toBeInstanceOf(UpstoxError);
  expect(bad).not.toBeInstanceOf(UpstoxAuthError);
  expect(bad.message).toBe("Instrument key is invalid (UDAPI1026)");
  const expired = await http.call<any>("GET", "/x").catch((e) => e as UpstoxError);
  expect(expired).toBeInstanceOf(UpstoxAuthError);
  expect(expired.message).toContain("bun run login");
});

test("treats status:error in a 200 response as an error", async () => {
  const { http } = fakeUpstox([Response.json({ status: "error", errors: [{ errorCode: "X1", message: "nope" }] })]);
  expect((await http.call<any>("GET", "/x").catch((e) => e as UpstoxError)).message).toBe("nope (X1)");
});

test("retries GET on network errors, 429 and 5xx with backoff", async () => {
  const { http, calls, slept } = fakeUpstox([new Error("ECONNRESET"), new Response("busy", { status: 503 }), ok("done")]);
  expect(await http.call<any>("GET", "/x")).toBe("done");
  expect(calls).toHaveLength(3);
  expect(slept).toEqual([500, 1000]);
});

test("gives up on GET after the retries", async () => {
  const { http, calls } = fakeUpstox([new Error("down"), new Error("down"), new Error("down")]);
  expect((await http.call<any>("GET", "/x").catch((e) => e as UpstoxError)).message).toContain("Network error");
  expect(calls).toHaveLength(3);
});

test("never retries order-changing requests", async () => {
  for (const method of ["POST", "PUT", "DELETE"] as const) {
    const { http, calls } = fakeUpstox([new Error("timeout"), ok("second")]);
    expect(await http.call(method, "/v3/order/place").catch((e) => e as UpstoxError)).toBeInstanceOf(UpstoxError);
    expect(calls).toHaveLength(1);
  }
});

test("rate-limits to the configured requests per second", async () => {
  let now = 0;
  const slept: number[] = [];
  const http = new UpstoxHttp({
    getAccessToken: () => "t",
    maxRequestsPerSecond: 2,
    fetchFn: async () => ok({}),
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
  });
  await http.call<any>("GET", "/a");
  now += 100;
  await http.call<any>("GET", "/b");
  await http.call<any>("GET", "/c"); // third within one second: waits until the first is 1s old
  expect(slept).toEqual([900]);
});
