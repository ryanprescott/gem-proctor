import { Source, SourceChunk, SourceRevision, SourceSection } from "@gem/db";
import { chunkCap, expandSections, previewSource } from "@gem/knowledge";
import { LlmError } from "@gem/llm";
import { AppError, MODEL_ROLES } from "@gem/shared";
import {
  type ScopeFit,
  type SourceChunkView,
  type SourceSectionView,
  sourcesChunks,
  sourcesCreate,
  sourcesDelete,
  sourcesEmbedRetry,
  sourcesEstimate,
  sourcesEvents,
  sourcesGet,
  sourcesList,
  sourcesPreview,
  sourcesRevision,
  sourcesSections,
  sourcesUpdate,
} from "@gem/shared/contracts";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { writeAudit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { streamState } from "../events.ts";
import { route } from "../http/route.ts";
import { getSettings } from "../settings.ts";
import {
  addRevision,
  checkSourceSize,
  createSource,
  embeddingsTarget,
  formatOf,
  retryEmbed,
  revisionViews,
  sourceSummaries,
  sourceSummary,
  sourceTopic,
} from "../sources.ts";
import { requestMeta } from "./auth.ts";

/** Above any `maxSourceBytes` an admin can set; the setting itself is checked in the handlers. */
const BODY_LIMIT = 64 * 1024 * 1024;

/** An upload (`file` field, with the metadata as fields) becomes the same body as a paste. */
async function multipartToBody(ctx: AppContext, request: FastifyRequest) {
  if (!request.isMultipart()) return;
  const { authoring } = await getSettings(ctx.db);
  const file = await request.file({ limits: { fileSize: authoring.maxSourceBytes + 1, files: 1 } });
  if (!file) throw new AppError("source_empty");
  const tooLarge = new AppError("source_too_large", { maxBytes: authoring.maxSourceBytes });
  const buf = await file.toBuffer().catch((err: { code?: string }) => {
    throw err.code === "FST_REQ_FILE_TOO_LARGE" ? tooLarge : err;
  });
  if (file.file.truncated || buf.length > authoring.maxSourceBytes) throw tooLarge;
  const fields: Record<string, string> = {};
  for (const [name, field] of Object.entries(file.fields)) {
    const value = (field as { value?: unknown } | undefined)?.value;
    if (typeof value === "string") fields[name] = value;
  }
  request.body = { ...fields, text: buf.toString("utf8"), filename: file.filename };
}

async function loadRevision(ctx: Pick<AppContext, "db">, sourceId: string, number?: number) {
  const rows = await ctx.db
    .select()
    .from(SourceRevision)
    .where(
      number === undefined
        ? eq(SourceRevision.sourceId, sourceId)
        : and(eq(SourceRevision.sourceId, sourceId), eq(SourceRevision.number, number)),
    )
    .orderBy(desc(SourceRevision.number))
    .limit(1);
  const row = rows[0];
  if (!row) throw new AppError("source_not_found");
  return row;
}

export async function sectionViews(ctx: Pick<AppContext, "db">, revisionId: string): Promise<SourceSectionView[]> {
  const sections = await ctx.db
    .select()
    .from(SourceSection)
    .where(eq(SourceSection.revisionId, revisionId))
    .orderBy(asc(SourceSection.order));
  const counts = await ctx.db
    .select({
      id: SourceChunk.sectionId,
      chunks: sql<number>`count(*)::int`,
      tokens: sql<number>`coalesce(sum(${SourceChunk.tokenCount}), 0)::int`,
    })
    .from(SourceChunk)
    .where(eq(SourceChunk.revisionId, revisionId))
    .groupBy(SourceChunk.sectionId);
  const by = new Map(counts.map((c) => [c.id, c]));
  return sections.map((s) => ({
    id: s.id,
    parentId: s.parentId,
    level: s.level,
    title: s.title,
    order: s.order,
    headingPath: s.headingPath,
    chunks: by.get(s.id)?.chunks ?? 0,
    tokens: by.get(s.id)?.tokens ?? 0,
  }));
}

/** Per role, whether a selection fits one call: no model name, and no endpoint (like `GET /llm/roles`). */
export async function scopeFit(ctx: Pick<AppContext, "llm">, tokens: number): Promise<ScopeFit[]> {
  const roles = MODEL_ROLES.filter((r) => r !== "embeddings");
  return Promise.all(
    roles.map(async (role) => {
      const target = await ctx.llm.resolve(role).catch((err: unknown) => {
        if (err instanceof LlmError && err.code === "llm_role_unassigned") return null;
        throw err;
      });
      if (!target) return { role, assigned: false, budget: null, fits: false };
      const budget = target.capabilities.contextWindow - target.capabilities.maxOutputTokens;
      return { role, assigned: true, budget, fits: tokens <= budget };
    }),
  );
}

export function sourcesRoutes(app: FastifyInstance, ctx: AppContext) {
  const body = { bodyLimit: BODY_LIMIT, preValidation: async (r: FastifyRequest) => multipartToBody(ctx, r) };

  route(
    app,
    sourcesPreview,
    async ({ body: b }) => {
      await checkSourceSize(ctx, b.text);
      const target = await embeddingsTarget(ctx);
      const cap = target ? chunkCap(target) : undefined;
      return previewSource(b.text, {
        title: b.title?.trim() || b.filename || "—",
        citationLabel: "source",
        format: formatOf(b.filename, b.format),
        ...(cap === undefined ? {} : { maxTokens: cap }),
      });
    },
    body,
  );

  route(
    app,
    sourcesCreate,
    async ({ body: b, user, request }) => {
      await checkSourceSize(ctx, b.text);
      const id = await createSource(
        ctx,
        { ...b, format: formatOf(b.filename, b.format) },
        user.userId,
        requestMeta(request),
      );
      return { source: await sourceSummary(ctx, id) };
    },
    body,
  );

  route(app, sourcesList, async ({ user }) => {
    // Their own, even for an admin: this is a library to work from. An admin reaches another's by its id.
    const rows = await ctx.db
      .select()
      .from(Source)
      .where(and(eq(Source.ownerId, user.userId), isNull(Source.deletedAt)))
      .orderBy(desc(Source.createdAt));
    return { sources: await sourceSummaries(ctx, rows) };
  });

  route(app, sourcesGet, async ({ params }) => ({
    source: await sourceSummary(ctx, params.id),
    revisions: await revisionViews(ctx, params.id),
  }));

  route(
    app,
    sourcesUpdate,
    async ({ params, body: b, user }) => {
      await checkSourceSize(ctx, b.text);
      const [source] = await ctx.db.select().from(Source).where(eq(Source.id, params.id));
      if (!source) throw new AppError("source_not_found");
      await addRevision(
        ctx,
        source,
        {
          title: b.title ?? source.title,
          citationLabel: b.citationLabel ?? source.citationLabel,
          author: b.author ?? source.author ?? undefined,
          edition: b.edition ?? source.edition ?? undefined,
          url: b.url ?? source.url ?? undefined,
          text: b.text,
          format: formatOf(b.filename, b.format),
        },
        user.userId,
      );
      ctx.events.publish(sourceTopic(params.id));
      return { source: await sourceSummary(ctx, params.id) };
    },
    body,
  );

  route(app, sourcesDelete, async ({ params, user, request }) => {
    await ctx.db.transaction(async (tx) => {
      // Soft: a published test's citations must keep resolving (SPEC §3C.5).
      await tx.update(Source).set({ deletedAt: ctx.now() }).where(eq(Source.id, params.id));
      await writeAudit(tx, {
        actorId: user.userId,
        action: "source.delete",
        targetType: "source",
        targetId: params.id,
        ...requestMeta(request),
      });
    });
    return { ok: true as const };
  });

  route(app, sourcesRevision, async ({ params }) => {
    const row = await loadRevision(ctx, params.id, params.n);
    const view = (await revisionViews(ctx, params.id)).find((r) => r.id === row.id);
    if (!view) throw new AppError("source_not_found");
    return { revision: view, markdown: row.markdown };
  });

  route(app, sourcesSections, async ({ params, query }) => {
    const revision = await loadRevision(ctx, params.id, query.revision);
    return { sections: await sectionViews(ctx, revision.id) };
  });

  route(app, sourcesChunks, async ({ params, query }) => {
    const revision = await loadRevision(ctx, params.id, query.revision);
    const sectionIds = query.sectionIds ? query.sectionIds.split(",").filter(Boolean) : null;
    const rows = await ctx.db
      .select({ chunk: SourceChunk, headingPath: SourceSection.headingPath })
      .from(SourceChunk)
      .innerJoin(SourceSection, eq(SourceSection.id, SourceChunk.sectionId))
      .where(
        and(
          eq(SourceChunk.revisionId, revision.id),
          sectionIds ? inArray(SourceChunk.sectionId, sectionIds) : undefined,
          query.flagged === "true" ? isNotNull(SourceChunk.flaggedAt) : undefined,
        ),
      )
      .orderBy(asc(SourceChunk.charStart));
    const chunks: SourceChunkView[] = rows.map(({ chunk, headingPath }) => ({
      id: chunk.id,
      chunkKey: chunk.chunkKey,
      sectionId: chunk.sectionId,
      headingPath,
      charStart: chunk.charStart,
      charEnd: chunk.charEnd,
      text: chunk.text,
      tokenCount: chunk.tokenCount,
      embedded: chunk.embedding !== null,
      flaggedAt: chunk.flaggedAt?.toISOString() ?? null,
      flagReason: chunk.flagReason,
    }));
    return { chunks };
  });

  route(app, sourcesEstimate, async ({ params, body: b }) => {
    const revision = await loadRevision(ctx, params.id, b.revision);
    const sectionIds = b.sectionIds ? await expandSections(ctx.db, revision.id, b.sectionIds) : null;
    const [total] = await ctx.db
      .select({
        chunks: sql<number>`count(*)::int`,
        tokens: sql<number>`coalesce(sum(${SourceChunk.tokenCount}), 0)::int`,
      })
      .from(SourceChunk)
      .where(
        and(
          eq(SourceChunk.revisionId, revision.id),
          sectionIds ? inArray(SourceChunk.sectionId, sectionIds) : undefined,
        ),
      );
    const tokens = total?.tokens ?? 0;
    return { chunks: total?.chunks ?? 0, tokens, fit: await scopeFit(ctx, tokens) };
  });

  route(app, sourcesEmbedRetry, async ({ params }) => {
    const source = await sourceSummary(ctx, params.id);
    if (source.latest.embedStatus !== "failed") throw new AppError("source_not_ready");
    await retryEmbed(ctx, source);
    return { source: await sourceSummary(ctx, params.id) };
  });

  route(app, sourcesEvents, async ({ params, query, request, reply }) =>
    streamState(
      ctx.events,
      sourceTopic(params.id),
      request,
      reply,
      () => sourceSummary(ctx, params.id),
      query.once === "true",
    ),
  );
}
