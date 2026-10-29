import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AuditLog, newId, PracticeAttempt, Response, TestVersion } from "@gem/db";
import { type Quiz, Result, shuffleAttempt } from "@gem/shared";
import type { PracticeAttemptDetail, PracticeAttemptSummary } from "@gem/shared/contracts";
import { eq } from "drizzle-orm";
import { API, type Client, createTestApp, hasDb, registerUser, signIn, type TestApp } from "./helpers.ts";

const FIXTURE = readFileSync(
  join(import.meta.dir, "..", "..", "..", "tests", "engr108_chapter1_new_20q_quiz.json"),
  "utf8",
);
const FIXED = FIXTURE.replace('"correctAnswer": "1"', '"correctAnswer": "-1"');

/** One question of every type, with weights, partial credit, an ignore list and evidence. */
const QUIZ: Quiz = {
  quiz_title: "Practice fixture",
  course: "ENGR108",
  total_questions: 5,
  topics_covered: ["Vectors", "Complexity"],
  questions: [
    {
      id: 1,
      topic: "Vectors",
      question: "Pick b",
      options: ["a", "b", "c", "d"],
      correctAnswer: "b",
      explanation: "Because b.",
    },
    {
      id: 2,
      topic: "Complexity",
      question: "Flops for a sum of n numbers?",
      correctAnswer: "n-1",
      ignoreWords: ["flops"],
      points: 2,
    },
    { id: 3, topic: "Vectors", question: "3.5?", type: "numeric", correctAnswer: "3.5", numericTolerance: 0.01 },
    {
      id: 4,
      topic: "Complexity",
      question: "Pick w and y",
      type: "multi_choice",
      options: ["w", "x", "y", "z"],
      correctAnswer: "w",
      correctAnswers: ["w", "y"],
      partialCredit: "proportional",
    },
    {
      id: 5,
      topic: "Sets",
      question: "True?",
      type: "true_false",
      options: ["True", "False"],
      correctAnswer: "True",
      evidence: [{ sourceId: "s", chunkId: "c", quote: "It is true." }],
    },
  ],
};

describe.skipIf(!hasDb)("practice API (F3)", () => {
  let t: TestApp;
  let owner: Client;
  let admin: Client;
  let testId = "";
  let versionId = "";
  let clock = Date.parse("2026-10-29T12:00:00.000Z");
  const tick = (ms: number) => {
    clock += ms;
  };

  const start = (kind: "full" | "retake_missed" = "full", id = testId, c = owner) =>
    c.post(`${API}/practice/attempts`, { testId: id, kind });
  const get = async (id: string, c = owner) =>
    (await c.get(`${API}/practice/attempts/${id}`)).json() as PracticeAttemptDetail;
  const put = (id: string, q: number, body: unknown, c = owner) =>
    c.put(`${API}/practice/attempts/${id}/responses/${q}`, body);
  const selfGrade = (id: string, q: number, right: boolean, c = owner) =>
    c.post(`${API}/practice/attempts/${id}/responses/${q}/self-grade`, { right });
  const submit = (id: string, c = owner) => c.post(`${API}/practice/attempts/${id}/submit`);
  const row = async (id: string) => (await t.db.select().from(PracticeAttempt).where(eq(PracticeAttempt.id, id)))[0];

  beforeAll(async () => {
    t = await createTestApp();
    t.ctx.now = () => new Date(clock);
    admin = (await registerUser(t.app, "admin@example.com")).client;
    const o = await registerUser(t.app, "owner@example.com");
    await admin.put(`${API}/admin/users/${o.user.id}/roles`, { role: "proctor" });
    owner = (await signIn(t.app, "owner@example.com")).client;
    const text = JSON.stringify(QUIZ);
    const created = await owner.post(`${API}/imports`, { originalText: text, text });
    expect(created.statusCode).toBe(200);
    ({ testId, versionId } = created.json());
  });
  afterAll(async () => t?.close());

  let a1 = "";

  test("B13: retake_missed with no submitted attempt → 409 practice_nothing_to_retake", async () => {
    const res = await start("retake_missed");
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("practice_nothing_to_retake");
  });

  test("B13: full pins the latest version, stores the seed and maxScore; a second start → 409 with attemptId", async () => {
    const res = await start();
    expect(res.statusCode).toBe(200);
    const attempt = res.json().attempt as PracticeAttemptSummary;
    a1 = attempt.id;
    expect(attempt).toMatchObject({
      testId,
      testVersionId: versionId,
      versionNumber: 1,
      kind: "full",
      status: "in_progress",
      score: null,
      maxScore: 6,
      questionCount: 5,
      submittedAt: null,
      durationMs: null,
    });
    const r = await row(a1);
    expect(r?.shuffleSeed).toMatch(/^[0-9a-f]{32}$/);
    expect(r?.questionIds).toBeNull();
    expect(r?.maxScore).toBe(6);
    const again = await start();
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ code: "practice_attempt_in_progress", params: { attemptId: a1 } });
  });

  test("B13: an archived test can't be started (409 test_archived)", async () => {
    await owner.patch(`${API}/tests/${testId}`, { archived: true });
    const res = await start();
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("test_archived");
    await owner.patch(`${API}/tests/${testId}`, { archived: false });
  });

  test("B14: questions in the seeded order with shuffled options, stable across requests", async () => {
    const d = await get(a1);
    const seed = (await row(a1))?.shuffleSeed as string;
    const expected = shuffleAttempt(seed, QUIZ.questions);
    expect(d.questions.map((q) => q.id)).toEqual(expected.questionIds);
    for (const q of d.questions) {
      if (q.options) expect(q.options).toEqual(expected.options[q.id] as string[]);
    }
    expect(d.questions.find((q) => q.id === 5)?.options).toEqual(["True", "False"]);
    expect(d.quizOrder).toEqual([1, 2, 3, 4, 5]);
    expect(d.responses.map((r) => r.questionId)).toEqual(expected.questionIds);
    // Practice sends answers and explanations (SPEC §6).
    expect(d.questions.find((q) => q.id === 1)).toMatchObject({ correctAnswer: "b", explanation: "Because b." });
    expect(d.quiz).toEqual({ title: "Practice fixture", course: "ENGR108", topicsCovered: ["Vectors", "Complexity"] });
    expect(await get(a1)).toEqual(d);
  });

  test("B15: check grades on the server and returns the feedback; the answer is then locked", async () => {
    tick(5_000);
    const res = await put(a1, 1, { answer: "a", check: true, timeSpentMs: 4_000 });
    expect(res.statusCode).toBe(200);
    expect(res.json().feedback).toEqual({
      outcome: "incorrect",
      pointsAwarded: 0,
      maxPoints: 1,
      correctAnswer: "b",
      explanation: "Because b.",
    });
    expect(res.json().response).toMatchObject({
      questionId: 1,
      answer: "a",
      autoResult: "incorrect",
      timeSpentMs: 4_000,
    });

    for (const body of [{ check: true }, { answer: "b" }, { answer: "b", check: true }]) {
      const locked = await put(a1, 1, body);
      expect(locked.statusCode).toBe(409);
      expect(locked.json().code).toBe("practice_answer_locked");
    }
    // flagged and timeSpentMs stay writable after the check.
    const flag = await put(a1, 1, { flagged: true, timeSpentMs: 4_500 });
    expect(flag.statusCode).toBe(200);
    expect(flag.json().response).toMatchObject({ flagged: true, timeSpentMs: 4_500, answer: "a" });
    expect(flag.json().feedback.outcome).toBe("incorrect");
  });

  test("B15: multi_choice partial credit and short answers are graded by the server; unchecked drafts are stored ungraded", async () => {
    const multi = await put(a1, 4, { answer: ["w"], check: true });
    expect(multi.json().feedback).toMatchObject({
      outcome: "partial",
      pointsAwarded: 0.5,
      maxPoints: 1,
      correctAnswers: ["w", "y"],
    });
    const short = await put(a1, 2, { answer: "n minus 1", check: true });
    expect(short.json().feedback).toMatchObject({ outcome: "incorrect", pointsAwarded: 0, maxPoints: 2 });
    // An unchecked draft answer is stored without a grade.
    const draft = await put(a1, 3, { answer: "3.505" });
    expect(draft.json()).toMatchObject({ feedback: null, response: { answer: "3.505", autoResult: null } });
  });

  test("B15: a question outside the attempt → 404 practice_question_not_in_attempt; check without an answer → 400", async () => {
    const res = await put(a1, 99, { flagged: true });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("practice_question_not_in_attempt");
    const empty = await put(a1, 5, { check: true });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ code: "validation_failed", params: { field: "answer" } });
  });

  test("B16: timeSpentMs keeps the maximum and is capped at the time since start", async () => {
    const big = await put(a1, 5, { timeSpentMs: 10_000_000 });
    expect(big.json().response.timeSpentMs).toBe(5_000); // started 5 s ago on the test clock
    const smaller = await put(a1, 5, { timeSpentMs: 1_000 });
    expect(smaller.json().response.timeSpentMs).toBe(5_000);
    tick(1_000);
    expect((await put(a1, 5, { timeSpentMs: 5_800 })).json().response.timeSpentMs).toBe(5_800);
    expect((await put(a1, 5, { timeSpentMs: -1 })).statusCode).toBe(400);
  });

  test("B18: self-grade during the attempt, undo, and refused where not allowed", async () => {
    const yes = await selfGrade(a1, 2, true);
    expect(yes.statusCode).toBe(200);
    expect(yes.json().response).toMatchObject({ selfGraded: true, pointsAwarded: 2, autoResult: "incorrect" });
    expect(yes.json().attempt.score).toBeNull(); // not submitted yet
    const undo = await selfGrade(a1, 2, false);
    expect(undo.json().response).toMatchObject({ selfGraded: false, pointsAwarded: 0 });
    expect((await selfGrade(a1, 2, true)).statusCode).toBe(200);
    // Not a short answer / not graded yet.
    for (const q of [1, 3, 4, 5]) {
      const res = await selfGrade(a1, q, true);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("practice_self_grade_not_allowed");
    }
  });

  test("B17 + B16: submit stores score (incl. self-grade), submittedAt and the server's duration; unanswered score 0", async () => {
    tick(60_000);
    const before = (await t.db.select().from(AuditLog)).length;
    const res = await submit(a1);
    expect(res.statusCode).toBe(200);
    // q1 0 + q2 2 (self-graded) + q3 1 (draft graded at submit) + q4 0.5 + q5 unanswered 0
    expect(res.json().attempt).toMatchObject({ status: "submitted", score: 3.5, maxScore: 6, durationMs: 66_000 });
    const r = await row(a1);
    expect(r?.submittedAt?.toISOString()).toBe(new Date(clock).toISOString());
    expect(r?.durationMs).toBe((r?.submittedAt?.getTime() ?? 0) - (r?.startedAt.getTime() ?? 0));
    const q3 = (await get(a1)).responses.find((x) => x.questionId === 3);
    expect(q3).toMatchObject({ autoResult: "correct", pointsAwarded: 1 });
    // Practice actions are not audited (P1.md §4).
    expect((await t.db.select().from(AuditLog)).length).toBe(before);
  });

  test("B15: any write after submit → 409 practice_attempt_submitted; discard refuses a submitted attempt (B22)", async () => {
    for (const res of [
      await put(a1, 5, { flagged: true }),
      await submit(a1),
      await owner.delete(`${API}/practice/attempts/${a1}`),
    ]) {
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("practice_attempt_submitted");
    }
  });

  test("B18: self-grade after submit; the stored score follows", async () => {
    const undo = await selfGrade(a1, 2, false);
    expect(undo.json().attempt.score).toBe(1.5);
    expect((await row(a1))?.score).toBe(1.5);
    const redo = await selfGrade(a1, 2, true);
    expect(redo.json().attempt.score).toBe(3.5);
    expect((await row(a1))?.score).toBe(3.5);
  });

  test("B20: export is a valid Result in the test's order with mode, attemptId, times and selfGraded; it re-imports", async () => {
    const res = await owner.get(`${API}/practice/attempts/${a1}/export`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("attachment;");
    const parsed = Result.safeParse(JSON.parse(res.body));
    expect(parsed.success).toBe(true);
    const result = JSON.parse(res.body) as Result;
    const r = await row(a1);
    expect(result).toMatchObject({
      mode: "practice",
      attemptId: a1,
      startedAt: r?.startedAt.toISOString(),
      submittedAt: r?.submittedAt?.toISOString(),
      score: 3.5,
      maxScore: 6,
      percentage: 58.33,
      total_questions: 5,
    });
    expect(result.questions.map((q) => q.id)).toEqual([1, 2, 3, 4, 5]);
    expect(result.questions[0]?.options).toEqual(["a", "b", "c", "d"]); // not shuffled
    expect(result.questions[1]).toMatchObject({ userAnswer: "n minus 1", userIsCorrect: true, selfGraded: true });
    expect(result.questions[2]).toMatchObject({ userAnswer: "3.505", userIsCorrect: true });
    expect(result.questions[3]).toMatchObject({
      userAnswer: "w",
      userAnswers: ["w"],
      userIsCorrect: false,
      pointsAwarded: 0.5,
    });
    expect(result.questions[4]).toMatchObject({ userAnswer: "", userIsCorrect: false });
    const preview = await owner.post(`${API}/imports/preview`, { text: res.body });
    expect(preview.json().report.errors).toEqual([]);
    expect(preview.json().report.canSave).toBe(true);
  });

  let retake = "";

  test("B13: retake_missed stores exactly the missed ids and pins that attempt's version", async () => {
    // A newer version exists now; the retake still uses the version it retakes.
    const v2 = newId();
    await t.db.insert(TestVersion).values({ id: v2, testId, versionNumber: 2, content: { ...QUIZ, quiz_title: "v2" } });
    const res = await start("retake_missed");
    expect(res.statusCode).toBe(200);
    const attempt = res.json().attempt as PracticeAttemptSummary;
    retake = attempt.id;
    expect(attempt).toMatchObject({ kind: "retake_missed", testVersionId: versionId, questionCount: 3, maxScore: 3 });
    expect((await row(retake))?.questionIds).toEqual([1, 4, 5]); // q2 self-graded, q3 correct
    const d = await get(retake);
    expect([...d.quizOrder]).toEqual([1, 4, 5]);
    expect(d.questions.map((q) => q.id).sort()).toEqual([1, 4, 5]);
    expect((await put(retake, 2, { flagged: true })).json().code).toBe("practice_question_not_in_attempt");
    const exp = await owner.get(`${API}/practice/attempts/${retake}/export`);
    expect(exp.statusCode).toBe(409);
    expect(exp.json().code).toBe("practice_attempt_not_submitted");
  });

  test("B13: full pins the latest version (v2) while the retake on v1 is in progress", async () => {
    const res = await start();
    expect(res.statusCode).toBe(200);
    expect(res.json().attempt).toMatchObject({ versionNumber: 2, testTitle: expect.any(String) });
    expect((await get(res.json().attempt.id)).quiz.title).toBe("v2");
    // B22: discard deletes it and its responses.
    const id = res.json().attempt.id as string;
    await put(id, 1, { answer: "b", check: true });
    expect(await t.db.select().from(Response).where(eq(Response.attemptId, id))).toHaveLength(1);
    const del = await owner.delete(`${API}/practice/attempts/${id}`);
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });
    expect(await row(id)).toBeUndefined();
    expect(await t.db.select().from(Response).where(eq(Response.attemptId, id))).toHaveLength(0);
    expect((await owner.get(`${API}/practice/attempts/${id}`)).statusCode).toBe(404);
  });

  test("B20: a retake-missed export holds only its subset with total_questions recomputed", async () => {
    await put(retake, 1, { answer: "b", check: true });
    await put(retake, 4, { answer: ["w", "y"], check: true });
    await put(retake, 5, { answer: "True", check: true });
    tick(1_000);
    expect((await submit(retake)).json().attempt).toMatchObject({ score: 3, maxScore: 3 });
    const result = JSON.parse((await owner.get(`${API}/practice/attempts/${retake}/export`)).body) as Result;
    expect(Result.safeParse(result).success).toBe(true);
    expect(result.questions.map((q) => q.id)).toEqual([1, 4, 5]);
    expect(result).toMatchObject({ total_questions: 3, score: 3, percentage: 100 });
    // Nothing missed in the most recent attempt → nothing to retake.
    const res = await start("retake_missed");
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("practice_nothing_to_retake");
  });

  test("B19: history lists only the caller's attempts for the test, newest first, with the summary fields", async () => {
    // The admin practises the same test: their attempt isn't in the owner's history.
    tick(1_000);
    expect((await start("full", testId, admin)).statusCode).toBe(200);
    const res = await owner.get(`${API}/practice/attempts?testId=${testId}`);
    expect(res.statusCode).toBe(200);
    const { attempts, missedCount } = res.json() as { attempts: PracticeAttemptSummary[]; missedCount: number };
    expect(attempts.map((a) => a.id)).toEqual([retake, a1]);
    expect(attempts[0]).toMatchObject({
      kind: "retake_missed",
      status: "submitted",
      score: 3,
      maxScore: 3,
      questionCount: 3,
    });
    expect(attempts[1]).toMatchObject({
      kind: "full",
      status: "submitted",
      score: 3.5,
      maxScore: 6,
      durationMs: 66_000,
    });
    expect(missedCount).toBe(0);
    const adminHistory = (await admin.get(`${API}/practice/attempts?testId=${testId}`)).json();
    expect(adminHistory.attempts).toHaveLength(1);
    expect(adminHistory.attempts[0]).toMatchObject({ status: "in_progress", versionNumber: 2 });
    expect(adminHistory.missedCount).toBeNull();
    // Across tests, with a limit (the home page's recent attempts).
    const recent = (await owner.get(`${API}/practice/attempts?limit=1`)).json();
    expect(recent.attempts.map((a: PracticeAttemptSummary) => a.id)).toEqual([retake]);
  });

  test("B14: two attempts with different seeds differ (20-question fixture)", async () => {
    const created = await owner.post(`${API}/imports`, { originalText: FIXED, text: FIXED });
    const id = created.json().testId as string;
    const first = (await start("full", id)).json().attempt.id as string;
    await submit(first);
    const second = (await start("full", id)).json().attempt.id as string;
    const [x, y] = [await get(first), await get(second)];
    expect((await row(first))?.shuffleSeed).not.toBe((await row(second))?.shuffleSeed);
    expect(x.questions.map((q) => q.id)).not.toEqual(y.questions.map((q) => q.id));
    expect([...x.questions.map((q) => q.id)].sort((a, b) => a - b)).toEqual(
      [...y.questions.map((q) => q.id)].sort((a, b) => a - b),
    );
  });
});
