import { expect, test } from "bun:test";
import { migrate, openDatabase } from "../src/store/database";
import { migrations } from "../src/store/migrations";
import type { BrokerSession } from "../src/core/types";
import { SessionStore } from "../src/store/session-store";

function store() {
  const db = openDatabase(":memory:");
  migrate(db, migrations);
  return new SessionStore(db);
}

const session: BrokerSession = {
  broker: "upstox",
  userId: "AB1234",
  userName: "Test User",
  accessToken: "token-1",
  issuedAt: new Date("2026-10-05T03:40:00Z"),
  expiresAt: new Date("2026-10-05T22:00:00Z"),
};

test("saves and loads a session", () => {
  const s = store();
  s.save(session);
  expect(s.get("upstox", new Date("2026-10-05T10:00:00Z"))).toEqual(session);
  expect(s.get("zerodha")).toBeUndefined();
});

test("a new login replaces the old one", () => {
  const s = store();
  s.save(session);
  s.save({ ...session, accessToken: "token-2", userName: undefined });
  const loaded = s.get("upstox", new Date("2026-10-05T10:00:00Z"));
  expect(loaded?.accessToken).toBe("token-2");
  expect(loaded?.userName).toBeUndefined();
});

test("expired sessions are not returned", () => {
  const s = store();
  s.save(session);
  expect(s.get("upstox", new Date("2026-10-05T22:00:00Z"))).toBeUndefined();
});

test("clear removes the session", () => {
  const s = store();
  s.save(session);
  s.clear("upstox");
  expect(s.get("upstox", new Date("2026-10-05T10:00:00Z"))).toBeUndefined();
});
