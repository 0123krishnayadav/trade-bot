import { ConfigError, loadConfig } from "./config";
import { createLogger } from "./utils/logger";
import { migrate, openDatabase } from "./store/database";
import { migrations } from "./store/migrations";

function main(): void {
  const config = loadConfig();
  const logger = createLogger(config.log);

  const db = openDatabase(config.db.path);
  const applied = migrate(db, migrations);
  logger.info("trade-bot started", { env: config.appEnv, db: config.db.path, migrationsApplied: applied.length });

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
