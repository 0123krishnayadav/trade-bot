// Daily broker login: `bun run login` (add `--force` to replace a session that's still valid).
import { ConfigError, loadConfig } from "./config";
import { createLogger } from "./utils/logger";
import { formatIst } from "./utils/time";
import { migrate, openDatabase } from "./store/database";
import { migrations } from "./store/migrations";
import { SessionStore } from "./store/session-store";
import { createBrokerLogin } from "./brokers";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.log).child("login");
  const db = openDatabase(config.db.path);
  migrate(db, migrations);
  const sessions = new SessionStore(db);

  try {
    const existing = sessions.get(config.broker);
    if (existing && !process.argv.includes("--force")) {
      logger.info("already logged in", {
        broker: config.broker,
        userId: existing.userId,
        validUntil: formatIst(existing.expiresAt) + " IST",
      });
      return;
    }

    const session = await createBrokerLogin(config).login((url) => {
      console.log(`\nOpen this link to log in to ${config.broker}:\n\n  ${url}\n`);
      openBrowser(url);
    });
    sessions.save(session);
    logger.info("logged in", { broker: config.broker, userId: session.userId, validUntil: formatIst(session.expiresAt) + " IST" });
  } finally {
    db.close();
  }
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : undefined;
  if (!command || !process.stdout.isTTY) return;
  try {
    Bun.spawn([command, url], { stdout: "ignore", stderr: "ignore" });
  } catch {
    // No browser available (e.g. a server); the printed link still works.
  }
}

try {
  await main();
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : `Login failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
