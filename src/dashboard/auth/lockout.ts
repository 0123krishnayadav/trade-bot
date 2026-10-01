/**
 * Locks login after too many failures in a row. One counter for everyone: there is a single user,
 * and per-IP counting would let an attacker spread guesses across addresses.
 */
export class LoginLockout {
  private failures = 0;
  private lockedUntil = 0;

  constructor(
    private readonly maxFailures = 5,
    private readonly lockMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Milliseconds until login is allowed again; 0 when not locked. */
  remainingMs(): number {
    return Math.max(0, this.lockedUntil - this.now());
  }

  recordFailure(): void {
    if (this.remainingMs() === 0 && this.lockedUntil !== 0) {
      this.lockedUntil = 0; // the previous lock has run out: start counting again
      this.failures = 0;
    }
    this.failures++;
    if (this.failures >= this.maxFailures) this.lockedUntil = this.now() + this.lockMs;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.lockedUntil = 0;
  }
}
