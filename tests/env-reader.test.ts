import { expect, test } from "bun:test";
import { ConfigError, EnvReader } from "../src/config/env";

function problems(read: (r: EnvReader) => void, env: Record<string, string>): string[] {
  const r = new EnvReader(env);
  read(r);
  try {
    r.done();
    return [];
  } catch (err) {
    return (err as ConfigError).problems;
  }
}

test("required values", () => {
  expect(problems((r) => r.string("API_KEY"), {})).toEqual(["API_KEY is required"]);
  expect(problems((r) => r.string("API_KEY"), { API_KEY: "   " })).toEqual(["API_KEY is required"]);
  expect(new EnvReader({ API_KEY: "abc" }).string("API_KEY")).toBe("abc");
});

test("numbers", () => {
  expect(new EnvReader({ LOTS: "2" }).number("LOTS", 1, { integer: true, min: 1 })).toBe(2);
  expect(problems((r) => r.number("LOTS", 1), { LOTS: "two" })).toEqual(['LOTS must be a number (got "two")']);
  expect(problems((r) => r.number("LOTS", 1, { integer: true }), { LOTS: "1.5" })).toEqual(['LOTS must be a whole number (got "1.5")']);
  expect(problems((r) => r.number("LOTS", 1, { min: 1 }), { LOTS: "0" })).toEqual(["LOTS must be >= 1 (got 0)"]);
  expect(problems((r) => r.number("PCT", 1, { max: 100 }), { PCT: "101" })).toEqual(["PCT must be <= 100 (got 101)"]);
});

test("booleans", () => {
  expect(new EnvReader({ X: "YES" }).boolean("X")).toBe(true);
  expect(new EnvReader({ X: "0" }).boolean("X")).toBe(false);
  expect(new EnvReader({}).boolean("X", true)).toBe(true);
  expect(problems((r) => r.boolean("X"), { X: "maybe" })).toEqual(['X must be true or false (got "maybe")']);
});
