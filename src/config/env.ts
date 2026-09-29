export type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}\nSee .env.example for all settings.`);
    this.name = "ConfigError";
  }
}

/**
 * Reads typed values from environment variables. Problems are collected rather than thrown one
 * at a time, so a misconfigured deploy reports everything wrong in a single run; call done()
 * after reading to throw them.
 */
export class EnvReader {
  private readonly problems: string[] = [];

  constructor(private readonly env: Env) {}

  /** Required when no fallback is given. Empty strings count as missing. */
  string(name: string, fallback?: string): string {
    const raw = this.raw(name);
    if (raw !== undefined) return raw;
    if (fallback !== undefined) return fallback;
    this.problems.push(`${name} is required`);
    return "";
  }

  number(name: string, fallback?: number, opts: { min?: number; max?: number; integer?: boolean } = {}): number {
    const raw = this.raw(name);
    if (raw === undefined) {
      if (fallback !== undefined) return fallback;
      this.problems.push(`${name} is required`);
      return 0;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) this.problems.push(`${name} must be a number (got "${raw}")`);
    else if (opts.integer && !Number.isInteger(value)) this.problems.push(`${name} must be a whole number (got "${raw}")`);
    else if (opts.min !== undefined && value < opts.min) this.problems.push(`${name} must be >= ${opts.min} (got ${value})`);
    else if (opts.max !== undefined && value > opts.max) this.problems.push(`${name} must be <= ${opts.max} (got ${value})`);
    return value;
  }

  boolean(name: string, fallback?: boolean): boolean {
    const raw = this.raw(name)?.toLowerCase();
    if (raw === undefined) {
      if (fallback !== undefined) return fallback;
      this.problems.push(`${name} is required`);
      return false;
    }
    if (["true", "1", "yes"].includes(raw)) return true;
    if (["false", "0", "no"].includes(raw)) return false;
    this.problems.push(`${name} must be true or false (got "${raw}")`);
    return false;
  }

  oneOf<const T extends string>(name: string, allowed: readonly T[], fallback?: T): T {
    const raw = this.raw(name);
    if (raw === undefined) {
      if (fallback !== undefined) return fallback;
      this.problems.push(`${name} is required (one of ${allowed.join(", ")})`);
      return allowed[0]!;
    }
    if (allowed.includes(raw as T)) return raw as T;
    this.problems.push(`${name} must be one of ${allowed.join(", ")} (got "${raw}")`);
    return allowed[0]!;
  }

  /** An absolute URL; `protocols` restricts the scheme, e.g. ["http:", "https:"]. */
  url(name: string, fallback?: string, protocols: string[] = ["http:", "https:"]): string {
    const value = this.string(name, fallback);
    if (!value) return value;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      this.problems.push(`${name} must be a full URL like http://127.0.0.1:5000/callback (got "${value}")`);
      return value;
    }
    if (!protocols.includes(parsed.protocol)) {
      this.problems.push(`${name} must start with ${protocols.map((p) => `${p}//`).join(" or ")} (got "${value}")`);
    }
    return value;
  }

  /** Comma-separated dates (YYYY-MM-DD); empty when unset. */
  dateList(name: string): string[] {
    const raw = this.raw(name);
    if (raw === undefined) return [];
    const dates = raw.split(",").map((d) => d.trim()).filter(Boolean);
    const bad = dates.filter((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)));
    if (bad.length) this.problems.push(`${name} must be comma-separated YYYY-MM-DD dates (bad: ${bad.join(", ")})`);
    return dates;
  }

  /** Adds a problem found by a check across several settings. */
  fail(problem: string): void {
    this.problems.push(problem);
  }

  done(): void {
    if (this.problems.length) throw new ConfigError(this.problems);
  }

  private raw(name: string): string | undefined {
    const value = this.env[name]?.trim();
    return value === "" ? undefined : value;
  }
}
