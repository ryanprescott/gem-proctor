import { createHash } from "node:crypto";
import { ConvertClientError } from "@gem/convert";
import { AuthoringBatch, newId, SourceFile } from "@gem/db";
import { cleanMarkdown } from "@gem/knowledge";
import { AppError, type ConvertErrorCode, type ConvertOptions, type ErrorCode, type SourceWarning } from "@gem/shared";
import type { SourceFileDetail, SourceFileView } from "@gem/shared/contracts";
import { and, eq, getTableColumns, inArray, isNull } from "drizzle-orm";
import { interactiveBusy } from "./activity.ts";
import { writeAudit } from "./audit.ts";
import type { AppContext } from "./context.ts";
import { getSettings } from "./settings.ts";

/** PDF upload and conversion (docs/P2.2.md §4–§6). The converter reads; this keeps the file and the outcome. */

export const CONVERT_QUEUE = "source.convert";
export const fileTopic = (id: string) => `source_file:${id}`;

type Row = typeof SourceFile.$inferSelect;

/** How long to wait between looks at whether generation has finished. */
const IDLE_POLL_MS = 2000;

const CODE_OF: Record<ConvertErrorCode | "unreachable" | "invalid_reply", ErrorCode> = {
  bad_request: "convert_failed",
  too_large: "convert_too_large",
  not_pdf: "convert_bad_pdf",
  too_many_pages: "convert_too_many_pages",
  bad_pdf: "convert_bad_pdf",
  bad_range: "convert_bad_range",
  empty: "convert_empty",
  timeout: "convert_timeout",
  failed: "convert_failed",
  busy: "convert_busy",
  unreachable: "convert_unavailable",
  invalid_reply: "convert_failed",
};

/** Whether an address is on this machine or a private network: where a converter may be while local endpoints only is on. */
export function isLocalUrl(url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1" || host.endsWith(".local") || host.endsWith(".ts.net")) return true;
  if (!host.includes(".") && !host.includes(":")) return true; // a Compose service name
  const m = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80");
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

export function toFileView(r: Row): SourceFileView {
  const warnings = Array.isArray(r.warnings) ? (r.warnings as SourceWarning[]) : [];
  const converter = r.converter as { name: string; version: string } | null;
  return {
    id: r.id,
    filename: r.filename,
    sizeBytes: r.sizeBytes,
    status: r.status,
    strategy: r.strategy,
    pageRange: r.pageRange,
    errorCode: (r.errorCode as ErrorCode | null) ?? null,
    errorParams: (r.errorParams as Record<string, string | number | boolean> | null) ?? null,
    pageCount: r.pageCount,
    pagesConverted: r.pagesConverted,
    figures: r.figures,
    warnings,
    converter,
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}

/** Every column but the PDF itself: a list or a detail never carries the bytes. */
const { content: _content, ...NO_CONTENT } = getTableColumns(SourceFile);
void _content;

export async function loadFile(ctx: Pick<AppContext, "db">, id: string): Promise<Row> {
  const [row] = await ctx.db
    .select()
    .from(SourceFile)
    .where(and(eq(SourceFile.id, id), isNull(SourceFile.deletedAt)));
  if (!row) throw new AppError("convert_file_not_found");
  return row;
}

export async function fileDetail(ctx: Pick<AppContext, "db">, id: string): Promise<SourceFileDetail> {
  const [row] = await ctx.db
    .select(NO_CONTENT)
    .from(SourceFile)
    .where(and(eq(SourceFile.id, id), isNull(SourceFile.deletedAt)));
  if (!row) throw new AppError("convert_file_not_found");
  return { ...toFileView({ ...row, content: Buffer.alloc(0) }), markdown: row.markdown };
}

/** The PDF header: `%PDF-` within the first kilobyte, as readers accept it. */
export function looksLikePdf(buf: Buffer): boolean {
  return buf.subarray(0, 1024).includes("%PDF-");
}

/** Whether PDF upload is set up, and allowed where the converter is. */
export async function convertReady(ctx: AppContext) {
  const client = ctx.convert;
  const url = ctx.config.CONVERT_URL;
  if (!client || !url || !ctx.config.CONVERT_SHARED_SECRET) throw new AppError("convert_unavailable");
  if ((await getSettings(ctx.db)).localEndpointsOnly && !isLocalUrl(url)) throw new AppError("convert_remote_blocked");
  return client;
}

export async function createFile(
  ctx: AppContext,
  input: { pdf: Buffer; filename: string; options: ConvertOptions },
  userId: string,
  meta: object,
): Promise<SourceFileView> {
  await convertReady(ctx);
  const { convert } = await getSettings(ctx.db);
  if (input.pdf.length === 0 || !looksLikePdf(input.pdf)) throw new AppError("source_bad_type");
  if (input.pdf.length > convert.maxFileBytes)
    throw new AppError("convert_too_large", { maxBytes: convert.maxFileBytes });
  const id = newId();
  const [row] = await ctx.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(SourceFile)
      .values({
        id,
        ownerId: userId,
        filename: input.filename,
        mimeType: "application/pdf",
        sizeBytes: input.pdf.length,
        sha256: createHash("sha256").update(input.pdf).digest("hex"),
        content: input.pdf,
        strategy: input.options.strategy ?? convert.strategy,
        pageRange: input.options.pageRange ?? null,
        status: "pending",
        warnings: [],
      })
      .returning();
    await writeAudit(tx, {
      actorId: userId,
      action: "source_file.upload",
      targetType: "source_file",
      targetId: id,
      after: { filename: input.filename, sizeBytes: input.pdf.length },
      ...meta,
    });
    return inserted;
  });
  await queueConvert(ctx, id);
  return toFileView(row as Row);
}

async function queueConvert(ctx: AppContext, fileId: string) {
  if (!ctx.queue) throw new AppError("service_unavailable");
  await ctx.queue.send(CONVERT_QUEUE, { fileId });
}

export async function retryFile(ctx: AppContext, id: string): Promise<SourceFileView> {
  const row = await loadFile(ctx, id);
  if (row.status !== "failed") throw new AppError("convert_file_not_ready");
  await convertReady(ctx);
  const [updated] = await ctx.db
    .update(SourceFile)
    .set({ status: "pending", errorCode: null, errorParams: null, startedAt: null, finishedAt: null })
    .where(eq(SourceFile.id, id))
    .returning();
  await queueConvert(ctx, id);
  ctx.events.publish(fileTopic(id));
  return toFileView(updated as Row);
}

export async function deleteFile(ctx: AppContext, id: string, userId: string, meta: object) {
  await loadFile(ctx, id);
  await ctx.db.transaction(async (tx) => {
    await tx.update(SourceFile).set({ deletedAt: new Date() }).where(eq(SourceFile.id, id));
    await writeAudit(tx, {
      actorId: userId,
      action: "source_file.delete",
      targetType: "source_file",
      targetId: id,
      ...meta,
    });
  });
  ctx.events.publish(fileTopic(id));
}

/** A file a source can be made from: the caller's own (or any, for an admin), done, and not deleted. */
export async function readyFile(ctx: AppContext, id: string, user: { userId: string; role: string }) {
  const row = await loadFile(ctx, id);
  if (row.ownerId !== user.userId && user.role !== "admin") throw new AppError("convert_file_not_found");
  if (row.status !== "ready") throw new AppError("convert_file_not_ready");
  return row;
}

/** Whether question generation or its checks are queued or running, in this process or waiting in the database. */
async function interactiveWork(ctx: AppContext): Promise<boolean> {
  if (interactiveBusy()) return true;
  const rows = await ctx.db
    .select({ id: AuthoringBatch.id })
    .from(AuthoringBatch)
    .where(inArray(AuthoringBatch.status, ["queued", "running"]))
    .limit(1);
  return rows.length > 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errorOf(err: unknown): { code: ErrorCode; params: Record<string, string | number> } {
  if (err instanceof ConvertClientError) return { code: CODE_OF[err.code], params: {} };
  if (err instanceof AppError) return { code: err.code, params: err.params as Record<string, string | number> };
  return { code: "convert_failed", params: {} };
}

/** Runs one file's conversion. Never throws: the outcome is on the row, and can be retried. */
export async function processConvertJob(ctx: AppContext, fileId: string, idlePollMs = IDLE_POLL_MS): Promise<void> {
  const topic = fileTopic(fileId);
  const [meta] = await ctx.db
    .select({ status: SourceFile.status, deletedAt: SourceFile.deletedAt })
    .from(SourceFile)
    .where(eq(SourceFile.id, fileId));
  if (!meta || meta.deletedAt || meta.status !== "pending") return;

  // Interactive work comes first: a conversion starts only when no one is generating (docs/P2.2.md §5).
  while (await interactiveWork(ctx)) await sleep(idlePollMs);

  const [started] = await ctx.db
    .update(SourceFile)
    .set({ status: "converting", startedAt: new Date() })
    .where(and(eq(SourceFile.id, fileId), eq(SourceFile.status, "pending")))
    .returning();
  if (!started) return;
  ctx.events.publish(topic);

  const fail = async (err: unknown) => {
    const { code, params } = errorOf(err);
    await ctx.db
      .update(SourceFile)
      .set({ status: "failed", errorCode: code, errorParams: params, finishedAt: new Date() })
      .where(eq(SourceFile.id, fileId));
    ctx.events.publish(topic);
  };

  try {
    const client = await convertReady(ctx);
    const options: ConvertOptions = {
      strategy: started.strategy,
      ...(started.pageRange ? { pageRange: started.pageRange } : {}),
    };
    const reply = await client.convert(started.content, options);
    const cleaned = cleanMarkdown({
      markdown: reply.markdown,
      pageCount: reply.pageCount,
      pagesConverted: reply.pagesConverted,
      figures: reply.figures,
    });
    if (cleaned.markdown.trim() === "") throw new AppError("convert_empty");
    await ctx.db
      .update(SourceFile)
      .set({
        status: "ready",
        markdown: cleaned.markdown,
        pageCount: reply.pageCount,
        pagesConverted: reply.pagesConverted,
        figures: reply.figures,
        warnings: cleaned.warnings,
        converter: reply.converter,
        errorCode: null,
        errorParams: null,
        finishedAt: new Date(),
      })
      .where(eq(SourceFile.id, fileId));
    ctx.events.publish(topic);
  } catch (err) {
    await fail(err);
  }
}

/** A file left `converting` by a stopped API can't finish: it shows as failed, with a retry. */
export async function startConvertWorker(ctx: AppContext) {
  await ctx.db
    .update(SourceFile)
    .set({ status: "failed", errorCode: "service_unavailable", finishedAt: new Date() })
    .where(eq(SourceFile.status, "converting"));
  await ctx.queue?.workOne<{ fileId: string }>(CONVERT_QUEUE, async ({ fileId }) => {
    await processConvertJob(ctx, fileId);
  });
}
