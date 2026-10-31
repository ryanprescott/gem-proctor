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
  "test_archived",
  "practice_attempt_in_progress",
  "practice_attempt_submitted",
  "practice_attempt_not_submitted",
  "practice_answer_locked",
  "practice_nothing_to_retake",
  "practice_question_not_in_attempt",
  "practice_self_grade_not_allowed",
  "llm_role_unassigned",
  "llm_cloud_blocked",
  "llm_cloud_roles_assigned",
  "llm_endpoint_unreachable",
  "llm_endpoint_auth",
  "llm_endpoint_timeout",
  "llm_endpoint_error",
  "llm_endpoint_in_use",
  "llm_models_unsupported",
  "llm_output_invalid",
  "llm_output_incomplete",
  "llm_context_exceeded",
  "llm_embedding_truncated",
  "llm_secret_key_missing",
  "llm_eval_running",
  "verify_unavailable",
  "verify_program_too_large",
  "verify_job_not_found",
  "verify_fix_invalid",
  "source_not_found",
  "source_empty",
  "source_too_large",
  "source_bad_type",
  "source_not_ready",
  "knowledge_unit_too_large",
  "knowledge_dimension_mismatch",
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
  test_archived: 409,
  practice_attempt_in_progress: 409,
  practice_attempt_submitted: 409,
  practice_attempt_not_submitted: 409,
  practice_answer_locked: 409,
  practice_nothing_to_retake: 409,
  practice_question_not_in_attempt: 404,
  practice_self_grade_not_allowed: 409,
  llm_role_unassigned: 409,
  llm_cloud_blocked: 409,
  llm_cloud_roles_assigned: 409,
  llm_endpoint_unreachable: 502,
  llm_endpoint_auth: 502,
  llm_endpoint_timeout: 504,
  llm_endpoint_error: 502,
  llm_endpoint_in_use: 409,
  llm_models_unsupported: 409,
  llm_output_invalid: 502,
  llm_output_incomplete: 502,
  llm_context_exceeded: 422,
  llm_embedding_truncated: 422,
  llm_secret_key_missing: 409,
  llm_eval_running: 409,
  verify_unavailable: 503,
  verify_program_too_large: 422,
  verify_job_not_found: 404,
  verify_fix_invalid: 422,
  source_not_found: 404,
  source_empty: 400,
  source_too_large: 413,
  source_bad_type: 415,
  source_not_ready: 409,
  knowledge_unit_too_large: 422,
  knowledge_dimension_mismatch: 409,
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
