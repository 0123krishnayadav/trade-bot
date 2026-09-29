import { ConfigError, loadConfig } from "./config";
import { createLogger } from "./utils/logger";
import { formatIst } from "./utils/time";
import { migrate, openDatabase } from "./store/database";
import { migrations } from "./store/migrations";
import { SessionStore } from "./store/session-store";

function main(): void {
  const config = loadConfig();
  const logger = createLogger(config.log);

  const db = openDatabase(config.db.path);
  const applied = migrate(db, migrations);
  logger.info("trade-bot started", { env: config.appEnv, db: config.db.path, migrationsApplied: applied.length });

  const session = new SessionStore(db).get(config.broker);
  if (session) {
    logger.info("broker session ok", { broker: config.broker, userId: session.userId, validUntil: formatIst(session.expiresAt) + " IST" });
  }
  else logger.warn("no valid broker session, run `bun run login`", { broker: config.broker });

  db.close();
}

try {
  main();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
