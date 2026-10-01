import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "tb_session";

interface Payload {
  /** Session id, so a single session can be revoked on logout. */
  sid: string;
  /** Expiry, ms since epoch. */
  exp: number;
}

/**
 * Sessions are signed cookies (payload.signature), so they survive a dashboard restart without a
 * database table. Logged-out session ids are remembered until they would have expired anyway.
 */
export class SessionManager {
  private readonly revoked = new Map<string, number>();

  constructor(
    private readonly secret: string,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  create(): { token: string; expiresAt: Date } {
    const payload: Payload = { sid: randomBytes(16).toString("base64url"), exp: this.now() + this.ttlMs };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return { token: `${body}.${this.sign(body)}`, expiresAt: new Date(payload.exp) };
  }

  /** The session's payload if the token is genuine, unexpired and not logged out. */
  verify(token: string | null | undefined): Payload | undefined {
    if (!token) return undefined;
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra !== undefined) return undefined;
    const expected = Buffer.from(this.sign(body));
    const actual = Buffer.from(signature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
    let payload: Payload;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return undefined;
    }
    if (typeof payload.exp !== "number" || payload.exp <= this.now() || this.revoked.has(payload.sid)) return undefined;
    return payload;
  }

  revoke(token: string | null | undefined): void {
    const payload = this.verify(token);
    if (payload) this.revoked.set(payload.sid, payload.exp);
    for (const [sid, exp] of this.revoked) if (exp <= this.now()) this.revoked.delete(sid);
  }

  private sign(body: string): string {
    return createHmac("sha256", this.secret).update(body).digest("base64url");
  }
}
