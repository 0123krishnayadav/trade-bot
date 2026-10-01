// `bun run dashboard:build`: bundles the React app once into dist/web (minified, React's production
// build, content-hashed asset names) and pre-compresses every file with brotli and gzip, so
// `bun run dashboard` only serves files and starts instantly. `bun run build` calls this too.
import { rmSync } from "node:fs";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { relative } from "node:path";
import { WEB_DIST_DIR } from "./static-site";

/** Hashed file names live here; the server caches them forever. */
const ASSETS_PREFIX = "assets/";

export async function buildDashboardPage(outdir: string = WEB_DIST_DIR): Promise<void> {
  const started = Date.now();
  rmSync(outdir, { recursive: true, force: true });
  const result = await Bun.build({
    entrypoints: ["src/dashboard/web/index.html"],
    outdir: outdir,
    target: "browser",
    minify: true,
    sourcemap: "linked",
    publicPath: "/",
    naming: { entry: "[name].[ext]", chunk: `${ASSETS_PREFIX}[name]-[hash].[ext]`, asset: `${ASSETS_PREFIX}[name]-[hash].[ext]` },
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }

  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`.padStart(10);
  console.log(`built ${outdir} in ${Date.now() - started} ms\n`);
  console.log(`${"file".padEnd(36)}${"raw".padStart(10)}${"gzip".padStart(10)}${"brotli".padStart(10)}`);
  for (const output of result.outputs) {
    if (output.path.endsWith(".map")) continue; // only fetched by devtools
    const bytes = new Uint8Array(await Bun.file(output.path).arrayBuffer());
    const gz = gzipSync(bytes, { level: 9 });
    const br = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } });
    await Bun.write(`${output.path}.gz`, gz);
    await Bun.write(`${output.path}.br`, br);
    console.log(`${relative(outdir, output.path).padEnd(36)}${kb(bytes.length)}${kb(gz.length)}${kb(br.length)}`);
  }
}

if (import.meta.main) await buildDashboardPage();
