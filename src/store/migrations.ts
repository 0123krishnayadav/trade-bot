import type { Migration } from "./database";

/**
 * The bot's schema, in order. Later roadmap steps append here, e.g. the Upstox access token
 * table in step 5. Never edit a migration that has already run; add a new one instead.
 */
export const migrations: Migration[] = [];
