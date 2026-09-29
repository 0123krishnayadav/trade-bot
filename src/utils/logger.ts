import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { formatIst, istDate } from "./time";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** pretty: human-readable lines for the terminal. json: one object per line for log tools. */
export const LOG_FORMATS = ["pretty", "json"] as const;
export type LogFormat = (typeof LOG_FORMATS)[number];

export type LogData = Record<string, unknown>;

export interface Logger {
  debug(message: string, data?: LogData): void;
  info(message: string, data?: LogData): void;
  warn(message: string, data?: LogData): void;
  error(message: string, data?: LogData): void;
  /** Logger that tags every line with a module name, e.g. logger.child("upstox"). */
  child(module: string): Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  format: LogFormat;
  module?: string;
  clock?: () => Date;
  write?: (line: string, level: LogLevel) => void;
  /** Also append every line to <dir>/<YYYY-MM-DD>.log (IST date; a new file each day). */
  fileDir?: string;
}

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values never reach the logs: tokens, secrets, passwords, API keys. */
const SENSITIVE_KEY = /token|secret|password|passwd|api_?key|authorization|cookie/i;

function defaultWrite(line: string, level: LogLevel): void {
  if (level === "warn" || level === "error") console.error(line);
  else console.log(line);
}

/**
 * Appends lines to a file per IST day. Writes are synchronous so nothing is lost if the process
 * dies; at a few lines per second that costs nothing noticeable.
 */
export function dailyFileWriter(dir: string, clock: () => Date = () => new Date()): (line: string) => void {
  mkdirSync(dir, { recursive: true });
  return (line) => appendFileSync(join(dir, `${istDate(clock())}.log`), line + "\n");
}

function serialize(data: LogData): string {
  return JSON.stringify(data, (key, value) => {
    if (key && SENSITIVE_KEY.test(key)) return "[redacted]";
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
    if (typeof value === "bigint") return value.toString();
    return value;
  });
}

export function createLogger(opts: LoggerOptions): Logger {
  const clock = opts.clock ?? (() => new Date());
  const toFile = opts.fileDir ? dailyFileWriter(opts.fileDir, clock) : undefined;
  const toConsole = opts.write ?? defaultWrite;
  const write = toFile
    ? (line: string, level: LogLevel) => {
        toConsole(line, level);
        toFile(line);
      }
    : toConsole;

  const log = (level: LogLevel, message: string, data?: LogData) => {
    if (SEVERITY[level] < SEVERITY[opts.level]) return;
    const now = clock();
    if (opts.format === "json") {
      write(serialize({ ts: now.toISOString(), level, module: opts.module, msg: message, ...data }), level);
      return;
    }
    const module = opts.module ? ` [${opts.module}]` : "";
    const extra = data && Object.keys(data).length ? ` ${serialize(data)}` : "";
    write(`${formatIst(now)} ${level.toUpperCase().padEnd(5)}${module} ${message}${extra}`, level);
  };

  return {
    debug: (message, data) => log("debug", message, data),
    info: (message, data) => log("info", message, data),
    warn: (message, data) => log("warn", message, data),
    error: (message, data) => log("error", message, data),
    child: (module) => createLogger({ ...opts, fileDir: undefined, write, module: opts.module ? `${opts.module}:${module}` : module }),
  };
}
