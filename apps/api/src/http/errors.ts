import { type ApiError, AppError, ERROR_STATUS, type ErrorCode } from "@gem/shared";
import type { FastifyError, FastifyInstance } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";

function send(code: ErrorCode, params: ApiError["params"] = {}): { status: number; body: ApiError } {
  return { status: ERROR_STATUS[code], body: { code, params } };
}

/** Every error leaves the API as `{ code, params }` from the shared enum (SPEC §1.3), never prose. */
export function installErrorHandling(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    let out: { status: number; body: ApiError };
    if (error instanceof AppError) {
      out = { status: error.status, body: error.toJSON() };
    } else if (hasZodFastifySchemaValidationErrors(error)) {
      const first = error.validation[0];
      out = send("validation_failed", {
        context: error.validationContext ?? "body",
        field: first ? first.instancePath.replace(/^\//, "").replace(/\//g, ".") : "",
        issues: error.validation.length,
      });
    } else if (error.validation) {
      out = send("validation_failed", { context: error.validationContext ?? "body", issues: error.validation.length });
    } else if (error.statusCode === 429) {
      out = send("rate_limited");
    } else if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE" || error.statusCode === 413) {
      out = send("payload_too_large");
    } else if (error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" || error.statusCode === 415) {
      out = send("unsupported_media_type");
    } else if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      out = send("validation_failed", { reason: error.code ?? "bad_request" });
    } else {
      request.log.error({ err: error }, "unhandled error");
      out = send("internal");
    }
    if (out.body.code === "rate_limited" && "headers" in error && error.headers) {
      reply.headers(error.headers as Record<string, string>);
    }
    reply.status(out.status).send(out.body);
  });

  app.setNotFoundHandler((_request, reply) => {
    const { status, body } = send("route_not_found");
    reply.status(status).send(body);
  });
}
