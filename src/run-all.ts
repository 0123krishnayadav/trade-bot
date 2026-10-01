// `bun run all`: the bot and the dashboard together in one terminal, each still its own process.
// (`bun run scheduler` does the same, but starts and stops the bot by the market calendar.)
//
// - Output of each is prefixed ([bot] / [dashboard]); the bot also keeps writing its own log files.
// - Ctrl+C reaches both directly (the terminal signals every process in the foreground group), so
//   it is NOT forwarded again: the bot handles only one SIGINT, and a second would kill it before
//   it squares off. `kill <pid of this launcher>` (SIGTERM) is forwarded, once, to both.
// - If the dashboard exits, the bot keeps running. If the bot exits, the dashboard is stopped too.
import { SCRIPTS, startChild, tag } from "./process/child";

const say = (msg: string) => console.log(`${tag("run-all", 33)} ${msg}`);

const bot = startChild("bot", SCRIPTS.bot, 36);
const dashboard = startChild("dashboard", SCRIPTS.dashboard, 35);
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
