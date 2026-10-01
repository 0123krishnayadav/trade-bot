import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Where `bun run build` / `dashboard:build` put the page. Not dist/dashboard: that holds server code. */
export const WEB_DIST_DIR = process.env.DASHBOARD_DIST ?? "./dist/web";

/** Content-hashed files: they never change under the same name, so browsers may keep them a year. */
const IMMUTABLE = "public, max-age=31536000, immutable";
/** index.html: always ask the server (a cheap 304 when unchanged), so a new build is picked up at once. */
const REVALIDATE = "no-cache";
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

interface SiteFile {
  path: string;
  type: string;
  /** Pre-compressed copies written by the build, by Content-Encoding. */
  encoded: { br?: string; gzip?: string };
}

/**
 * Serves the built dashboard (see build.ts) from memory-mapped files: hashed assets with a
 * one-year immutable cache, index.html for every other path (the React app routes itself) with
 * revalidation via ETag, brotli or gzip when the browser accepts it. Only files that existed at
 * startup can be served, so a request path can never reach outside the build folder.
 */
export class StaticSite {
  private readonly files = new Map<string, SiteFile>();
  private readonly indexEtag: string;

  constructor(private readonly dir: string) {
    let names: string[];
    try {
      names = walk(dir);
    } catch {
      throw new Error(`No dashboard build in ${dir}. Run \`bun run build\` (or \`bun run dashboard:build\`) first.`);
    }
    const all = new Set(names);
    for (const name of names) {
      if (name.endsWith(".gz") || name.endsWith(".br")) continue;
      const path = join(dir, name);
      this.files.set(name, {
        path,
        type: Bun.file(path).type,
        encoded: {
          ...(all.has(`${name}.br`) ? { br: `${path}.br` } : {}),
          ...(all.has(`${name}.gz`) ? { gzip: `${path}.gz` } : {}),
        },
      });
    }
    if (!this.files.has("index.html")) throw new Error(`No index.html in ${dir}. Run \`bun run dashboard:build\` first.`);
    // Strong ETag from the content: it changes exactly when a new build changes the page.
    this.indexEtag = `"${Bun.hash(readFileSync(join(dir, "index.html"))).toString(36)}"`;
  }

  /** Every non-API request: a known asset, or the app's index.html. */
  serve(req: Request): Response {
    const name = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, "");
    const file = this.files.get(name);
    if (file && name !== "index.html") return this.send(req, file, name.startsWith("assets/") ? IMMUTABLE : REVALIDATE);
    if (name.startsWith("assets/")) return new Response("not found", { status: 404, headers: { "Cache-Control": "no-store" } });

    if (req.headers.get("if-none-match") === this.indexEtag) {
      return new Response(null, { status: 304, headers: { ETag: this.indexEtag, "Cache-Control": REVALIDATE } });
    }
    const response = this.send(req, this.files.get("index.html")!, REVALIDATE);
    response.headers.set("ETag", this.indexEtag);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) response.headers.set(k, v);
    return response;
  }

  private send(req: Request, file: SiteFile, cacheControl: string): Response {
    const accepts = req.headers.get("accept-encoding") ?? "";
    const encoding = file.encoded.br && /\bbr\b/.test(accepts) ? "br" : file.encoded.gzip && /\bgzip\b/.test(accepts) ? "gzip" : undefined;
    const headers: Record<string, string> = { "Content-Type": file.type, "Cache-Control": cacheControl, Vary: "Accept-Encoding" };
    if (encoding) headers["Content-Encoding"] = encoding;
    return new Response(Bun.file(encoding ? file.encoded[encoding]! : file.path), { headers });
  }
}

/** Relative paths of every file under `dir`. */
function walk(dir: string, root = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path, root) : [relative(root, path)];
  });
}
