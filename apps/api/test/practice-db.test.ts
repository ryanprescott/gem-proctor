import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, createPool, type Db, newId, PracticeAttempt, Response, Test, TestVersion, User } from "@gem/db";
import { eq } from "drizzle-orm";
import type pg from "pg";
import { createTestDatabase, hasDb, type TestDatabase } from "./helpers.ts";

/** Drizzle queries are thenables, not promises, so `expect().rejects` can't take them. */
async function fails(q: PromiseLike<unknown>, sqlstate: string): Promise<void> {
  let error: unknown;
  try {
    await q;
  } catch (e) {
    error = e;
  }
  const err = error as { code?: string; cause?: { code?: string } } | undefined;
  expect(err?.cause?.code ?? err?.code).toBe(sqlstate);
}

const UNIQUE = "23505";
const CHECK = "23514";
const FK = "23503";

/** B10, B11: the practice tables, their constraints and grants, checked as gem_app (P1.md §4). */
describe.skipIf(!hasDb)("practice tables", () => {
  let database: TestDatabase;
  let pool: pg.Pool;
  let db: Db;
  let userId = "";
  let versionId = "";
  const seed = "0123456789abcdef0123456789abcdef";

  beforeAll(async () => {
    database = await createTestDatabase();
    pool = createPool(database.appUrl, 2);
    db = createDb(pool);
    userId = newId();
    await db.insert(User).values({ id: userId, email: "p@example.com", passwordHash: "x", displayName: "P" });
    const testId = newId();
    await db.insert(Test).values({ id: testId, ownerId: userId, title: "T" });
    versionId = newId();
    await db.insert(TestVersion).values({ id: versionId, testId, versionNumber: 1, content: {} });
  });
  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  const attempt = (over: Partial<typeof PracticeAttempt.$inferInsert> = {}) => ({
    id: newId(),
    userId,
    testVersionId: versionId,
    kind: "full" as const,
    shuffleSeed: seed,
    maxScore: 20,
    ...over,
  });

  test("B11: gem_app has SELECT, INSERT, UPDATE, DELETE on both tables; audit_log stays SELECT/INSERT", async () => {
    const r = await pool.query(
      `SELECT t, p, has_table_privilege(current_user, t, p) AS ok
         FROM unnest(ARRAY['practice_attempt', 'response', 'audit_log']) t,
              unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p`,
    );
    const got = Object.fromEntries(r.rows.map((x) => [`${x.t}:${x.p}`, x.ok]));
    for (const t of ["practice_attempt", "response"]) {
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) expect(got[`${t}:${p}`]).toBe(true);
    }
    expect(got["audit_log:SELECT"]).toBe(true);
    expect(got["audit_log:INSERT"]).toBe(true);
    expect(got["audit_log:UPDATE"]).toBe(false);
    expect(got["audit_log:DELETE"]).toBe(false);
    expect((await pool.query("SELECT current_user AS u")).rows[0].u).toBe("gem_app");
  });

  test("B10: at most one in-progress attempt per user and version (partial unique index)", async () => {
    const first = attempt();
    await db.insert(PracticeAttempt).values(first);
    await fails(db.insert(PracticeAttempt).values(attempt()), UNIQUE);
    // Once the first is submitted, a new one can start.
    await db
      .update(PracticeAttempt)
      .set({ submittedAt: new Date(), score: 12.5, durationMs: 60_000 })
      .where(eq(PracticeAttempt.id, first.id));
    const second = attempt();
    await db.insert(PracticeAttempt).values(second);
    await db.delete(PracticeAttempt).where(eq(PracticeAttempt.id, second.id));
  });

  test("B10: points round-trip exactly at two decimals; durations are bigint", async () => {
    const a = attempt({ maxScore: 7.5, submittedAt: new Date(), score: 1.67, durationMs: 3_000_000_000 });
    await db.insert(PracticeAttempt).values(a);
    const [row] = await db.select().from(PracticeAttempt).where(eq(PracticeAttempt.id, a.id));
    expect(row).toMatchObject({ score: 1.67, maxScore: 7.5, durationMs: 3_000_000_000 });
    await db.insert(Response).values({ id: newId(), attemptId: a.id, questionId: 1, pointsAwarded: 0.33 });
    const [resp] = await db.select().from(Response).where(eq(Response.attemptId, a.id));
    expect(resp?.pointsAwarded).toBe(0.33);
  });

  test("B10: answers round-trip unchanged, including strings that look like JSON", async () => {
    const a = attempt({ submittedAt: new Date(), score: 0, durationMs: 1 });
    await db.insert(PracticeAttempt).values(a);
    const answers = ["3.50", "true", "null", '"quoted"', "[1]", ["a", "2"], null];
    for (const [i, answer] of answers.entries()) {
      await db.insert(Response).values({ id: newId(), attemptId: a.id, questionId: i + 1, answer });
    }
    const rows = await db.select().from(Response).where(eq(Response.attemptId, a.id));
    const back = [...rows].sort((x, y) => x.questionId - y.questionId).map((r) => r.answer);
    expect(back).toEqual(answers);
    const raw = await pool.query(
      "SELECT jsonb_typeof(answer) AS t FROM response WHERE attempt_id = $1 ORDER BY question_id",
      [a.id],
    );
    expect(raw.rows.map((r) => r.t)).toEqual(["string", "string", "string", "string", "string", "array", null]);
  });

  test("B10: unique (attemptId, questionId) and cascade delete of responses", async () => {
    const a = attempt({ submittedAt: new Date(), score: 0, durationMs: 1 });
    await db.insert(PracticeAttempt).values(a);
    await db.insert(Response).values({ id: newId(), attemptId: a.id, questionId: 3, answer: ["a", "b"] });
    await fails(db.insert(Response).values({ id: newId(), attemptId: a.id, questionId: 3 }), UNIQUE);
    await db.insert(Response).values({ id: newId(), attemptId: a.id, questionId: 4, answer: "x", flagged: true });
    expect(await db.select().from(Response).where(eq(Response.attemptId, a.id))).toHaveLength(2);
    await db.delete(PracticeAttempt).where(eq(PracticeAttempt.id, a.id));
    expect(await db.select().from(Response).where(eq(Response.attemptId, a.id))).toHaveLength(0);
  });

  test("B10: check constraints (kind, seed, questionIds vs kind, score/duration with submittedAt, autoResult)", async () => {
    const bad = [
      attempt({ kind: "proctored" as never }),
      attempt({ shuffleSeed: "not-a-seed" }),
      attempt({ kind: "retake_missed" }), // needs questionIds
      attempt({ questionIds: [1, 2] }), // full has none
      attempt({ submittedAt: new Date() }), // submitted needs score and duration
      attempt({ score: 3 }), // in progress has no score
    ];
    for (const a of bad) await fails(db.insert(PracticeAttempt).values(a), CHECK);
    const retake = attempt({ kind: "retake_missed", questionIds: [2, 5] });
    await db.insert(PracticeAttempt).values(retake);
    await fails(
      db.insert(Response).values({ id: newId(), attemptId: retake.id, questionId: 2, autoResult: "maybe" as never }),
      CHECK,
    );
    await fails(
      db.insert(Response).values({ id: newId(), attemptId: retake.id, questionId: 2, timeSpentMs: -1 }),
      CHECK,
    );
    await fails(db.insert(Response).values({ id: newId(), attemptId: newId(), questionId: 1 }), FK);
  });
});
