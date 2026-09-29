import { expect, test } from "bun:test";
import { authorizationUrl, exchangeCode, upstoxTokenExpiry, type FetchFn } from "../src/brokers/upstox/auth";
import { UpstoxError } from "../src/brokers/upstox/errors";
import { formatIst, istDateTime } from "../src/utils/time";

const creds = { apiKey: "my-key", apiSecret: "my-secret", redirectUri: "http://127.0.0.1:5000/callback" };

test("builds the login URL", () => {
  const url = new URL(authorizationUrl(creds.apiKey, creds.redirectUri, "state-1"));
  expect(url.origin + url.pathname).toBe("https://api.upstox.com/v2/login/authorization/dialog");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    response_type: "code",
    client_id: "my-key",
    redirect_uri: "http://127.0.0.1:5000/callback",
    state: "state-1",
  });
});

test("tokens expire at the next 03:30 IST", () => {
  const expiry = (date: string, time: string) => formatIst(upstoxTokenExpiry(istDateTime(date, time)));
  expect(expiry("2026-10-05", "08:00")).toBe("2026-10-06 03:30:00");
  expect(expiry("2026-10-05", "23:59")).toBe("2026-10-06 03:30:00");
  expect(expiry("2026-10-05", "02:00")).toBe("2026-10-05 03:30:00");
  expect(expiry("2026-10-05", "03:30")).toBe("2026-10-06 03:30:00");
  expect(expiry("2026-12-31", "09:00")).toBe("2027-01-01 03:30:00");
});

test("exchanges the code for a session", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const fetchFn: FetchFn = async (url, init) => {
    request = { url, init };
    return Response.json({ access_token: "tok", user_id: "AB1234", user_name: "Test User", email: "x@y.z" });
  };
  const now = istDateTime("2026-10-05", "08:00");
  const session = await exchangeCode(creds, "code-1", { fetchFn, now: () => now });

  expect(request?.url).toBe("https://api.upstox.com/v2/login/authorization/token");
  expect(request?.init?.method).toBe("POST");
  expect(Object.fromEntries(new URLSearchParams(String(request?.init?.body)))).toEqual({
    code: "code-1",
    client_id: "my-key",
    client_secret: "my-secret",
    redirect_uri: "http://127.0.0.1:5000/callback",
    grant_type: "authorization_code",
  });
  expect(session).toEqual({
    broker: "upstox",
    userId: "AB1234",
    userName: "Test User",
    accessToken: "tok",
    issuedAt: now,
    expiresAt: istDateTime("2026-10-06", "03:30"),
  });
});

test("turns Upstox error responses into UpstoxError", async () => {
  const fetchFn: FetchFn = async () =>
    Response.json(
      { status: "error", errors: [{ errorCode: "UDAPI100057", message: "Invalid Auth code" }] },
      { status: 400 },
    );
  const err = await exchangeCode(creds, "bad", { fetchFn }).catch((e) => e);
  expect(err).toBeInstanceOf(UpstoxError);
  expect(err.message).toBe("Invalid Auth code (UDAPI100057)");
  expect(err.httpStatus).toBe(400);
  expect(err.code).toBe("UDAPI100057");
});

test("handles non-JSON errors and incomplete responses", async () => {
  const html: FetchFn = async () => new Response("<html>Bad gateway</html>", { status: 502 });
  expect((await exchangeCode(creds, "c", { fetchFn: html }).catch((e) => e)).message).toBe(
    "Upstox request failed with HTTP 502",
  );
  const partial: FetchFn = async () => Response.json({ user_id: "AB1234" });
  expect((await exchangeCode(creds, "c", { fetchFn: partial }).catch((e) => e)).message).toContain("missing access_token");
});
