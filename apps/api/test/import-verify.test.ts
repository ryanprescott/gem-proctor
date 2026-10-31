// Flow B on import, through the routes and a real pg-boss worker, with the real sandbox and a mock model that
// replays what the reference model wrote for the fixture (P2.1.md C25–C30).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AuditLog, RoleAssignment, TestImportRecord, VerificationRun } from "@gem/db";
import { DEFAULT_VERIFY_SETTINGS } from "@gem/shared";
import { desc, eq } from "drizzle-orm";
import { Queue } from "../src/queue.ts";
import { getSettings } from "../src/settings.ts";
import { startVerifyWorker } from "../src/verification.ts";
import { API, type Client, hasDb, registerUser, signIn } from "./helpers.ts";
import { createL7Env, type L7Env, promptOf, QUIZ_PATH, RECORDED, replay, verifyPython } from "./l7-helpers.ts";

const FIXTURE = readFileSync(QUIZ_PATH, "utf8");
const FIXED = FIXTURE.replace('"correctAnswer": "1"', '"correctAnswer": "-1"');

interface Job {
  id: string;
  status: string;
  errorCode: string | null;
  items: {
    questionId: number;
    outcome: string;
    suggestedFix: string | null;
    computable: boolean;
    verification: { status: string };
  }[];
  summary: { total: number; done: number; counts: Record<string, number> } | null;
}

describe.skipIf(!verifyPython || !hasDb)("import flow B", () => {
  let env: L7Env;
  let queue: Queue;
  let admin: Client;
  let proctor: Client;
  let other: Client;
  let job: Job;
  let value: unknown;

  const start = async (client: Client, v: unknown) => client.post(`${API}/imports/verify`, { value: v });
  const finished = async (client: Client, id: string): Promise<Job> => {
    for (let i = 0; i < 600; i++) {
      const res = await client.get(`${API}/imports/verify/${id}`);
      const body = res.json().job as Job;
      if (body.status === "done" || body.status === "failed") return body;
      await Bun.sleep(100);
    }
    throw new Error("the job never finished");
  };
  const verified = async (client: Client, text: string) => {
    const preview = (await client.post(`${API}/imports/preview`, { text })).json();
    const started = await start(client, JSON.parse(preview.normalizedText));
    expect(started.statusCode).toBe(200);
    return finished(client, started.json().job.id);
  };

  beforeAll(async () => {
    env = await createL7Env();
    queue = await Queue.start(env.t.database.appUrl, () => {});
    env.t.ctx.queue = queue;
    await startVerifyWorker(env.t.ctx);
    admin = (await registerUser(env.t.app, "admin@example.com")).client;
    const p = await registerUser(env.t.app, "proctor@example.com");
    const o = await registerUser(env.t.app, "other@example.com");
    for (const u of [p, o]) await admin.put(`${API}/admin/users/${u.user.id}/roles`, { role: "proctor" });
    proctor = (await signIn(env.t.app, "proctor@example.com")).client;
    other = (await signIn(env.t.app, "other@example.com")).client;
    env.setReply(replay(RECORDED.quiz.replies));
    const preview = (await proctor.post(`${API}/imports/preview`, { text: FIXTURE })).json();
    value = JSON.parse(preview.normalizedText);
    const started = await start(proctor, value);
    expect(started.statusCode).toBe(200);
    expect(started.json().job.status).toBe("queued");
    job = await finished(proctor, started.json().job.id);
  }, 120_000);

  afterAll(async () => {
    await queue?.stop();
    await env?.close();
  });

  test("C25: Q7 is Wrong answer with the fix -1; every other computable question verifies", () => {
    expect(job.status).toBe("done");
    expect(job.summary).toMatchObject({ total: 20, done: 20 });
    const q7 = job.items.find((i) => i.questionId === 7);
    expect(q7).toMatchObject({ outcome: "wrong_answer", suggestedFix: "-1", computable: true });
    const computable = job.items.filter((i) => i.computable && i.questionId !== 7);
    expect(computable.length).toBeGreaterThanOrEqual(5);
    expect(computable.map((i) => i.outcome)).toEqual(computable.map(() => "verified"));
    expect(job.items.filter((i) => !i.computable).map((i) => i.outcome)).toEqual(
      job.items.filter((i) => !i.computable).map(() => "not_computable"),
    );
  });

  test("C25: every blind run is recorded against the job", async () => {
    const runs = await env.t.db.select().from(VerificationRun).where(eq(VerificationRun.jobId, job.id));
    expect(runs.length).toBeGreaterThanOrEqual(6);
    const q7 = runs.find((r) => r.questionId === 7);
    expect(q7).toMatchObject({ programKind: "blind", status: "ok", matchedOption: "-1" });
  });

  test("C26: saving with the job and no accepted fix applies nothing, and the error stays", async () => {
    const res = await proctor.post(`${API}/imports`, {
      originalText: FIXTURE,
      text: FIXTURE,
      verificationJobId: job.id,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("import_invalid_quiz");
  });

  test("C26: saving without the job applies nothing either", async () => {
    const res = await proctor.post(`${API}/imports`, { originalText: FIXTURE, text: FIXTURE });
    expect(res.statusCode).toBe(422);
  });

  test("C26: a question whose stated answer is valid but wrong can't be saved with the fix rejected", async () => {
    const wrong = FIXTURE.replace('"correctAnswer": "1"', '"correctAnswer": "3"');
    env.setReply(replay(RECORDED.quiz.replies));
    const wrongJob = await verified(proctor, wrong);
    expect(wrongJob.items.find((i) => i.questionId === 7)).toMatchObject({
      outcome: "wrong_answer",
      suggestedFix: "-1",
    });
    const res = await proctor.post(`${API}/imports`, {
      originalText: wrong,
      text: wrong,
      verificationJobId: wrongJob.id,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "import_invalid_quiz", params: { question: 7 } });
  });

  test("C26: a fix must be the one the job suggested", async () => {
    const save = (acceptedFixes: unknown[], verificationJobId: string | undefined = job.id) =>
      proctor.post(`${API}/imports`, { originalText: FIXTURE, text: FIXTURE, verificationJobId, acceptedFixes });
    for (const fix of [
      { questionId: 7, correctAnswer: "5" },
      { questionId: 1, correctAnswer: "6" },
    ]) {
      const res = await save([fix]);
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe("verify_fix_invalid");
    }
    const noJob = await proctor.post(`${API}/imports`, {
      originalText: FIXTURE,
      text: FIXTURE,
      acceptedFixes: [{ questionId: 7, correctAnswer: "-1" }],
    });
    expect(noJob.json().code).toBe("verify_fix_invalid");
  });

  test("C26: an edited question drops its result, and can't take the fix", async () => {
    const edited = FIXED;
    const res = await proctor.post(`${API}/imports`, {
      originalText: FIXTURE,
      text: edited,
      verificationJobId: job.id,
      acceptedFixes: [{ questionId: 7, correctAnswer: "-1" }],
    });
    expect(res.json().code).toBe("verify_fix_invalid");
  });

  test("C27: confirmed fix: verification on each question, the report lists it, export re-imports", async () => {
    const res = await proctor.post(`${API}/imports`, {
      originalText: FIXTURE,
      text: FIXTURE,
      filename: "engr108.json",
      verificationJobId: job.id,
      acceptedFixes: [{ questionId: 7, correctAnswer: "-1" }],
    });
    expect(res.statusCode).toBe(200);
    const { testId, versionId } = res.json();
    const detail = (await proctor.get(`${API}/tests/${testId}`)).json();
    const q7 = detail.content.questions.find((q: { id: number }) => q.id === 7);
    expect(q7.correctAnswer).toBe("-1");
    expect(q7.computable).toBe(true);
    expect(q7.verification).toMatchObject({
      status: "computed",
      answerSource: "stated",
      matchedOption: "-1",
      result: "-1",
    });
    expect(q7.verification.program).toContain("result");
    expect(detail.content.questions.every((q: { verification?: unknown }) => q.verification)).toBe(true);
    const [record] = await env.t.db
      .select()
      .from(TestImportRecord)
      .where(eq(TestImportRecord.testVersionId, versionId));
    expect((record as { report: { verification: unknown } }).report.verification).toEqual({
      jobId: job.id,
      acceptedFixes: [{ questionId: 7, from: "1", to: "-1" }],
    });

    const exported = await proctor.get(`${API}/tests/${testId}/export`);
    const preview = (await proctor.post(`${API}/imports/preview`, { text: exported.body })).json();
    expect(preview.report.canSave).toBe(true);
    expect(preview.quiz.questions[6].verification.status).toBe("computed");
    const again = await proctor.post(`${API}/imports`, { originalText: exported.body, text: exported.body });
    expect(again.statusCode).toBe(200);
  });

  test("C28: verify.solve unassigned: 409, and the import still works, with no verification", async () => {
    await env.t.db.delete(RoleAssignment).where(eq(RoleAssignment.role, "verify.solve"));
    try {
      const res = await start(proctor, value);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("llm_role_unassigned");
      const roles = (await proctor.get(`${API}/llm/roles`)).json().roles;
      expect(roles.find((r: { role: string }) => r.role === "verify.solve").assigned).toBe(false);
      const saved = await proctor.post(`${API}/imports`, { originalText: FIXED, text: FIXED });
      expect(saved.statusCode).toBe(200);
      const versions = (await proctor.get(`${API}/tests/${saved.json().testId}/versions`)).json().versions;
      expect(versions[0].proctorReady).toBe(false);
      expect(versions[0].blockers).toHaveLength(20);
      expect(versions[0].blockers[0]).toEqual({ questionId: 1, reason: "not_verified" });
    } finally {
      await env.assignSolve();
    }
  });

  test("C29: only the owner or an admin reads a job, or uses it", async () => {
    expect((await proctor.get(`${API}/imports/verify/${job.id}`)).statusCode).toBe(200);
    expect((await admin.get(`${API}/imports/verify/${job.id}`)).statusCode).toBe(200);
    expect((await other.get(`${API}/imports/verify/${job.id}`)).statusCode).toBe(403);
    const missing = "01890000-0000-7000-8000-000000000000";
    const res = await proctor.get(`${API}/imports/verify/${missing}`);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("verify_job_not_found");
    const stolen = await other.post(`${API}/imports`, {
      originalText: FIXED,
      text: FIXED,
      verificationJobId: job.id,
    });
    expect(stolen.statusCode).toBe(404);
    expect(stolen.json().code).toBe("verify_job_not_found");
  });

  test("a sandbox denial in a job fails the question, audits against the job, and the job goes on", async () => {
    let firstBlind = true;
    env.setReply((body) => {
      const p = promptOf(body);
      if (p.kind === "classify") return JSON.stringify({ reason: "r", computable: true });
      if (p.kind === "blind" && firstBlind) {
        firstBlind = false;
        return JSON.stringify({ program: "import os\nos.fork()\nresult = 1" });
      }
      return JSON.stringify({ program: "result = 2" });
    });
    const quiz = {
      quiz_title: "Two",
      total_questions: 2,
      questions: [
        { id: 1, topic: "t", question: "A?", options: ["1", "2"], correctAnswer: "2" },
        { id: 2, topic: "t", question: "B?", options: ["1", "2"], correctAnswer: "2" },
      ],
    };
    const started = await start(proctor, quiz);
    const done = await finished(proctor, started.json().job.id);
    expect(done.items.map((i) => i.outcome)).toEqual(["denied", "verified"]);
    const [audit] = await env.t.db
      .select()
      .from(AuditLog)
      .where(eq(AuditLog.action, "verify.sandbox_denial"))
      .orderBy(desc(AuditLog.at));
    expect(audit).toMatchObject({ targetType: "verification_job", targetId: done.id, actorId: null });
  }, 30_000);

  test("C30: the gate: default on, blockers list what isn't computed, a settings row without the key loads", async () => {
    expect((await getSettings(env.t.db)).verify).toEqual(DEFAULT_VERIFY_SETTINGS);
    const settings = (await admin.get(`${API}/admin/settings`)).json().settings;
    expect(settings.verify.proctoredGate).toBe(true);

    const saved = await proctor.post(`${API}/imports`, {
      originalText: FIXTURE,
      text: FIXTURE,
      verificationJobId: job.id,
      acceptedFixes: [{ questionId: 7, correctAnswer: "-1" }],
    });
    const versions = (await proctor.get(`${API}/tests/${saved.json().testId}/versions`)).json().versions;
    expect(versions[0].proctorReady).toBe(true);
    expect(versions[0].blockers).toEqual([]);
  });

  test("C30: a question that can't be checked blocks; turning the gate off lifts it, and that's audited", async () => {
    env.setReply((body) => {
      const p = promptOf(body);
      if (p.kind === "classify") return JSON.stringify({ reason: "r", computable: true });
      return JSON.stringify({ program: "result = 1/0" });
    });
    const quiz = {
      quiz_title: "One",
      total_questions: 1,
      questions: [{ id: 1, topic: "t", question: "A?", options: ["1", "2"], correctAnswer: "2" }],
    };
    const text = JSON.stringify(quiz);
    const started = await start(proctor, quiz);
    const done = await finished(proctor, started.json().job.id);
    expect(done.items[0]?.outcome).toBe("couldnt_check");
    const saved = await proctor.post(`${API}/imports`, { originalText: text, text, verificationJobId: done.id });
    expect(saved.statusCode).toBe(200);
    const testId = saved.json().testId;
    const version = async () => (await proctor.get(`${API}/tests/${testId}`)).json().version;
    expect(await version()).toMatchObject({ proctorReady: false, blockers: [{ questionId: 1, reason: "unverified" }] });

    const put = await admin.put(`${API}/admin/settings`, { selfRegistration: true, verify: { proctoredGate: false } });
    expect(put.statusCode).toBe(200);
    expect(put.json().settings.verify).toEqual({ ...DEFAULT_VERIFY_SETTINGS, proctoredGate: false });
    expect(await version()).toMatchObject({ proctorReady: true, blockers: [] });
    const [audit] = await env.t.db
      .select()
      .from(AuditLog)
      .where(eq(AuditLog.action, "settings.update"))
      .orderBy(desc(AuditLog.at));
    expect(audit?.before).toMatchObject({ verify: { proctoredGate: true } });
    expect(audit?.after).toMatchObject({ verify: { proctoredGate: false } });
    await admin.put(`${API}/admin/settings`, { selfRegistration: true, verify: { proctoredGate: true } });
    expect(await version()).toMatchObject({ proctorReady: false });
  }, 30_000);

  test("C29: a job over the limit is refused by the contract", async () => {
    const res = await start(proctor, { questions: Array.from({ length: 201 }, () => ({})) });
    expect(res.statusCode).toBe(400);
  });
});

describe.skipIf(!verifyPython || !hasDb)("rate limit", () => {
  test("C29: POST /imports/verify answers 429 past the limit", async () => {
    const env = await createL7Env({}, { LLM_RATE_LIMIT_MAX: "2" });
    try {
      env.t.ctx.queue = { send: async () => {} } as unknown as Queue;
      const admin = (await registerUser(env.t.app, "admin@example.com")).client;
      const value = { questions: [{ id: 1 }] };
      expect((await admin.post(`${API}/imports/verify`, { value })).statusCode).toBe(200);
      expect((await admin.post(`${API}/imports/verify`, { value })).statusCode).toBe(200);
      const third = await admin.post(`${API}/imports/verify`, { value });
      expect(third.statusCode).toBe(429);
      expect(third.json().code).toBe("rate_limited");
    } finally {
      await env.close();
    }
  }, 30_000);
});
