// `bun run dashboard:setup`: asks for the dashboard password and PIN and prints the .env lines.
// Only hashes are printed; the password and PIN themselves are never stored.
import { randomBytes } from "node:crypto";
import { hashForEnv, isValidPin, MIN_PASSWORD_LENGTH, PIN_LENGTH } from "./auth/credentials";

/** Reads a line from the terminal without echoing it. */
function readHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Error("run this in a terminal");
  process.stdout.write(question);
  return new Promise((resolve) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.off("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write("\n");
          return resolve(value);
        }
        if (ch === "\u0003") process.exit(130); // Ctrl+C
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function ask(label: string, check: (v: string) => string | undefined): Promise<string> {
  for (;;) {
    const value = await readHidden(`${label}: `);
    const problem = check(value);
    if (problem) {
      console.log(`  ${problem}`);
      continue;
    }
    if ((await readHidden(`${label} again: `)) === value) return value;
    console.log("  they don't match, try again");
  }
}

const password = await ask("Dashboard password (paste from your password manager)", (v) =>
  v.length < MIN_PASSWORD_LENGTH ? `use at least ${MIN_PASSWORD_LENGTH} characters` : undefined,
);
const pin = await ask(`PIN (${PIN_LENGTH} digits)`, (v) => (isValidPin(v) ? undefined : `must be exactly ${PIN_LENGTH} digits`));

console.log(`
Add these to .env (replacing any old lines with the same names), then run \`bun run dashboard\`:

DASHBOARD_PASSWORD_HASH=${await hashForEnv(password)}
DASHBOARD_PIN_HASH=${await hashForEnv(pin)}
DASHBOARD_SESSION_SECRET=${randomBytes(32).toString("base64url")}
`);
