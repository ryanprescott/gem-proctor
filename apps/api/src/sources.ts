import { newId, Source, SourceChunk, SourceRevision } from "@gem/db";
import { chunkCap, embedRevision, prepareSource, saveRevision } from "@gem/knowledge";
import { LlmError, type Target } from "@gem/llm";
import { AppError, EmbedError, type ErrorCode, type SourceFormat } from "@gem/shared";
import type { SourceRevisionView, SourceSummary } from "@gem/shared/contracts";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { writeAudit } from "./audit.ts";
import type { AppContext } from "./context.ts";
import { getSettings } from "./settings.ts";

/** Sources and their revisions (P2.md §5). Chunking is in `packages/knowledge`; this is the job and the views. */

export const EMBED_QUEUE = "source.embed";

export const sourceTopic = (id: string) => `source:${id}`;

type SourceRow = typeof Source.$inferSelect;
type RevisionRow = typeof SourceRevision.$inferSelect;

export function formatOf(filename: string | undefined, format: SourceFormat | undefined): SourceFormat {
  if (filename !== undefined && !/\.(md|markdown|txt)$/i.test(filename)) throw new AppError("source_bad_type");
  if (format) return format;
  return filename && /\.txt$/i.test(filename) ? "text" : "markdown";
}

export async function checkSourceSize(ctx: Pick<AppContext, "db">, text: string) {
  if (text.trim() === "") throw new AppError("source_empty");
  const { authoring } = await getSettings(ctx.db);
  if (Buffer.byteLength(text, "utf8") > authoring.maxSourceBytes) {
    throw new AppError("source_too_large", { maxBytes: authoring.maxSourceBytes });
  }
}

/** The role's cap, when it's assigned. Unassigned, ingest stops at the job, with a reason and a retry. */
export async function embeddingsTarget(ctx: Pick<AppContext, "llm">): Promise<Target | null> {
  try {
    return await ctx.llm.resolve("embeddings");
  } catch (err) {
    if (err instanceof LlmError && err.code === "llm_role_unassigned") return null;
    throw err;
  }
}

async function revisionStats(ctx: Pick<AppContext, "db">, ids: string[]) {
  if (ids.length === 0) return new Map<string, { chunks: number; embedded: number; tokens: number; flagged: number }>();
  const rows = await ctx.db
    .select({
      id: SourceChunk.revisionId,
      chunks: sql<number>`count(*)::int`,
      embedded: sql<number>`count(${SourceChunk.embedding})::int`,
      tokens: sql<number>`coalesce(sum(${SourceChunk.tokenCount}), 0)::int`,
      flagged: sql<number>`count(${SourceChunk.flaggedAt})::int`,
    })
    .from(SourceChunk)
    .where(inArray(SourceChunk.revisionId, ids))
    .groupBy(SourceChunk.revisionId);
  return new Map(rows.map((r) => [r.id, r]));
}

function toRevisionView(
  r: RevisionRow,
  stats: { chunks: number; embedded: number; tokens: number; flagged: number } | undefined,
): SourceRevisionView {
  const error = EmbedError.safeParse(r.embedError);
  return {
    id: r.id,
    number: r.number,
    format: r.format,
    embedStatus: r.embedStatus,
    embedError: error.success ? error.data : null,
    chunks: stats?.chunks ?? 0,
    embedded: stats?.embedded ?? 0,
    tokens: stats?.tokens ?? 0,
    flagged: stats?.flagged ?? 0,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function revisionViews(ctx: Pick<AppContext, "db">, sourceId: string): Promise<SourceRevisionView[]> {
  const rows = await ctx.db
    .select()
    .from(SourceRevision)
    .where(eq(SourceRevision.sourceId, sourceId))
    .orderBy(desc(SourceRevision.number));
  const stats = await revisionStats(
    ctx,
    rows.map((r) => r.id),
  );
  return rows.map((r) => toRevisionView(r, stats.get(r.id)));
}

function toSummary(s: SourceRow, latest: SourceRevisionView): SourceSummary {
  return {
    id: s.id,
    title: s.title,
    citationLabel: s.citationLabel,
    author: s.author,
    edition: s.edition,
    url: s.url,
    ownerId: s.ownerId,
    createdAt: s.createdAt.toISOString(),
    latest,
    usable: latest.embedStatus === "ready",
  };
}

export async function sourceSummaries(ctx: Pick<AppContext, "db">, rows: SourceRow[]): Promise<SourceSummary[]> {
  if (rows.length === 0) return [];
  const revisions = await ctx.db
    .select()
    .from(SourceRevision)
    .where(
      inArray(
        SourceRevision.sourceId,
        rows.map((s) => s.id),
      ),
    )
    .orderBy(asc(SourceRevision.number));
  const latest = new Map(revisions.map((r) => [r.sourceId, r]));
  const stats = await revisionStats(
    ctx,
    [...latest.values()].map((r) => r.id),
  );
  return rows.flatMap((s) => {
    const r = latest.get(s.id);
    return r ? [toSummary(s, toRevisionView(r, stats.get(r.id)))] : [];
  });
}

export async function sourceSummary(ctx: Pick<AppContext, "db">, id: string): Promise<SourceSummary> {
  const [row] = await ctx.db.select().from(Source).where(eq(Source.id, id));
  const [summary] = row ? await sourceSummaries(ctx, [row]) : [];
  if (!summary) throw new AppError("source_not_found");
  return summary;
}

export interface SourceInput {
  title: string;
  citationLabel: string;
  author?: string | undefined;
  edition?: string | undefined;
  url?: string | undefined;
  text: string;
  format: SourceFormat;
}

async function queueEmbed(ctx: AppContext, revisionId: string) {
  if (!ctx.queue) throw new AppError("service_unavailable");
  await ctx.queue.send(EMBED_QUEUE, { revisionId });
}

export async function createSource(ctx: AppContext, input: SourceInput, userId: string, meta: object) {
  const target = await embeddingsTarget(ctx);
  const cap = target ? chunkCap(target) : undefined;
  const prepared = prepareSource(input.text, { ...input, ...(cap === undefined ? {} : { maxTokens: cap }) });
  const id = newId();
  const revisionId = await ctx.db.transaction(async (tx) => {
    await tx.insert(Source).values({
      id,
      ownerId: userId,
      title: input.title,
      citationLabel: input.citationLabel,
      author: input.author ?? null,
      edition: input.edition ?? null,
      url: input.url ?? null,
    });
    const revision = await saveRevision(tx, {
      sourceId: id,
      number: 1,
      text: input.text,
      format: input.format,
      createdBy: userId,
      prepared,
    });
    await writeAudit(tx, {
      actorId: userId,
      action: "source.create",
      targetType: "source",
      targetId: id,
      after: { title: input.title, citationLabel: input.citationLabel, chunks: prepared.chunks.length },
      ...meta,
    });
    return revision;
  });
  await queueEmbed(ctx, revisionId);
  return id;
}

/** A new revision: new rows, re-chunked, with old chunks left where they are (SPEC §3C.5). */
export async function addRevision(ctx: AppContext, source: SourceRow, input: SourceInput, userId: string) {
  const target = await embeddingsTarget(ctx);
  const cap = target ? chunkCap(target) : undefined;
  const prepared = prepareSource(input.text, { ...input, ...(cap === undefined ? {} : { maxTokens: cap }) });
  const revisionId = await ctx.db.transaction(async (tx) => {
    await tx
      .update(Source)
      .set({
        title: input.title,
        citationLabel: input.citationLabel,
        author: input.author ?? null,
        edition: input.edition ?? null,
        url: input.url ?? null,
      })
      .where(eq(Source.id, source.id));
    const [last] = await tx
      .select({ number: sql<number>`max(${SourceRevision.number})::int` })
      .from(SourceRevision)
      .where(eq(SourceRevision.sourceId, source.id));
    return saveRevision(tx, {
      sourceId: source.id,
      number: (last?.number ?? 0) + 1,
      text: input.text,
      format: input.format,
      createdBy: userId,
      prepared,
    });
  });
  await queueEmbed(ctx, revisionId);
}

export async function retryEmbed(ctx: AppContext, source: SourceSummary) {
  await ctx.db
    .update(SourceRevision)
    .set({ embedStatus: "pending", embedError: null })
    .where(eq(SourceRevision.id, source.latest.id));
  await queueEmbed(ctx, source.latest.id);
  ctx.events.publish(sourceTopic(source.id));
}

function embedErrorOf(err: unknown): EmbedError {
  if (err instanceof AppError) return { code: err.code, params: err.params };
  if (err instanceof LlmError) {
    return { code: err.code as ErrorCode, params: {} };
  }
  return { code: "internal", params: {} };
}

/** Runs one revision's job. Never throws: the outcome is on the row, and can be retried (P2.md §5). */
export async function processEmbedJob(ctx: AppContext, revisionId: string): Promise<void> {
  const [revision] = await ctx.db.select().from(SourceRevision).where(eq(SourceRevision.id, revisionId));
  if (!revision) return;
  const topic = sourceTopic(revision.sourceId);
  const status = async (set: Partial<typeof SourceRevision.$inferInsert>) => {
    await ctx.db.update(SourceRevision).set(set).where(eq(SourceRevision.id, revisionId));
    ctx.events.publish(topic);
  };
  await status({ embedStatus: "embedding", embedError: null });
  try {
    await embedRevision({ db: ctx.db, llm: ctx.llm, userId: revision.createdBy }, revisionId, () => {
      ctx.events.publish(topic);
    });
    await status({ embedStatus: "ready" });
  } catch (err) {
    await status({ embedStatus: "failed", embedError: embedErrorOf(err) });
  }
}

/** A revision left `embedding` by a stopped API can't finish, so it can be retried. */
async function failOrphanedEmbeds(ctx: AppContext) {
  await ctx.db
    .update(SourceRevision)
    .set({ embedStatus: "failed", embedError: { code: "service_unavailable", params: {} } })
    .where(eq(SourceRevision.embedStatus, "embedding"));
}

export async function startSourceWorker(ctx: AppContext) {
  await failOrphanedEmbeds(ctx);
  await ctx.queue?.workOne<{ revisionId: string }>(EMBED_QUEUE, async ({ revisionId }) => {
    await processEmbedJob(ctx, revisionId);
  });
}
