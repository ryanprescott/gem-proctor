// P2.1.md C14: the verification tables, as gem_app.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { newId, User, VerificationJob, VerificationRun } from "@gem/db";
import { eq, sql } from "drizzle-orm";
import { createTestApp, hasDb, type TestApp } from "./helpers.ts";

function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e.cause?.code ?? e.code;
}

describe.skipIf(!hasDb)("verification tables", () => {
  let t: TestApp;
  let ownerId: string;

  beforeAll(async () => {
    t = await createTestApp();
    ownerId = newId();
    await t.db.insert(User).values({ id: ownerId, email: "o@example.com", passwordHash: "x", displayName: "O" });
  });
  afterAll(async () => {
    await t?.close();
  });

  const run = (over: Partial<typeof VerificationRun.$inferInsert> = {}) => ({
    id: newId(),
    questionId: 7,
    programKind: "blind" as const,
    program: "result = 1",
    status: "ok" as const,
    result: { kind: "integer", value: "1" },
    durationMs: 3,
    sandboxVersion: "v",
    ...over,
  });

  test("C14: verification_run keeps a row, and refuses UPDATE and DELETE as gem_app", async () => {
    const row = run();
    await t.db.insert(VerificationRun).values(row);
    const [stored] = await t.db.select().from(VerificationRun).where(eq(VerificationRun.id, row.id));
    expect(stored).toMatchObject({ programKind: "blind", status: "ok", questionId: 7 });
    expect(stored?.at).toBeInstanceOf(Date);
    await expect(t.db.update(VerificationRun).set({ status: "timeout" }).catch(pgCode)).resolves.toBe("42501");
    await expect(t.db.delete(VerificationRun).catch(pgCode)).resolves.toBe("42501");
  });

  test("C14: checks on status and program kind; a job's and a version's FKs", async () => {
    await expect(
      t.db
        .insert(VerificationRun)
        .values(run({ status: "nope" as never }))
        .catch(pgCode),
    ).resolves.toBe("23514");
    await expect(
      t.db
        .insert(VerificationRun)
        .values(run({ programKind: "mistake" as never }))
        .catch(pgCode),
    ).resolves.toBe("23514");
    await expect(
      t.db
        .insert(VerificationRun)
        .values(run({ jobId: newId() }))
        .catch(pgCode),
    ).resolves.toBe("23503");
    await expect(
      t.db
        .insert(VerificationRun)
        .values(run({ testVersionId: newId() }))
        .catch(pgCode),
    ).resolves.toBe("23503");
  });

  test("C14: verification_job takes SELECT, INSERT, UPDATE, DELETE", async () => {
    const id = newId();
    const input = { questions: [{ id: 1, correctAnswer: "1" }] };
    await t.db.insert(VerificationJob).values({ id, ownerId, status: "queued", input, inputHash: "h" });
    await t.db
      .update(VerificationJob)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(VerificationJob.id, id));
    const [job] = await t.db.select().from(VerificationJob).where(eq(VerificationJob.id, id));
    expect(job).toMatchObject({ status: "running", input });
    await expect(
      t.db
        .insert(VerificationJob)
        .values({ id: newId(), ownerId, status: "nope" as never, input, inputHash: "h" })
        .catch(pgCode),
    ).resolves.toBe("23514");
    await t.db.delete(VerificationJob).where(eq(VerificationJob.id, id));
    expect(await t.db.select().from(VerificationJob).where(eq(VerificationJob.id, id))).toHaveLength(0);
  });

  test("C14: a bare string in result round-trips as a string", async () => {
    const row = run({ result: "3.505" });
    await t.db.insert(VerificationRun).values(row);
    const [stored] = await t.db.select().from(VerificationRun).where(eq(VerificationRun.id, row.id));
    expect(stored?.result).toBe("3.505");
    const [typed] = (
      await t.db.execute<{ t: string }>(
        sql`SELECT jsonb_typeof(result) AS t FROM verification_run WHERE id = ${row.id}`,
      )
    ).rows;
    expect(typed?.t).toBe("string");
  });
});
