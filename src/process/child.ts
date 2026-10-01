// Runs a script of this project as a child process, with its output prefixed by a name.
import type { Subprocess } from "bun";

export interface Child {
  readonly name: string;
  readonly pid: number;
  /** Resolves with the exit code when the process ends. */
  readonly exited: Promise<number>;
  /** null while running. */
  readonly exitCode: number | null;
  kill(signal: "SIGINT" | "SIGTERM"): void;
}

const color = process.stdout.isTTY;
export const tag = (name: string, code: number) => (color ? `\x1b[${code}m[${name}]\x1b[0m` : `[${name}]`);

/** `bun run <script>` in the same terminal (so Ctrl+C reaches it directly). */
export function startChild(name: string, script: string, colorCode: number): Child {
  const proc: Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn([process.execPath, "run", script], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const prefix = tag(name, colorCode);
  void pipeLines(proc.stdout, (line) => process.stdout.write(`${prefix} ${line}\n`));
  void pipeLines(proc.stderr, (line) => process.stderr.write(`${prefix} ${line}\n`));
  return {
    name,
    pid: proc.pid,
    exited: proc.exited,
    get exitCode() {
      return proc.exitCode;
    },
    kill: (signal) => proc.kill(signal),
  };
}

/** Calls `onLine` for each complete line of the stream. */
async function pipeLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const bytes of stream) {
    const lines = (rest + decoder.decode(bytes, { stream: true })).split("\n");
    rest = lines.pop()!;
    lines.forEach(onLine);
  }
  if (rest) onLine(rest);
}
