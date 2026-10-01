// `bun run build`: everything that runs in production, into dist/.
//   dist/*.js, dist/<area>/*.js  the bot, scheduler, dashboard server and CLIs (target bun, minified,
//                                source maps so stack traces show the original .ts lines)
//   dist/web/                    the dashboard page (see dashboard/build.ts)
// Run from the project root; start with `bun run start:prod` (the scheduler) or `bun dist/<entry>.js`.
import { rmSync } from "node:fs";
import { relative } from "node:path";
import { buildDashboardPage } from "./dashboard/build";

/** Every program `package.json` can start. Paths under src/ become the same paths under dist/. */
const ENTRIES = [
  "src/index.ts", // the bot
  "src/login.ts",
  "src/run-all.ts",
  "src/scheduler/index.ts",
  "src/dashboard/server.ts",
  "src/dashboard/setup.ts",
  "src/reports/cli.ts",
  "src/calendar/cli.ts",
];

const started = Date.now();
rmSync("dist", { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: ENTRIES,
  root: "src",
  outdir: "dist",
  target: "bun",
  splitting: true, // code shared by several programs goes into dist/chunks once
  minify: true,
  sourcemap: "linked",
  naming: { entry: "[dir]/[name].[ext]", chunk: "chunks/[name]-[hash].[ext]" },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`.padStart(10);
console.log(`built the backend in ${Date.now() - started} ms\n`);
for (const o of result.outputs) if (o.kind !== "sourcemap") console.log(`  ${relative(".", o.path).padEnd(40)}${kb(o.size)}`);
console.log("");

await buildDashboardPage();
