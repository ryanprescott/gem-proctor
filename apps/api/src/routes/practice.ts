import type { Db } from "@gem/db";
import { newId, PracticeAttempt, Response, Test, TestVersion } from "@gem/db";
import {
  AppError,
  applyShuffle,
  effectiveType,
  type GradeOutcome,
  gradeResponse,
  newShuffleSeed,
  type Question,
  type QuestionResponse,
  type Quiz,
  round2,
  serializeResult,
  shuffleAttempt,
  toResult,
} from "@gem/shared";
import {
  type PracticeAnswer,
  type PracticeAttemptSummary,
  type PracticeFeedback,
  type PracticeResponse,
  practiceDiscard,
  practiceExport,
  practiceGet,
  practiceList,
  practiceSaveResponse,
  practiceSelfGrade,
  practiceStart,
  practiceSubmit,
} from "@gem/shared/contracts";
import { and, desc, eq, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { route } from "../http/route.ts";

/**
 * Practice mode (SPEC §6, P1.md §5–§6). Attempts are private: every query is scoped by the caller's id (the
 * authz preHandler already returned 404 for anyone else's). Grading happens here, with the shared grader;
 * practice actions are not admin actions, so nothing is written to the audit log.
 */

type AttemptRow = typeof PracticeAttempt.$inferSelect;
type ResponseRow = typeof Response.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Conn = Db | Tx;

interface LoadedAttempt {
  attempt: AttemptRow;
  testId: string;
  testTitle: string;
  versionNumber: number;
  content: Quiz;
}

const pgCode = (e: unknown): string | undefined => {
  const err = e as { code?: string; cause?: { code?: string } };
  return err.cause?.code ?? err.code;
};

/** The attempt's questions in the test's own order: all of them, or a retake's subset. */
function attemptQuestions(content: Quiz, attempt: Pick<AttemptRow, "questionIds">): Question[] {
  if (!attempt.questionIds) return content.questions;
  const ids = new Set(attempt.questionIds);
  return content.questions.filter((q) => ids.has(q.id));
}

const maxPointsOf = (questions: readonly Question[]) => round2(questions.reduce((s, q) => s + (q.points ?? 1), 0));

function summaryOf(l: LoadedAttempt): PracticeAttemptSummary {
  const a = l.attempt;
  return {
    id: a.id,
    testId: l.testId,
    testTitle: l.testTitle,
    testVersionId: a.testVersionId,
    versionNumber: l.versionNumber,
    kind: a.kind,
    status: a.submittedAt ? "submitted" : "in_progress",
    startedAt: a.startedAt.toISOString(),
    submittedAt: a.submittedAt?.toISOString() ?? null,
    durationMs: a.durationMs,
    score: a.score,
    maxScore: a.maxScore,
    questionCount: a.questionIds?.length ?? l.content.questions.length,
  };
}

function responseOf(q: Question, r: ResponseRow | undefined): PracticeResponse {
  return {
    questionId: q.id,
    answer: (r?.answer as PracticeAnswer | null | undefined) ?? null,
    autoResult: r?.autoResult ?? null,
    pointsAwarded: r?.pointsAwarded ?? 0,
    maxPoints: q.points ?? 1,
    selfGraded: r?.selfGraded ?? false,
    flagged: r?.flagged ?? false,
    answeredAt: r?.answeredAt?.toISOString() ?? null,
    timeSpentMs: r?.timeSpentMs ?? 0,
  };
}

function feedbackOf(q: Question, r: ResponseRow): PracticeFeedback | null {
  if (!r.autoResult) return null;
  const f: PracticeFeedback = {
    outcome: r.autoResult,
    pointsAwarded: r.pointsAwarded,
    maxPoints: q.points ?? 1,
    correctAnswer: q.correctAnswer,
  };
  if (effectiveType(q) === "multi_choice") f.correctAnswers = q.correctAnswers ?? [q.correctAnswer];
  if (q.explanation !== undefined) f.explanation = q.explanation;
  return f;
}

async function loadAttempt(db: Conn, id: string, userId: string, forUpdate = false): Promise<LoadedAttempt> {
  const query = db
    .select({
      attempt: PracticeAttempt,
      testId: Test.id,
      testTitle: Test.title,
      versionNumber: TestVersion.versionNumber,
      content: TestVersion.content,
    })
    .from(PracticeAttempt)
    .innerJoin(TestVersion, eq(TestVersion.id, PracticeAttempt.testVersionId))
    .innerJoin(Test, eq(Test.id, TestVersion.testId))
    .where(and(eq(PracticeAttempt.id, id), eq(PracticeAttempt.userId, userId)))
    .limit(1);
  const rows = forUpdate ? await query.for("update", { of: PracticeAttempt }) : await query;
  const row = rows[0];
  if (!row) throw new AppError("not_found");
  return { ...row, content: row.content as Quiz };
}

async function responsesOf(db: Conn, attemptId: string): Promise<Map<number, ResponseRow>> {
  const rows = await db.select().from(Response).where(eq(Response.attemptId, attemptId));
  return new Map(rows.map((r) => [r.questionId, r]));
}

/** Sum of the stored points (self-grades included) over the attempt's questions. */
function scoreOf(questions: readonly Question[], responses: Map<number, ResponseRow>): number {
  return round2(questions.reduce((s, q) => s + (responses.get(q.id)?.pointsAwarded ?? 0), 0));
}

/**
 * "Missed" (P1.md §5): every question of the attempt that didn't get full points after self-grading,
 * unanswered ones included. In the test's own order.
 */
function missedIds(questions: readonly Question[], responses: Map<number, ResponseRow>): number[] {
  return questions.filter((q) => (responses.get(q.id)?.pointsAwarded ?? 0) < (q.points ?? 1)).map((q) => q.id);
}

/** The caller's most recent submitted attempt on a test (any version, either kind). */
async function lastSubmitted(db: Conn, userId: string, testId: string) {
  const rows = await db
    .select({ attempt: PracticeAttempt, content: TestVersion.content })
    .from(PracticeAttempt)
    .innerJoin(TestVersion, eq(TestVersion.id, PracticeAttempt.testVersionId))
    .where(
      and(eq(PracticeAttempt.userId, userId), eq(TestVersion.testId, testId), isNotNull(PracticeAttempt.submittedAt)),
    )
    .orderBy(desc(PracticeAttempt.submittedAt), desc(PracticeAttempt.id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const content = row.content as Quiz;
  const missed = missedIds(attemptQuestions(content, row.attempt), await responsesOf(db, row.attempt.id));
  return { attempt: row.attempt, missed };
}

function findQuestion(l: LoadedAttempt, questionId: number): Question {
  const q = attemptQuestions(l.content, l.attempt).find((x) => x.id === questionId);
  if (!q) throw new AppError("practice_question_not_in_attempt", { questionId });
  return q;
}

function assertInProgress(a: AttemptRow) {
  if (a.submittedAt) throw new AppError("practice_attempt_submitted");
}

const slug = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 80) || "quiz";

export function practiceRoutes(app: FastifyInstance, ctx: AppContext) {
  route(app, practiceStart, async ({ body, user }) => {
    const [test] = await ctx.db.select().from(Test).where(eq(Test.id, body.testId)).limit(1);
    if (!test) throw new AppError("test_not_found");
    // The test owner (proctor) or an admin may practise it (P1.md §5).
    const rel = test.ownerId === user.userId ? "owner" : "none";
    if (!(await ctx.authz.can(user.userId, "test", "practice", rel))) throw new AppError("forbidden");
    if (test.archivedAt) throw new AppError("test_archived");

    let versionId: string;
    let content: Quiz;
    let questionIds: number[] | null = null;
    if (body.kind === "full") {
      const [latest] = await ctx.db
        .select({ id: TestVersion.id, content: TestVersion.content })
        .from(TestVersion)
        .where(eq(TestVersion.testId, test.id))
        .orderBy(desc(TestVersion.versionNumber))
        .limit(1);
      if (!latest) throw new AppError("test_not_found");
      versionId = latest.id;
      content = latest.content as Quiz;
    } else {
      const last = await lastSubmitted(ctx.db, user.userId, test.id);
      if (!last || last.missed.length === 0) throw new AppError("practice_nothing_to_retake");
      const [v] = await ctx.db
        .select({ content: TestVersion.content })
        .from(TestVersion)
        .where(eq(TestVersion.id, last.attempt.testVersionId));
      versionId = last.attempt.testVersionId;
      content = v?.content as Quiz;
      questionIds = last.missed;
    }

    const inProgress = async () => {
      const [row] = await ctx.db
        .select({ id: PracticeAttempt.id })
        .from(PracticeAttempt)
        .where(
          and(
            eq(PracticeAttempt.userId, user.userId),
            eq(PracticeAttempt.testVersionId, versionId),
            isNull(PracticeAttempt.submittedAt),
          ),
        )
        .limit(1);
      return row?.id;
    };
    const existing = await inProgress();
    if (existing) throw new AppError("practice_attempt_in_progress", { attemptId: existing });

    const id = newId();
    const questions = attemptQuestions(content, { questionIds });
    try {
      await ctx.db.insert(PracticeAttempt).values({
        id,
        userId: user.userId,
        testVersionId: versionId,
        kind: body.kind,
        shuffleSeed: newShuffleSeed(),
        questionIds,
        startedAt: ctx.now(),
        maxScore: maxPointsOf(questions),
      });
    } catch (e) {
      // A concurrent start won the partial unique index.
      if (pgCode(e) === "23505") {
        throw new AppError("practice_attempt_in_progress", { attemptId: (await inProgress()) ?? "" });
      }
      throw e;
    }
    return { attempt: summaryOf(await loadAttempt(ctx.db, id, user.userId)) };
  });

  route(app, practiceList, async ({ query, user }) => {
    const conds: SQL[] = [eq(PracticeAttempt.userId, user.userId)];
    if (query.testId) conds.push(eq(TestVersion.testId, query.testId));
    const base = ctx.db
      .select({
        attempt: PracticeAttempt,
        testId: Test.id,
        testTitle: Test.title,
        versionNumber: TestVersion.versionNumber,
        questionCount: sql<number>`jsonb_array_length(${TestVersion.content}->'questions')`,
      })
      .from(PracticeAttempt)
      .innerJoin(TestVersion, eq(TestVersion.id, PracticeAttempt.testVersionId))
      .innerJoin(Test, eq(Test.id, TestVersion.testId))
      .where(and(...conds))
      .orderBy(desc(PracticeAttempt.startedAt), desc(PracticeAttempt.id));
    const rows = query.limit ? await base.limit(query.limit) : await base;
    const attempts = rows.map((r) =>
      summaryOf({
        attempt: r.attempt,
        testId: r.testId,
        testTitle: r.testTitle,
        versionNumber: r.versionNumber,
        // Only the question count is read from the content here.
        content: { questions: { length: Number(r.questionCount) } } as unknown as Quiz,
      }),
    );
    const missedCount = query.testId
      ? ((await lastSubmitted(ctx.db, user.userId, query.testId))?.missed.length ?? null)
      : null;
    return { attempts, missedCount };
  });

  route(app, practiceGet, async ({ params, user }) => {
    const l = await loadAttempt(ctx.db, params.id, user.userId);
    const questions = attemptQuestions(l.content, l.attempt);
    // The server applies the shuffle, so the DOM order is the display order (P1.md §5).
    const shown = applyShuffle(shuffleAttempt(l.attempt.shuffleSeed, questions), questions);
    const responses = await responsesOf(ctx.db, l.attempt.id);
    return {
      attempt: summaryOf(l),
      quiz: {
        title: l.content.quiz_title,
        ...(l.content.course !== undefined ? { course: l.content.course } : {}),
        ...(l.content.chapter !== undefined ? { chapter: l.content.chapter } : {}),
        topicsCovered: l.content.topics_covered ?? [],
      },
      questions: shown,
      quizOrder: questions.map((q) => q.id),
      responses: shown.map((q) => responseOf(q, responses.get(q.id))),
    };
  });

  route(app, practiceSaveResponse, async ({ params, body, user }) => {
    return ctx.db.transaction(async (tx) => {
      const l = await loadAttempt(tx, params.id, user.userId, true);
      assertInProgress(l.attempt);
      const q = findQuestion(l, params.questionId);
      const [existing] = await tx
        .select()
        .from(Response)
        .where(and(eq(Response.attemptId, l.attempt.id), eq(Response.questionId, q.id)));

      const now = ctx.now();
      const set: Partial<typeof Response.$inferInsert> = {};
      if (body.answer !== undefined || body.check) {
        // Checked once, then locked: otherwise immediate feedback would make the score meaningless.
        if (existing?.autoResult) throw new AppError("practice_answer_locked", { questionId: q.id });
        if (body.answer !== undefined) set.answer = body.answer;
      }
      if (body.check) {
        const answer = body.answer ?? (existing?.answer as PracticeAnswer | null | undefined) ?? null;
        const empty = answer === null || (Array.isArray(answer) ? answer.length === 0 : answer.trim() === "");
        if (empty) throw new AppError("validation_failed", { field: "answer" });
        const grade = gradeResponse(q, answer);
        set.autoResult = grade.outcome;
        set.pointsAwarded = grade.pointsAwarded;
        set.answeredAt = now;
      }
      if (body.flagged !== undefined) set.flagged = body.flagged;
      if (body.timeSpentMs !== undefined) {
        // Cumulative from the client: keep the maximum, never more than the time since the start.
        const sinceStart = Math.max(0, now.getTime() - l.attempt.startedAt.getTime());
        set.timeSpentMs = Math.min(Math.max(existing?.timeSpentMs ?? 0, body.timeSpentMs), sinceStart);
      }

      let row: ResponseRow | undefined;
      if (existing) {
        [row] = await tx.update(Response).set(set).where(eq(Response.id, existing.id)).returning();
      } else {
        [row] = await tx
          .insert(Response)
          .values({ id: newId(), attemptId: l.attempt.id, questionId: q.id, ...set })
          .returning();
      }
      if (!row) throw new AppError("internal");
      return { response: responseOf(q, row), feedback: feedbackOf(q, row) };
    });
  });

  route(app, practiceSelfGrade, async ({ params, body, user }) => {
    return ctx.db.transaction(async (tx) => {
      const l = await loadAttempt(tx, params.id, user.userId, true);
      const q = findQuestion(l, params.questionId);
      const [r] = await tx
        .select()
        .from(Response)
        .where(and(eq(Response.attemptId, l.attempt.id), eq(Response.questionId, q.id)));
      // Only a short answer that was given, checked (or graded at submit) and graded incorrect (P1.md §5).
      const answered = typeof r?.answer === "string" && r.answer.trim() !== "";
      if (!r || effectiveType(q) !== "short_answer" || r.autoResult !== "incorrect" || !answered) {
        throw new AppError("practice_self_grade_not_allowed", { questionId: q.id });
      }
      const [row] = await tx
        .update(Response)
        .set({ selfGraded: body.right, pointsAwarded: body.right ? (q.points ?? 1) : 0 })
        .where(eq(Response.id, r.id))
        .returning();
      if (!row) throw new AppError("internal");
      let attempt = l.attempt;
      if (attempt.submittedAt) {
        const score = scoreOf(attemptQuestions(l.content, attempt), await responsesOf(tx, attempt.id));
        const [updated] = await tx
          .update(PracticeAttempt)
          .set({ score })
          .where(eq(PracticeAttempt.id, attempt.id))
          .returning();
        if (updated) attempt = updated;
      }
      return { response: responseOf(q, row), attempt: summaryOf({ ...l, attempt }) };
    });
  });

  route(app, practiceSubmit, async ({ params, user }) => {
    return ctx.db.transaction(async (tx) => {
      const l = await loadAttempt(tx, params.id, user.userId, true);
      assertInProgress(l.attempt);
      const questions = attemptQuestions(l.content, l.attempt);
      const responses = await responsesOf(tx, l.attempt.id);
      const now = ctx.now();
      // Answers saved but never checked are graded now; unanswered questions score 0.
      for (const q of questions) {
        const r = responses.get(q.id);
        if (!r || r.autoResult || r.answer === null) continue;
        const grade = gradeResponse(q, r.answer as PracticeAnswer);
        const [row] = await tx
          .update(Response)
          .set({ autoResult: grade.outcome as GradeOutcome, pointsAwarded: grade.pointsAwarded, answeredAt: now })
          .where(eq(Response.id, r.id))
          .returning();
        if (row) responses.set(q.id, row);
      }
      const [attempt] = await tx
        .update(PracticeAttempt)
        .set({
          submittedAt: now,
          durationMs: Math.max(0, now.getTime() - l.attempt.startedAt.getTime()),
          score: scoreOf(questions, responses),
        })
        .where(eq(PracticeAttempt.id, l.attempt.id))
        .returning();
      if (!attempt) throw new AppError("internal");
      return { attempt: summaryOf({ ...l, attempt }) };
    });
  });

  route(app, practiceDiscard, async ({ params, user }) => {
    return ctx.db.transaction(async (tx) => {
      const l = await loadAttempt(tx, params.id, user.userId, true);
      assertInProgress(l.attempt);
      await tx.delete(PracticeAttempt).where(eq(PracticeAttempt.id, l.attempt.id));
      return { ok: true as const };
    });
  });

  route(app, practiceExport, async ({ params, user, reply }) => {
    const l = await loadAttempt(ctx.db, params.id, user.userId);
    const a = l.attempt;
    if (!a.submittedAt) throw new AppError("practice_attempt_not_submitted");
    // The test's own order (not shuffled), only the attempt's questions, with the stored grades (P1.md §5).
    const questions = attemptQuestions(l.content, a);
    const responses = await responsesOf(ctx.db, a.id);
    const stored: QuestionResponse[] = [];
    for (const q of questions) {
      const r = responses.get(q.id);
      if (!r || r.answer === null) continue;
      stored.push({
        questionId: q.id,
        answer: r.answer as PracticeAnswer,
        grade: { outcome: r.autoResult ?? "incorrect", pointsAwarded: r.pointsAwarded },
        selfGraded: r.selfGraded,
      });
    }
    const result = toResult({ ...l.content, questions, total_questions: questions.length }, stored, {
      mode: "practice",
      attemptId: a.id,
      startedAt: a.startedAt.toISOString(),
      submittedAt: a.submittedAt.toISOString(),
    });
    const date = a.submittedAt.toISOString().slice(0, 10);
    reply.header("content-type", "application/json; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="${slug(l.testTitle)}-result-${date}.json"`);
    return serializeResult(result);
  });
}
