import { UpstoxHttp } from "../src/brokers/upstox/http";

export interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: unknown;
}

/** UpstoxHttp backed by a queue of canned responses; records every request. */
export function fakeUpstox(responses: (Response | Error)[] = [], opts: { token?: string } = {}) {
  const calls: Call[] = [];
  const slept: number[] = [];
  const http = new UpstoxHttp({
    getAccessToken: () => ("token" in opts ? opts.token : "test-token"),
    fetchFn: async (url, init) => {
      calls.push({
        method: init?.method ?? "GET",
        url: new URL(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const next = responses.shift();
      if (!next) throw new Error("no fake response left");
      if (next instanceof Error) throw next;
      return next;
    },
    sleep: async (ms) => void slept.push(ms),
  });
  return { http, calls, slept };
}

export const ok = (data: unknown, extra: Record<string, unknown> = {}) => Response.json({ status: "success", data, ...extra });
export const fail = (status: number, errorCode: string, message: string) =>
  Response.json({ status: "error", errors: [{ errorCode, message }] }, { status });
