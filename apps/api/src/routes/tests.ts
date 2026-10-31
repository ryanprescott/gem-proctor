import { checkProctorReady } from "@gem/authoring";
import { newId, Test, TestImportRecord, TestVersion, User } from "@gem/db";
import { AppError, analyzeImport, formatQuizLike, type ImportReport, type Quiz, serializeQuiz } from "@gem/shared";
import {
  IMPORT_MAX_BYTES,
  importCreate,
  importPreview,
  importVerifyGet,
  importVerifyStart,
  type TestSummary,
  testsExport,
  testsGet,
  testsList,
  testsUpdate,
  testsVersions,
} from "@gem/shared/contracts";
import { and, desc, eq, inArray, isNotNull, isNull, max, type SQL } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../context.ts";
import { route } from "../http/route.ts";
import { getSettings } from "../settings.ts";
import { applyVerification, createVerifyJob, loadOwnJob, VERIFY_QUEUE, verifyJobView } from "../verification.ts";
import { modelCallLimit } from "./llm.ts";

const textBytes = (s: string) => Buffer.byteLength(s, "utf8");

function checkSize(text: string) {
  if (text.trim() === "") throw new AppError("import_empty");
  if (textBytes(text) > IMPORT_MAX_BYTES) throw new AppError("import_too_large", { maxBytes: IMPORT_MAX_BYTES });
}

const titleFromFilename = (f: string | undefined) => (f ? f.replace(/\.[^.]+$/, "") : undefined);

/** Multipart upload (`file` field) on preview: turned into the same `{ text, filename }` body. */
async function multipartToBody(request: FastifyRequest) {
  if (!request.isMultipart()) return;
  const file = await request.file({ limits: { fileSize: IMPORT_MAX_BYTES + 1, files: 1 } });
  if (!file) throw new AppError("import_empty");
  const buf = await file.toBuffer();
  if (file.file.truncated || buf.length > IMPORT_MAX_BYTES) {
    throw new AppError("import_too_large", { maxBytes: IMPORT_MAX_BYTES });
  }
  request.body = { text: buf.toString("utf8"), filename: file.filename };
}

type TestRow = typeof Test.$inferSelect;

async function summaries(ctx: AppContext, where: SQL | undefined): Promise<TestSummary[]> {
  const tests = await ctx.db
    .select({ test: Test, ownerName: User.displayName })
    .from(Test)
    .innerJoin(User, eq(User.id, Test.ownerId))
    .where(where)
    .orderBy(desc(Test.createdAt));
  if (tests.length === 0) return [];
  const ids = tests.map((t) => t.test.id);
  const latest = await ctx.db
    .select({ testId: TestVersion.testId, n: max(TestVersion.versionNumber) })
    .from(TestVersion)
    .where(inArray(TestVersion.testId, ids))
    .groupBy(TestVersion.testId);
  const latestBy = new Map(latest.map((l) => [l.testId, l.n ?? 0]));
  const versions = await ctx.db
    .select({ testId: TestVersion.testId, n: TestVersion.versionNumber, content: TestVersion.content })
    .from(TestVersion)
    .where(inArray(TestVersion.testId, ids));
  const counts = new Map<string, number>();
  for (const v of versions) {
    if (v.n === latestBy.get(v.testId)) counts.set(v.testId, (v.content as Quiz).questions.length);
  }
  return tests.map(({ test, ownerName }) =>
    toSummary(test, ownerName, latestBy.get(test.id) ?? 0, counts.get(test.id) ?? 0),
  );
}

function toSummary(t: TestRow, ownerName: string, latestVersion: number, questionCount: number): TestSummary {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    tags: t.tags,
    ownerId: t.ownerId,
    ownerName,
    createdAt: t.createdAt.toISOString(),
    archivedAt: t.archivedAt?.toISOString() ?? null,
    questionCount,
    latestVersion,
  };
}

async function summary(ctx: AppContext, id: string): Promise<TestSummary> {
  const [s] = await summaries(ctx, eq(Test.id, id));
  if (!s) throw new AppError("test_not_found");
  return s;
}

async function version(ctx: AppContext, testId: string, versionNumber?: number) {
  const rows = await ctx.db
    .select({ version: TestVersion, importId: TestImportRecord.id })
    .from(TestVersion)
    .leftJoin(TestImportRecord, eq(TestImportRecord.testVersionId, TestVersion.id))
    .where(
      versionNumber === undefined
        ? eq(TestVersion.testId, testId)
        : and(eq(TestVersion.testId, testId), eq(TestVersion.versionNumber, versionNumber)),
    )
    .orderBy(desc(TestVersion.versionNumber))
    .limit(1);
  const row = rows[0];
  if (!row) throw new AppError("test_not_found");
  return row;
}

function versionSummary(v: typeof TestVersion.$inferSelect, imported: boolean, gate: boolean) {
  return {
    id: v.id,
    versionNumber: v.versionNumber,
    createdAt: v.createdAt.toISOString(),
    publishedAt: v.publishedAt?.toISOString() ?? null,
    imported,
    ...checkProctorReady(v.content as Quiz, gate),
  };
}

const slug = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 80) || "quiz";

export function testRoutes(app: FastifyInstance, ctx: AppContext) {
  const bodyLimit = 3 * IMPORT_MAX_BYTES + 64 * 1024;

  route(
    app,
    importPreview,
    async ({ body }) => {
      checkSize(body.text);
      const analysis = analyzeImport(body.text, { title: titleFromFilename(body.filename) });
      return {
        normalizedText:
          analysis.quiz !== null
            ? serializeQuiz(analysis.quiz)
            : analysis.value === undefined
              ? null
              : formatQuizLike(analysis.value),
        quiz: analysis.quiz,
        report: analysis.report,
      };
    },
    { bodyLimit, preValidation: async (request) => multipartToBody(request) },
  );

  route(
    app,
    importCreate,
    async ({ body, user }) => {
      checkSize(body.text);
      checkSize(body.originalText);
      const job = body.verificationJobId ? await loadOwnJob(ctx, body.verificationJobId, user) : null;
      if (!job && (body.acceptedFixes ?? []).length > 0) throw new AppError("verify_fix_invalid");
      const applied: NonNullable<ImportReport["verification"]>["acceptedFixes"] = [];
      const analysis = analyzeImport(body.text, {
        title: titleFromFilename(body.filename),
        ...(job ? { transform: (value) => applyVerification(value, job, body.acceptedFixes ?? [], applied) } : {}),
      });
      if (!analysis.quiz) {
        throw new AppError("import_invalid_quiz", { errors: analysis.report.errors.length });
      }
      const report: ImportReport = {
        ...analysis.report,
        ...(job ? { verification: { jobId: job.id, acceptedFixes: applied } } : {}),
      };
      const quiz = analysis.quiz;
      const testId = newId();
      const versionId = newId();
      await ctx.db.transaction(async (tx) => {
        await tx.insert(Test).values({
          id: testId,
          ownerId: user.userId,
          title: quiz.quiz_title.trim() || titleFromFilename(body.filename) || "—",
          description: quiz.description ?? null,
          tags: quiz.tags ?? [],
        });
        // provenance stays null for imports (P0.md §4).
        await tx
          .insert(TestVersion)
          .values({ id: versionId, testId, versionNumber: 1, content: quiz, provenance: null });
        await tx.insert(TestImportRecord).values({
          id: newId(),
          testVersionId: versionId,
          originalFilename: body.filename ?? null,
          sourceRaw: body.originalText,
          report,
        });
      });
      return { testId, versionId };
    },
    { bodyLimit },
  );

  route(
    app,
    importVerifyStart,
    async ({ body, user }) => {
      if (!ctx.queue) throw new AppError("service_unavailable");
      const job = await createVerifyJob(ctx, user.userId, body.value);
      await ctx.queue.send(VERIFY_QUEUE, { jobId: job.id });
      return { job: { id: job.id, status: job.status } };
    },
    { ...modelCallLimit(ctx), bodyLimit },
  );

  route(app, importVerifyGet, async ({ params }) => ({ job: await verifyJobView(ctx, params.id) }));

  route(app, testsList, async ({ query, user }) => {
    const conds: SQL[] = [];
    // Proctors see what they own; admins see everything (SPEC §5.1).
    if (user.role !== "admin") conds.push(eq(Test.ownerId, user.userId));
    if (query.archived === "exclude") conds.push(isNull(Test.archivedAt));
    if (query.archived === "only") conds.push(isNotNull(Test.archivedAt));
    return { tests: await summaries(ctx, conds.length > 0 ? and(...conds) : undefined) };
  });

  route(app, testsGet, async ({ params }) => {
    const s = await summary(ctx, params.id);
    const { version: v, importId } = await version(ctx, params.id);
    const content = v.content as Quiz;
    const { verify } = await getSettings(ctx.db);
    return {
      test: { ...s, testType: content.testType ?? null },
      version: versionSummary(v, importId !== null, verify.proctoredGate),
      content,
    };
  });

  route(app, testsUpdate, async ({ params, body }) => {
    const set: Partial<typeof Test.$inferInsert> = {};
    if (body.title !== undefined) set.title = body.title;
    if (body.description !== undefined) set.description = body.description;
    if (body.tags !== undefined) set.tags = [...new Set(body.tags)];
    if (body.archived !== undefined) set.archivedAt = body.archived ? ctx.now() : null;
    await ctx.db.update(Test).set(set).where(eq(Test.id, params.id));
    return { test: await summary(ctx, params.id) };
  });

  route(app, testsVersions, async ({ params }) => {
    const rows = await ctx.db
      .select({ version: TestVersion, importId: TestImportRecord.id })
      .from(TestVersion)
      .leftJoin(TestImportRecord, eq(TestImportRecord.testVersionId, TestVersion.id))
      .where(eq(TestVersion.testId, params.id))
      .orderBy(desc(TestVersion.versionNumber));
    const { verify } = await getSettings(ctx.db);
    return { versions: rows.map((r) => versionSummary(r.version, r.importId !== null, verify.proctoredGate)) };
  });

  route(app, testsExport, async ({ params, query, reply }) => {
    const s = await summary(ctx, params.id);
    const { version: v } = await version(ctx, params.id, query.version);
    reply.header("content-type", "application/json; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="${slug(s.title)}-v${v.versionNumber}.json"`);
    return serializeQuiz(v.content as Quiz);
  });
}
