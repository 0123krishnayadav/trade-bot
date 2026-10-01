// `bun run all`: the bot and the dashboard together in one terminal, each still its own process.
//
// - Output of each is prefixed ([bot] / [dashboard]); the bot also keeps writing its own log files.
// - Ctrl+C reaches both directly (the terminal signals every process in the foreground group), so
//   it is NOT forwarded again: the bot handles only one SIGINT, and a second would kill it before
//   it squares off. `kill <pid of this launcher>` (SIGTERM) is forwarded, once, to both.
// - If the dashboard exits, the bot keeps running. If the bot exits, the dashboard is stopped too.
import type { Subprocess } from "bun";

const color = process.stdout.isTTY;
const tag = (name: string, code: number) => (color ? `\x1b[${code}m[${name}]\x1b[0m` : `[${name}]`);

function start(name: string, script: string, colorCode: number): Subprocess<"ignore", "pipe", "pipe"> {
  const child = Bun.spawn([process.execPath, "run", script], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env });
  const prefix = tag(name, colorCode);
  void pipeLines(child.stdout, (line) => process.stdout.write(`${prefix} ${line}\n`));
  void pipeLines(child.stderr, (line) => process.stderr.write(`${prefix} ${line}\n`));
  return child;
}

/** Calls `onLine` for each complete line of the stream. */
async function pipeLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const bytes of stream) {
    const lines = (rest + decoder.decode(bytes, { stream: true })).split("\n");
    rest = lines.pop()!;
    lines.forEach(onLine);
  }
  if (rest) onLine(rest);
}

const say = (msg: string) => console.log(`${tag("run-all", 33)} ${msg}`);

const bot = start("bot", "src/index.ts", 36);
const dashboard = start("dashboard", "src/dashboard/server.ts", 35);
say(`bot pid ${bot.pid}, dashboard pid ${dashboard.pid}; Ctrl+C stops both (the bot squares off first)`);

let stopping = false;
process.on("SIGINT", () => {
  // The children got this Ctrl+C themselves; just wait for them.
  if (!stopping) say("stopping: waiting for the bot to square off and exit…");
  stopping = true;
});
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  say("SIGTERM: stopping both…");
  bot.kill("SIGTERM");
  dashboard.kill("SIGTERM");
});

void dashboard.exited.then((code) => {
  if (!stopping) say(`dashboard exited (code ${code}); the bot keeps running`);
});

const botCode = await bot.exited;
if (!stopping) say(`bot exited (code ${botCode}); stopping the dashboard`);
if (dashboard.exitCode === null) dashboard.kill("SIGTERM");
await dashboard.exited;
process.exit(botCode);
