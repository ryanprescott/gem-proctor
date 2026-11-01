import { createHash } from "node:crypto";
import { checkQuestion, importedQuestion, type L7Deps, type RunRecorder, type RunRef } from "@gem/authoring";
import { type Db, newId, VerificationJob, VerificationRun } from "@gem/db";
import {
  AppError,
  type ErrorCode,
  type FlowBOutcome,
  type ImportReport,
  type VerificationItem,
  type VerificationSummary,
} from "@gem/shared";
import type { VerificationJobView } from "@gem/shared/contracts";
import { eq } from "drizzle-orm";
import { writeAudit } from "./audit.ts";
import type { AppContext } from "./context.ts";
import type { CurrentUser } from "./http/route.ts";
import { getSettings } from "./settings.ts";

export const VERIFY_QUEUE = "verify.import";

/** L7's record: one `VerificationRun` per program run; a denial also goes to the audit log (P2.1.md §5). */
export function dbRecorder(db: Db): RunRecorder {
  return {
    async run(record) {
      const id = newId();
      await db.insert(VerificationRun).values({
        id,
        jobId: record.jobId ?? null,
        testVersionId: record.testVersionId ?? null,
        draftQuestionId: record.draftQuestionId ?? null,
        questionId: record.questionId,
        programKind: record.programKind,
        program: record.program,
        status: record.status,
        result: record.result,
        matchedOption: record.matchedOption,
        durationMs: record.durationMs,
        sandboxVersion: record.sandboxVersion,
      });
      return id;
    },
    /** No actor: the sandbox noticed it. The row holds the run's id, never the program. */
    async denial(ref: RunRef, runId: string) {
      await writeAudit(db, {
        actorId: null,
        action: "verify.sandbox_denial",
        targetType: ref.jobId ? "verification_job" : "question",
        targetId: ref.jobId ?? ref.draftQuestionId ?? String(ref.questionId),
        after: { runId, questionId: ref.questionId },
      });
    },
  };
}

type JobRow = typeof VerificationJob.$inferSelect;
type QuizValue = { questions: unknown[] };

export async function createVerifyJob(
  ctx: Pick<AppContext, "db" | "llm">,
  ownerId: string,
  value: QuizValue,
): Promise<JobRow> {
  // No `verify.solve`: 409 `llm_role_unassigned`, and the import goes on without it (P2.1.md §5).
  await ctx.llm.resolve("verify.solve");
  const inputHash = createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const [job] = await ctx.db
    .insert(VerificationJob)
    .values({ id: newId(), ownerId, status: "queued", input: value, inputHash })
    .returning();
  return job as JobRow;
}

function summaryOf(items: VerificationItem[], total: number): VerificationSummary {
  const counts: Partial<Record<FlowBOutcome, number>> = {};
  for (const i of items) counts[i.outcome] = (counts[i.outcome] ?? 0) + 1;
  return { total, done: items.length, counts };
}

/** Runs a queued job to the end. Never throws: every outcome is on the row. Polled, so items land as they finish. */
export async function processVerifyJob(ctx: Pick<AppContext, "db" | "llm" | "verify">, jobId: string): Promise<void> {
  const [job] = await ctx.db.select().from(VerificationJob).where(eq(VerificationJob.id, jobId));
  if (!job) return;
  const input = job.input as QuizValue;
  const total = input.questions.length;
  const started = new Date();
  await ctx.db
    .update(VerificationJob)
    .set({ status: "running", startedAt: started, summary: summaryOf([], total) })
    .where(eq(VerificationJob.id, jobId));
  const deps: L7Deps = {
    llm: ctx.llm,
    verify: ctx.verify,
    recorder: dbRecorder(ctx.db),
    settings: (await getSettings(ctx.db)).verify,
    userId: job.ownerId,
  };
  const items: VerificationItem[] = [];
  try {
    for (const [index, value] of input.questions.entries()) {
      const question = importedQuestion(value, index);
      items.push(await checkQuestion(deps, question, { questionId: question.id, jobId }));
      await ctx.db
        .update(VerificationJob)
        .set({ items, summary: summaryOf(items, total) })
        .where(eq(VerificationJob.id, jobId));
    }
    await ctx.db
      .update(VerificationJob)
      .set({ status: "done", finishedAt: new Date() })
      .where(eq(VerificationJob.id, jobId));
  } catch (err) {
    const errorCode: ErrorCode = err instanceof AppError ? err.code : "internal";
    await ctx.db
      .update(VerificationJob)
      .set({ status: "failed", errorCode, finishedAt: new Date() })
      .where(eq(VerificationJob.id, jobId));
  }
}

/** A job left `running` by a stopped API can't finish; single instance, so nothing else owns it (SPEC §5.3). */
async function failOrphanedJobs(db: Db) {
  await db
    .update(VerificationJob)
    .set({ status: "failed", errorCode: "service_unavailable", finishedAt: new Date() })
    .where(eq(VerificationJob.status, "running"));
}

export async function startVerifyWorker(ctx: AppContext) {
  await failOrphanedJobs(ctx.db);
  await ctx.queue?.workOne<{ jobId: string }>(VERIFY_QUEUE, async ({ jobId }) => {
    await processVerifyJob(ctx, jobId);
  });
}

export async function verifyJobView(ctx: Pick<AppContext, "db">, id: string): Promise<VerificationJobView> {
  const [job] = await ctx.db.select().from(VerificationJob).where(eq(VerificationJob.id, id));
  if (!job) throw new AppError("verify_job_not_found");
  return {
    id: job.id,
    status: job.status,
    items: (job.items ?? []) as VerificationItem[],
    summary: (job.summary ?? null) as VerificationSummary | null,
    errorCode: (job.errorCode ?? null) as ErrorCode | null,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

/** A job someone else owns doesn't exist, for this purpose as for reading it. Admins may use any. */
export async function loadOwnJob(ctx: Pick<AppContext, "db">, id: string, user: CurrentUser): Promise<JobRow> {
  const [job] = await ctx.db.select().from(VerificationJob).where(eq(VerificationJob.id, id));
  if (!job || (job.ownerId !== user.userId && user.role !== "admin")) throw new AppError("verify_job_not_found");
  if (job.status !== "done") throw new AppError("verify_fix_invalid", { reason: "job_not_done" });
  return job;
}

type Fix = { questionId: number; correctAnswer: string };
type Applied = NonNullable<ImportReport["verification"]>["acceptedFixes"];
type RawQuestion = Record<string, unknown>;

const sameQuestion = (a: RawQuestion, b: RawQuestion) =>
  a.question === b.question &&
  a.correctAnswer === b.correctAnswer &&
  JSON.stringify(a.options) === JSON.stringify(b.options);

/**
 * Puts a job's results on the value being saved. A result is only copied to the question it was computed for: an
 * edited question has none, since the check no longer applies to it. A suggested fix is applied here and nowhere
 * else, and only when it's listed in `fixes`; a Wrong answer left unconfirmed blocks the save (SPEC §3A.3.1).
 */
export function applyVerification(value: unknown, job: JobRow, fixes: Fix[], applied: Applied): unknown {
  const quiz = value as { questions?: unknown };
  if (!Array.isArray(quiz.questions)) return value;
  const input = (job.input as { questions: RawQuestion[] }).questions;
  const items = new Map(((job.items ?? []) as VerificationItem[]).map((i) => [i.questionId, i]));
  const accepted = new Map(fixes.map((f) => [f.questionId, f.correctAnswer]));
  const unknownFix = fixes.find((f) => items.get(f.questionId)?.suggestedFix !== f.correctAnswer);
  if (unknownFix) throw new AppError("verify_fix_invalid", { questionId: unknownFix.questionId });

  const unresolved: number[] = [];
  const questions = quiz.questions.map((raw, index) => {
    const q = raw as RawQuestion;
    const id = typeof q.id === "number" ? q.id : index + 1;
    const item = items.get(id);
    const original = input.find((o, i) => (typeof o.id === "number" ? o.id : i + 1) === id);
    if (!item || !original || !sameQuestion(q, original)) {
      if (accepted.has(id)) throw new AppError("verify_fix_invalid", { questionId: id });
      return q;
    }
    const fix = accepted.get(id);
    if (item.outcome === "wrong_answer" && fix === undefined) unresolved.push(id);
    if (fix === undefined) return { ...q, computable: item.computable, verification: item.verification };
    applied.push({ questionId: id, from: String(q.correctAnswer ?? ""), to: fix });
    return {
      ...q,
      correctAnswer: fix,
      computable: item.computable,
      verification: { ...item.verification, status: "computed", matchedOption: fix },
    };
  });
  if (unresolved.length > 0) {
    throw new AppError("import_invalid_quiz", { errors: unresolved.length, question: unresolved[0] as number });
  }
  return { ...quiz, questions };
}
