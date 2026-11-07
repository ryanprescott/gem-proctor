import { createHash } from "node:crypto";
import { ConvertClientError } from "@gem/convert";
import { AuthoringBatch, newId, SourceFile, SourceFilePage, SourceRevision } from "@gem/db";
import { assemblePages, chunkCap, cleanMarkdown, outlineRanges, previewSource } from "@gem/knowledge";
import {
  AppError,
  type ConvertErrorCode,
  type ConvertOptions,
  type ConvertPage,
  type ErrorCode,
  type OutlineEntry,
  type SourceWarning,
} from "@gem/shared";
import type { SourceFileDetail, SourceFileSummary, SourceFileView } from "@gem/shared/contracts";
import { and, count, desc, eq, getTableColumns, inArray, isNull, notExists, sql } from "drizzle-orm";
import { interactiveBusy } from "./activity.ts";
import { writeAudit } from "./audit.ts";
import type { AppContext } from "./context.ts";
import { getSettings } from "./settings.ts";
import { embeddingsTarget } from "./sources.ts";

/** PDF upload and conversion (docs/P2.2.md §4–§6). The converter reads; this keeps the file and the outcome. */

export const CONVERT_QUEUE = "source.convert";
export const fileTopic = (id: string) => `source_file:${id}`;
/** Every change to any of one owner's files: their list of uploads (`GET /sources/files/events`). */
export const ownerFilesTopic = (ownerId: string) => `source_files:${ownerId}`;

/** A file changed: its own stream reads it again, and so does its owner's list. */
export function publishFile(ctx: Pick<AppContext, "events">, id: string, ownerId: string) {
  ctx.events.publish(fileTopic(id));
  ctx.events.publish(ownerFilesTopic(ownerId));
}

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
  // Until it's ready, `markdown` is the raw text of the batches done so far: not something to show.
  return {
    ...toFileView({ ...row, content: Buffer.alloc(0) }),
    markdown: row.status === "ready" ? row.markdown : null,
  };
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
  publishFile(ctx, id, userId);
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
  publishFile(ctx, id, row.ownerId);
  return toFileView(updated as Row);
}

export async function deleteFile(ctx: AppContext, id: string, userId: string, meta: object) {
  const row = await loadFile(ctx, id);
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
  publishFile(ctx, id, row.ownerId);
}

/**
 * An owner's uploads that still need them, newest first: waiting, being read, failed, or read and not yet made into a
 * source of all of it. Once a revision is made from the whole file, it's done and leaves the list (the source shows
 * it from then on); one made from a chapter leaves it there, for the next chapter.
 */
export async function pendingFiles(ctx: Pick<AppContext, "db">, ownerId: string): Promise<SourceFileView[]> {
  const rows = await ctx.db
    .select(NO_CONTENT)
    .from(SourceFile)
    .where(
      and(
        eq(SourceFile.ownerId, ownerId),
        isNull(SourceFile.deletedAt),
        notExists(
          ctx.db
            .select({ id: SourceRevision.id })
            .from(SourceRevision)
            .where(and(eq(SourceRevision.sourceFileId, SourceFile.id), isNull(SourceRevision.sourcePageRange))),
        ),
      ),
    )
    .orderBy(desc(SourceFile.createdAt));
  return rows.map((r) => toFileView({ ...r, content: Buffer.alloc(0) }));
}

/** A file a source can be made from: the caller's own (or any, for an admin), done, and not deleted. */
export async function readyFile(ctx: AppContext, id: string, user: { userId: string; role: string }) {
  const row = await loadFile(ctx, id);
  if (row.ownerId !== user.userId && user.role !== "admin") throw new AppError("convert_file_not_found");
  if (row.status !== "ready") throw new AppError("convert_file_not_ready");
  return row;
}

const IMAGE_LINK = /!\[[^\]]*\]\([^)]*\)/g;

/** The outline a file's manifest holds; none for a file read before manifests, or a PDF without bookmarks. */
export function outlineOf(file: Pick<Row, "manifest">): OutlineEntry[] {
  const manifest = file.manifest as { outline?: OutlineEntry[] } | null;
  return Array.isArray(manifest?.outline) ? manifest.outline : [];
}

/**
 * A file's text from its stored pages: the pages the file was read for, or `pageRange` of them (a chapter), put
 * together with its outline (`assemblePages`) and cleaned. Nothing is read again.
 */
export async function assembleFile(
  ctx: Pick<AppContext, "db">,
  file: Row,
  pageRange?: string,
): Promise<{ markdown: string; warnings: SourceWarning[]; pages: number; figures: number }> {
  const rows = await ctx.db
    .select({ page: SourceFilePage.page, markdown: SourceFilePage.markdown })
    .from(SourceFilePage)
    .where(eq(SourceFilePage.fileId, file.id))
    .orderBy(SourceFilePage.page);
  const wanted = new Set(pageRange ? selectedPages(pageRange, file.pageCount ?? 0) : rows.map((r) => r.page));
  const pages = rows.filter((r) => wanted.has(r.page));
  if (pageRange && pages.length < wanted.size) throw new AppError("convert_bad_range");
  const figures = pages.reduce((n, p) => n + (p.markdown.match(IMAGE_LINK)?.length ?? 0), 0);
  const cleaned = cleanMarkdown({
    markdown: assemblePages(pages, outlineOf(file)),
    pageCount: pageRange ? pages.length : (file.pageCount ?? pages.length),
    pagesConverted: pages.length,
    figures,
  });
  return { markdown: cleaned.markdown, warnings: cleaned.warnings, pages: pages.length, figures };
}

/** A read PDF without its text (`sources.files.summary`): its outline with pages, and the text's sections and size. */
export async function fileSummary(ctx: AppContext, id: string): Promise<SourceFileSummary> {
  const file = await loadFile(ctx, id);
  if (file.status !== "ready") throw new AppError("convert_file_not_ready");
  const markdown = file.markdown ?? "";
  const target = await embeddingsTarget(ctx);
  const cap = target ? chunkCap(target) : undefined;
  return {
    file: toFileView(file),
    outline: outlineRanges(outlineOf(file), file.pageCount ?? 0),
    preview: previewSource(markdown, {
      title: file.filename,
      citationLabel: "source",
      format: "markdown",
      ...(cap === undefined ? {} : { maxTokens: cap }),
    }),
    characters: markdown.length,
  };
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

/**
 * Pages per request to the converter. A long PDF, a whole book, goes through in batches: each is a few minutes, the
 * converter's own page cap applies to a batch rather than the book, generation gets the card between batches, and a
 * failure or a restart loses one batch, not the book (retry continues where it stopped).
 */
export const CONVERT_BATCH_PAGES = 20;

/** The pages a range selects, 1-based and in order; every page without one. Past the end is `convert_bad_range`. */
export function selectedPages(range: string | null, pageCount: number): number[] {
  if (!range) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const pages = new Set<number>();
  for (const part of range.split(",")) {
    const [lowText, highText] = part.split("-");
    const low = Number(lowText);
    const high = highText === undefined ? low : Number(highText);
    if (low < 1 || high < low || high > pageCount) throw new AppError("convert_bad_range");
    for (let p = low; p <= high; p++) pages.add(p);
  }
  return [...pages].sort((a, b) => a - b);
}

/** The first page a range selects, before the page count is known. */
export function firstPage(range: string | null): number {
  if (!range) return 1;
  return Math.min(...range.split(",").map((part) => Number(part.split("-")[0])));
}

/** A range for the converter from pages in order: [1, 2, 3, 5] is `1-3,5`. */
export function rangeOf(pages: number[]): string {
  const parts: string[] = [];
  let start = pages[0] as number;
  let prev = start;
  for (const p of [...pages.slice(1), Number.NaN]) {
    if (p === prev + 1) {
      prev = p;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = p;
    prev = p;
  }
  return parts.join(",");
}

function errorOf(err: unknown): { code: ErrorCode; params: Record<string, string | number> } {
  if (err instanceof ConvertClientError) return { code: CODE_OF[err.code], params: {} };
  if (err instanceof AppError) return { code: err.code, params: err.params as Record<string, string | number> };
  return { code: "convert_failed", params: {} };
}

/** Runs one file's conversion. Never throws: the outcome is on the row, and can be retried. */
export async function processConvertJob(ctx: AppContext, fileId: string, idlePollMs = IDLE_POLL_MS): Promise<void> {
  const [meta] = await ctx.db
    .select({ status: SourceFile.status, deletedAt: SourceFile.deletedAt, ownerId: SourceFile.ownerId })
    .from(SourceFile)
    .where(eq(SourceFile.id, fileId));
  if (!meta || meta.deletedAt || meta.status !== "pending") return;
  const publish = () => publishFile(ctx, fileId, meta.ownerId);

  // Interactive work comes first: a conversion starts only when no one is generating (docs/P2.2.md §5).
  while (await interactiveWork(ctx)) await sleep(idlePollMs);

  const [started] = await ctx.db
    .update(SourceFile)
    .set({ status: "converting", startedAt: new Date() })
    .where(and(eq(SourceFile.id, fileId), eq(SourceFile.status, "pending")))
    .returning();
  if (!started) return;
  publish();

  const fail = async (err: unknown) => {
    const { code, params } = errorOf(err);
    await ctx.db
      .update(SourceFile)
      .set({ status: "failed", errorCode: code, errorParams: params, finishedAt: new Date() })
      .where(eq(SourceFile.id, fileId));
    publish();
  };

  try {
    const client = await convertReady(ctx);
    // Each page is stored as it's read (`source_file_page`), so a retry reads only the pages missing and the text
    // is assembled from the pages, as often as needed, without reading anything again.
    let pageCount = started.pageCount;
    let converter = started.converter;
    const store = async (asked: number[], reply: { pages: ConvertPage[]; outline: OutlineEntry[] } | null) => {
      // A request of blank pages is answered `empty`: those pages are read, and blank.
      const pages = reply ? reply.pages : asked.map((page) => ({ page, markdown: "" }));
      await ctx.db.transaction(async (tx) => {
        if (pages.length > 0) {
          await tx
            .insert(SourceFilePage)
            .values(pages.map((p) => ({ fileId, page: p.page, markdown: p.markdown })))
            .onConflictDoUpdate({
              target: [SourceFilePage.fileId, SourceFilePage.page],
              set: { markdown: sql`excluded.markdown`, readAt: new Date() },
            });
        }
        const [{ n } = { n: 0 }] = await tx
          .select({ n: count() })
          .from(SourceFilePage)
          .where(eq(SourceFilePage.fileId, fileId));
        await tx
          .update(SourceFile)
          .set({
            pagesConverted: n,
            pageCount,
            converter,
            ...(reply ? { manifest: { outline: reply.outline } } : {}),
          })
          .where(eq(SourceFile.id, fileId));
      });
      publish();
    };
    const read = async (pages: number[]) => {
      try {
        const reply = await client.convert(started.content, { strategy: started.strategy, pageRange: rangeOf(pages) });
        converter = reply.converter;
        pageCount = reply.pageCount;
        await store(pages, reply);
      } catch (err) {
        if (err instanceof ConvertClientError && err.code === "empty") return store(pages, null);
        throw err;
      }
    };

    if (pageCount === null) {
      // The first selected page alone: its reply says how many pages the PDF has.
      await read([firstPage(started.pageRange)]);
    }
    const wanted = selectedPages(started.pageRange, pageCount as number);
    const have = new Set(
      (
        await ctx.db.select({ page: SourceFilePage.page }).from(SourceFilePage).where(eq(SourceFilePage.fileId, fileId))
      ).map((r) => r.page),
    );
    const missing = wanted.filter((p) => !have.has(p));
    for (let i = 0; i < missing.length; i += CONVERT_BATCH_PAGES) {
      // Interactive work comes first between batches too.
      while (await interactiveWork(ctx)) await sleep(idlePollMs);
      await read(missing.slice(i, i + CONVERT_BATCH_PAGES));
    }

    const [file] = await ctx.db.select().from(SourceFile).where(eq(SourceFile.id, fileId));
    const assembled = await assembleFile(ctx, file as Row);
    if (assembled.markdown.trim() === "") throw new AppError("convert_empty");
    await ctx.db
      .update(SourceFile)
      .set({
        status: "ready",
        markdown: assembled.markdown,
        pageCount,
        pagesConverted: assembled.pages,
        figures: assembled.figures,
        warnings: assembled.warnings,
        converter,
        errorCode: null,
        errorParams: null,
        finishedAt: new Date(),
      })
      .where(eq(SourceFile.id, fileId));
    publish();
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
