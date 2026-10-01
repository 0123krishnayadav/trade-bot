export const MIN_PASSWORD_LENGTH = 16;
export const PIN_LENGTH = 6;

export function isValidPin(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);
}

/** argon2id hash, base64-encoded for .env (raw hashes contain `$`, which .env would expand). */
export async function hashForEnv(secret: string): Promise<string> {
  return Buffer.from(await Bun.password.hash(secret, "argon2id")).toString("base64");
}

/**
 * True only if both match. Both hashes are always checked, so the response time doesn't reveal
 * which one was wrong.
 */
export async function verifyCredentials(password: string, pin: string, hashes: { passwordHash: string; pinHash: string }): Promise<boolean> {
  const [passwordOk, pinOk] = await Promise.all([
    Bun.password.verify(password, hashes.passwordHash).catch(() => false),
    Bun.password.verify(pin, hashes.pinHash).catch(() => false),
  ]);
  return passwordOk && pinOk;
}
