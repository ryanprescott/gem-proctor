import { AppError, type ErrorCode, type ErrorParams } from "@gem/shared";

export type LlmErrorCode = Extract<ErrorCode, `llm_${string}`>;

/** Every model failure the runtime raises (P1.5.md §5). An `AppError`, so it leaves the API as `{ code, params }`. */
export class LlmError extends AppError {
  constructor(code: LlmErrorCode, params: ErrorParams = {}) {
    super(code, params);
    this.name = "LlmError";
  }
}

const statusOf = (e: object): number | undefined =>
  "statusCode" in e && typeof e.statusCode === "number" ? e.statusCode : undefined;

/** The SDK's and fetch's errors, as `LlmError`. Nothing else may leave the runtime. */
export function toLlmError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  if (typeof err !== "object" || err === null) return new LlmError("llm_endpoint_error");
  // With `maxRetries: 0` the SDK rethrows the last error; a `RetryError` wraps it otherwise.
  if ("lastError" in err && err.lastError) return toLlmError(err.lastError);
  const status = statusOf(err);
  if (status === 401 || status === 403) return new LlmError("llm_endpoint_auth", { status });
  if (status !== undefined) return new LlmError("llm_endpoint_error", { status });
  const name = "name" in err ? String(err.name) : "";
  // APICallError without a status: the request never got an answer (refused, reset, DNS).
  if (name === "AI_APICallError" || name === "TypeError" || "code" in err)
    return new LlmError("llm_endpoint_unreachable");
  return new LlmError("llm_endpoint_error");
}
