import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { StaticSite } from "../src/dashboard/static-site";

// A fake build: index.html, one hashed asset with .br/.gz copies, one without.
const dir = mkdtempSync(join(tmpdir(), "dashboard-dist-"));
mkdirSync(join(dir, "assets"));
const INDEX = '<!doctype html><script type="module" src="/assets/app-abc123.js"></script>';
const JS = "console.log('app')".repeat(50);
writeFileSync(join(dir, "index.html"), INDEX);
writeFileSync(join(dir, "index.html.br"), brotliCompressSync(INDEX));
writeFileSync(join(dir, "assets/app-abc123.js"), JS);
writeFileSync(join(dir, "assets/app-abc123.js.br"), brotliCompressSync(JS));
writeFileSync(join(dir, "assets/app-abc123.js.gz"), gzipSync(JS));
writeFileSync(join(dir, "assets/plain-x1.css"), "body{}");
writeFileSync(join(tmpdir(), "secret.txt"), "do not serve");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const site = new StaticSite(dir);
const get = (path: string, headers: Record<string, string> = {}) => site.serve(new Request(`http://localhost${path}`, { headers }));

test("hashed assets are cached for a year and sent compressed when accepted", async () => {
  const br = get("/assets/app-abc123.js", { "Accept-Encoding": "gzip, deflate, br" });
  expect(br.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(br.headers.get("content-encoding")).toBe("br");
  expect(br.headers.get("content-type")).toStartWith("text/javascript");
  expect(br.headers.get("vary")).toBe("Accept-Encoding");

  expect(get("/assets/app-abc123.js", { "Accept-Encoding": "gzip" }).headers.get("content-encoding")).toBe("gzip");
  const plain = get("/assets/app-abc123.js");
  expect(plain.headers.get("content-encoding")).toBeNull();
  expect(await plain.text()).toBe(JS);
  expect(get("/assets/plain-x1.css", { "Accept-Encoding": "br" }).headers.get("content-encoding")).toBeNull(); // no .br copy
});

test("every app route gets index.html, revalidated by ETag", async () => {
  const page = get("/history", { "Accept-Encoding": "br" });
  expect(page.headers.get("cache-control")).toBe("no-cache");
  expect(page.headers.get("content-type")).toStartWith("text/html");
  expect(page.headers.get("x-frame-options")).toBe("DENY");
  const etag = page.headers.get("etag")!;
  expect(etag).toMatch(/^"\w+"$/);
  expect(get("/").headers.get("etag")).toBe(etag);
  expect(await get("/login").text()).toBe(INDEX);

  const again = get("/", { "If-None-Match": etag });
  expect(again.status).toBe(304);
  expect(await again.text()).toBe("");
});

test("unknown assets are 404, and paths can't leave the build folder", async () => {
  expect(get("/assets/missing-zzz.js").status).toBe(404);
  for (const path of ["/../secret.txt", "/..%2fsecret.txt", "/assets/..%2f..%2fsecret.txt", "/%2e%2e/secret.txt"]) {
    const res = get(path);
    expect(await res.text()).not.toContain("do not serve");
  }
});

test("a missing build explains what to run", () => {
  expect(() => new StaticSite(join(dir, "nope"))).toThrow("Run `bun run build`");
});
