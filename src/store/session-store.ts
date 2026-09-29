import type { Database } from "bun:sqlite";
import type { BrokerSession } from "../core/types";

interface Row {
  broker: string;
  user_id: string;
  user_name: string | null;
  access_token: string;
  issued_at: string;
  expires_at: string;
}

/** Saves the current access token per broker, so a login lasts until the token expires. */
export class SessionStore {
  constructor(private readonly db: Database) {}

  save(s: BrokerSession): void {
    this.db
      .query(
        `INSERT INTO broker_sessions (broker, user_id, user_name, access_token, issued_at, expires_at)
         VALUES ($broker, $userId, $userName, $accessToken, $issuedAt, $expiresAt)
         ON CONFLICT (broker) DO UPDATE SET
           user_id = excluded.user_id, user_name = excluded.user_name, access_token = excluded.access_token,
           issued_at = excluded.issued_at, expires_at = excluded.expires_at`,
      )
      .run({
        broker: s.broker,
        userId: s.userId,
        userName: s.userName ?? null,
        accessToken: s.accessToken,
        issuedAt: s.issuedAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
      });
  }

  /** The session for `broker`, or undefined if there is none or it has expired. */
  get(broker: string, now: Date = new Date()): BrokerSession | undefined {
    const row = this.db.query("SELECT * FROM broker_sessions WHERE broker = $broker").get({ broker }) as Row | null;
    if (!row) return undefined;
    const session: BrokerSession = {
      broker: row.broker,
      userId: row.user_id,
      userName: row.user_name ?? undefined,
      accessToken: row.access_token,
      issuedAt: new Date(row.issued_at),
      expiresAt: new Date(row.expires_at),
    };
    return session.expiresAt > now ? session : undefined;
  }

  clear(broker: string): void {
    this.db.query("DELETE FROM broker_sessions WHERE broker = $broker").run({ broker });
  }
}
