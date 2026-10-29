import { z } from "zod";

/**
 * Every error the API can return (SPEC §1.3). The API sends `{ code, params }`,
 * never prose; the web app maps each code to `errors:<code>` in the catalog.
 */
export const ERROR_CODES = [
  "internal",
  "validation_failed",
  "not_found",
  "route_not_found",
  "unauthenticated",
  "forbidden",
  "rate_limited",
  "payload_too_large",
  "unsupported_media_type",
  "auth_invalid_credentials",
  "auth_account_locked",
  "auth_account_disabled",
  "auth_registration_disabled",
  "auth_email_taken",
  "auth_password_too_long",
  "auth_password_too_short",
  "import_empty",
  "import_too_large",
  "import_invalid_quiz",
  "test_not_found",
  "user_not_found",
  "admin_last_admin",
  "service_unavailable",
] as const;

export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorParams = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
export type ErrorParams = z.infer<typeof ErrorParams>;

export const ApiError = z.object({
  code: ErrorCode,
  params: ErrorParams,
});
export type ApiError = z.infer<typeof ApiError>;

/** HTTP status per error code. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  internal: 500,
  validation_failed: 400,
  not_found: 404,
  route_not_found: 404,
  unauthenticated: 401,
  forbidden: 403,
  rate_limited: 429,
  payload_too_large: 413,
  unsupported_media_type: 415,
  auth_invalid_credentials: 401,
  auth_account_locked: 423,
  auth_account_disabled: 403,
  auth_registration_disabled: 403,
  auth_email_taken: 409,
  auth_password_too_long: 400,
  auth_password_too_short: 400,
  import_empty: 400,
  import_too_large: 413,
  import_invalid_quiz: 422,
  test_not_found: 404,
  user_not_found: 404,
  admin_last_admin: 409,
  service_unavailable: 503,
};

/** The only error type route handlers throw (SPEC §11.6, companion check). */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly params: ErrorParams;
  readonly status: number;

  constructor(code: ErrorCode, params: ErrorParams = {}) {
    super(code);
    this.name = "AppError";
    this.code = code;
    this.params = params;
    this.status = ERROR_STATUS[code];
  }

  toJSON(): ApiError {
    return { code: this.code, params: this.params };
  }
}
