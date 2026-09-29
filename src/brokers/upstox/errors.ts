/** Upstox's error body: {"status":"error","errors":[{"errorCode":"UDAPI100057","message":"..."}]} */
interface UpstoxErrorBody {
  status?: string;
  errors?: { errorCode?: string; error_code?: string; message?: string }[];
}

export class UpstoxError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "UpstoxError";
  }

  static fromResponse(httpStatus: number, body: unknown): UpstoxError {
    const first = (body as UpstoxErrorBody | undefined)?.errors?.[0];
    const code = first?.errorCode ?? first?.error_code;
    const message = first?.message ?? `Upstox request failed with HTTP ${httpStatus}`;
    return new UpstoxError(code ? `${message} (${code})` : message, httpStatus, code);
  }
}
