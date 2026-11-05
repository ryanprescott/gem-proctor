import { timingSafeEqual } from "node:crypto";
import { SourceFile } from "@gem/db";
import { AppError } from "@gem/shared";
import {
  sourcesFilesCreate,
  sourcesFilesDelete,
  sourcesFilesEvents,
  sourcesFilesGet,
  sourcesFilesOriginal,
  sourcesFilesRetry,
} from "@gem/shared/contracts";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { createFile, deleteFile, fileDetail, fileTopic, loadFile, retryFile } from "../convert.ts";
import { streamState } from "../events.ts";
import { route } from "../http/route.ts";
import { requestMeta } from "./auth.ts";

/** Above any `maxFileBytes` an admin can set; the setting itself is checked in the handler. */
const BODY_LIMIT = 520 * 1024 * 1024;
const UPLOADS_PER_MINUTE = 10;

/** The shared secret, compared without leaking where it differs. */
function secretMatches(given: string | undefined, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sourceFilesRoutes(app: FastifyInstance, ctx: AppContext) {
  // The PDF is the whole body, not a form: the size is checked against the instance setting after it arrives.
  app.addContentTypeParser("application/pdf", { parseAs: "buffer", bodyLimit: BODY_LIMIT }, (_req, body, done) =>
    done(null, body),
  );

  route(
    app,
    sourcesFilesCreate,
    async ({ query, body, user, request }) => {
      const file = await createFile(
        ctx,
        {
          pdf: body as Buffer,
          filename: query.filename,
          options: { pageRange: query.pageRange, strategy: query.strategy },
        },
        user.userId,
        requestMeta(request),
      );
      return { file };
    },
    {
      bodyLimit: BODY_LIMIT,
      rateLimit: {
        max: ctx.config.UPLOAD_RATE_LIMIT_MAX ?? UPLOADS_PER_MINUTE,
        timeWindow: 60_000,
        hook: "preHandler",
        keyGenerator: (request) => request.user?.userId ?? request.ip,
      },
    },
  );

  route(app, sourcesFilesGet, async ({ params }) => ({ file: await fileDetail(ctx, params.id) }));

  route(app, sourcesFilesEvents, async ({ params, query, request, reply }) =>
    streamState(
      ctx.events,
      fileTopic(params.id),
      request,
      reply,
      async () => ({ file: await fileDetail(ctx, params.id) }),
      query.once === "true",
    ),
  );

  route(app, sourcesFilesRetry, async ({ params }) => ({ file: await retryFile(ctx, params.id) }));

  route(app, sourcesFilesDelete, async ({ params, user, request }) => {
    await deleteFile(ctx, params.id, user.userId, requestMeta(request));
    return { ok: true as const };
  });

  route(app, sourcesFilesOriginal, async ({ params, reply }) => {
    const [row] = await ctx.db
      .select({ content: SourceFile.content, filename: SourceFile.filename })
      .from(SourceFile)
      .where(eq(SourceFile.id, (await loadFile(ctx, params.id)).id));
    if (!row) throw new AppError("convert_file_not_found");
    reply.header("content-type", "application/pdf");
    reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`);
    reply.header("x-content-type-options", "nosniff");
    return reply.send(row.content);
  });
}

/**
 * The converter's vision-model calls (docs/P2.2.md §5 "One queue"): Surya speaks the OpenAI protocol and wants a
 * server that answers `/health` and names its model. This answers both, and sends each page read through the same
 * per-endpoint queue and call log as everything else, as role `document.ocr`. Not a browser route: it has no session.
 *
 * Surya is pointed at `…/internal/vlm/v1` and looks for health one level up, at `…/internal/vlm/health`. It sends no
 * key on either check (a bare HTTP client), so health and the model list are open: one says "ok", the other names a
 * fixed model. A page read, which spends the endpoint's time, takes the secret the converter was given as its key.
 */
export const VLM_MODEL_ID = "datalab-to/surya-ocr-2.5";

export function vlmProxyRoutes(app: FastifyInstance, ctx: AppContext) {
  const options = { config: { permission: { public: true as const } }, bodyLimit: 64 * 1024 * 1024 };
  const guard = (header: string | undefined) => {
    const given = header?.replace(/^Bearer\s+/i, "");
    if (!secretMatches(given, ctx.config.CONVERT_SHARED_SECRET)) throw new AppError("unauthenticated");
  };
  app.get("/internal/vlm/health", options, async () => ({ ok: true }));
  app.get("/internal/vlm/v1/models", options, async () => ({
    object: "list",
    data: [{ id: VLM_MODEL_ID, object: "model", owned_by: "gem" }],
  }));
  app.post("/internal/vlm/v1/chat/completions", options, async (request, reply) => {
    guard(request.headers.authorization);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const out = await ctx.llm.forwardChat("document.ocr", body);
    return reply.status(out.status).header("content-type", "application/json").send(out.text);
  });
}
