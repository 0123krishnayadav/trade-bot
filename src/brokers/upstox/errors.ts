/** One entry of Upstox's `errors` array. Upstox uses both camelCase and snake_case keys. */
export interface UpstoxApiError {
  errorCode?: string;
  error_code?: string;
  message?: string;
  propertyPath?: string;
  property_path?: string;
  invalidValue?: unknown;
  invalid_value?: unknown;
  instrument_key?: string;
  order_id?: string;
}

/** Upstox's error body: {"status":"error","errors":[{"errorCode":"UDAPI100057","message":"..."}]} */
interface UpstoxErrorBody {
  status?: string;
  errors?: UpstoxApiError[];
}

export class UpstoxError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code?: string,
    readonly errors: UpstoxApiError[] = [],
  ) {
    super(message);
    this.name = "UpstoxError";
  }

  static fromResponse(httpStatus: number, body: unknown): UpstoxError {
    const errors = (body as UpstoxErrorBody | undefined)?.errors ?? [];
    const first = errors[0];
    const code = first?.errorCode ?? first?.error_code;
    const message = first?.message ?? `Upstox request failed with HTTP ${httpStatus}`;
    const full = code ? `${message} (${code})` : message;
    return httpStatus === 401
      ? new UpstoxAuthError(`${full}. The session has probably expired; run \`bun run login\`.`, code, errors)
      : new UpstoxError(full, httpStatus, code, errors);
  }
}

/** Missing, invalid or expired access token. Retrying won't help; the user must log in again. */
export class UpstoxAuthError extends UpstoxError {
  constructor(message: string, code?: string, errors: UpstoxApiError[] = []) {
    super(message, 401, code, errors);
    this.name = "UpstoxAuthError";
  }
}
