// Generation and validation through the routes (P2.md E24–E27, E32–E36), with a scripted model, the real sandbox
// and real Postgres.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AuditLog, AuthoringBatch, AuthoringSession, QuestionEvent, RetrievalLog, VerificationRun } from "@gem/db";
import type { SessionDetail } from "@gem/shared/contracts";
import { desc, eq } from "drizzle-orm";
import { assign } from "../../../packages/llm/test/helpers.ts";
import { type Behaviour, draftsOf, flagged, review, scripted, waitFor } from "./authoring-gen-helpers.ts";
import { BOOK, createSourceEnv, type SourceBody, type SourceEnv } from "./authoring-helpers.ts";
import { API, hasDb } from "./helpers.ts";
import { verifyPython } from "./l7-helpers.ts";

describe.skipIf(!hasDb || !verifyPython)("authoring generation", () => {
  let env: SourceEnv;
  let source: SourceBody;
  let sections: { id: string; title: string }[];

  const section = (title: string) => sections.find((s) => s.title === title)?.id as string;
  const model = async (contextWindow = 32_000, maxOutputTokens = 8000, timeoutMs = 20_000) => {
    await assign(env.t.db, "authoring.generate", {
      url: env.mock.url,
      timeoutMs,
      capabilities: { contextWindow, maxOutputTokens },
    });
  };

  /** A session with a blueprint: `count` questions on each objective, all single choice unless `mix` says. */
  async function ready(over: { titles?: string[]; count?: number; mix?: Record<string, number>; style?: string } = {}) {
    const titles = over.titles ?? ["Inner product"];
    const created = (
      await env.proctor.post(`${API}/authoring/sessions`, {
        title: "Generated",
        testType: "custom",
        sources: [{ sourceId: source.id, sectionIds: titles.map(section) }],
      })
    ).json() as SessionDetail;
    const count = over.count ?? 4;
    const total = count * created.objectives.length;
    const res = await env.proctor.put(`${API}/authoring/sessions/${created.session.id}/blueprint`, {
      testType: "custom",
      questionCount: total,
      mix: over.mix ?? { single_choice: total },
      perObjective: created.objectives.map((o) => ({ objectiveId: o.id, count: count })),
      ...(over.style ? { style: over.style } : {}),
    });
    expect(res.statusCode).toBe(200);
    return created;
  }
  const generate = (id: string) => env.proctor.post(`${API}/authoring/sessions/${id}/generate`);
  const run = async (b: Behaviour, over: Parameters<typeof ready>[0] = {}) => {
    env.setReply(scripted(b));
    const s = await ready(over);
    expect((await generate(s.session.id)).statusCode).toBe(200);
    return { id: s.session.id, detail: (await review(env.proctor, s.session.id)) as SessionDetail };
  };
  const resultOf = (q: SessionDetail["questions"][number], layer: string) =>
    q.validations.find((v) => v.layer === layer);

  beforeAll(async () => {
    env = await createSourceEnv();
    await model();
    source = (await env.settled(
      env.proctor,
      (await env.proctor.post(`${API}/sources`, { title: "Book", citationLabel: "VMLS", text: BOOK })).json().source.id,
    )) as SourceBody;
    sections = (await env.proctor.get(`${API}/sources/${source.id}/sections`)).json().sections;
  }, 60_000);
  afterAll(async () => env?.close());

  describe("E24: batches", () => {
    test("split by objective, each one call; every question cites a chunk that was sent; the style line is in the prompt", async () => {
      const before = env.mock.chatRequests().length;
      const { id, detail } = await run(
        {},
        { titles: ["Inner product", "Norms"], count: 2, style: "Marker line: test one idea." },
      );
      expect(detail.session.status).toBe("review");
      const batches = detail.progress.batches;
      expect(batches).toHaveLength(2);
      expect(batches.every((b) => b.status === "done" && b.written === 2 && b.objectiveIds.length === 1)).toBe(true);
      expect(new Set(batches.map((b) => b.objectiveIds[0])).size).toBe(2);
      const generation = env.mock
        .chatRequests()
        .slice(before)
        .filter((r) => JSON.stringify(r.body).includes("Source chunk ["));
      expect(generation).toHaveLength(2);
      // Only what the retrieval sent can be cited: the log has the ids, and the evidence is among them.
      const logs = await env.t.db.select().from(RetrievalLog);
      const sent = new Set(logs.flatMap((l) => (l.results as { chunkId: string }[]).map((r) => r.chunkId)));
      const drafts = await draftsOf(env, id);
      expect(drafts).toHaveLength(4);
      for (const d of detail.questions) for (const e of d.content.evidence) expect(sent.has(e.chunkId)).toBe(true);
      expect(JSON.stringify(generation[0]?.body)).toContain("Marker line: test one idea.");
      expect((detail as unknown as { blueprint: { styleVersion: string } }).blueprint.styleVersion).toBe("style-v1");
      const [session] = await env.t.db.select().from(AuthoringSession).where(eq(AuthoringSession.id, id));
      expect(session?.model).toBe("mock-model");
    }, 60_000);

    test("the context budget holds: a small window gets fewer chunks than a large one, and never overflows", async () => {
      const chunksIn = async () => {
        const before = env.mock.chatRequests().length;
        const { detail } = await run({}, { titles: ["Chapter 1: Vectors"], count: 2 });
        expect(detail.progress.batches.every((b) => b.status === "done")).toBe(true);
        const call = env.mock
          .chatRequests()
          .slice(before)
          .find((r) => JSON.stringify(r.body).includes("Source chunk ["));
        const text = JSON.stringify((call?.body as { messages: unknown } | undefined)?.messages);
        return { n: (text.match(/Source chunk \[/g) ?? []).length, chars: text.length };
      };
      await model(5000, 1000);
      const small = await chunksIn();
      await model(32_000, 8000);
      const large = await chunksIn();
      expect(small.n).toBeGreaterThanOrEqual(1);
      expect(small.n).toBeLessThanOrEqual(large.n);
      expect(small.chars / 3).toBeLessThan(5000 - 1000);
    }, 60_000);

    test("a citation to a chunk that wasn't sent fails L1 and L2", async () => {
      const { detail } = await run({
        intercept: () =>
          JSON.stringify({
            questions: [
              {
                tempId: "x1",
                objectiveIds: ["O1"],
                type: "single_choice",
                topic: "Invented",
                computable: false,
                evidence: [{ chunkId: "vmls:nowhere:c1", quote: "Not in anything." }],
                inputs: [],
                question: "Which one?",
                constraint: "",
                answerProgram: "",
                options: [
                  { text: "A", isCorrect: true },
                  { text: "B", isCorrect: false },
                  { text: "C", isCorrect: false },
                ],
                mistakes: [],
                explanation: "Because.",
              },
            ],
          }),
      });
      const q = detail.questions[0];
      expect(q && resultOf(q, "L1")?.outcome).toBe("fail");
      expect(q?.validations.find((v) => v.layer === "L2")?.outcome).toBe("fail");
      expect(q?.blocked).toBe(true);
    }, 60_000);
  });

  describe("E25: a failed batch is shown, with its code, and retried", () => {
    const good = () => scripted({});
    test("incomplete, invalid and timeout each show with their code; retry runs it again", async () => {
      const attempts: [string, (n: number) => unknown, string][] = [
        [
          "incomplete",
          () => ({ text: '{"questions":[{"tempId":"cut"', finishReason: "length" }),
          "llm_output_incomplete",
        ],
        ["invalid", () => "this is not json at all", "llm_output_invalid"],
        ["timeout", () => ({ text: "{}", delayMs: 1500 }), "llm_endpoint_timeout"],
      ];
      for (const [name, bad, code] of attempts) {
        if (name === "timeout") await model(32_000, 8000, 400);
        env.setReply(scripted({ intercept: () => bad(0) as never }));
        const s = await ready();
        await generate(s.session.id);
        const detail = (await review(env.proctor, s.session.id)) as SessionDetail;
        const [batch] = detail.progress.batches;
        expect(batch).toMatchObject({ status: "failed", errorCode: code, written: 0 });
        expect(detail.session.status).toBe("draft");
        if (name === "timeout") await model();
        env.setReply(good());
        const retried = await env.proctor.post(`${API}/authoring/batches/${batch?.id}/retry`);
        expect(retried.statusCode).toBe(200);
        const done = (await waitFor("the retry", async () => {
          const d = (await (
            await env.proctor.get(`${API}/authoring/sessions/${s.session.id}`)
          ).json()) as SessionDetail;
          return d.session.status === "review" ? d : undefined;
        })) as SessionDetail;
        expect(done.progress.batches[0]).toMatchObject({ status: "done", errorCode: null, written: 4 });
      }
    }, 90_000);

    test("a batch that can't be retried while it isn't failed is refused", async () => {
      const { detail } = await run({});
      const res = await env.proctor.post(`${API}/authoring/batches/${detail.progress.batches[0]?.id}/retry`);
      expect(res.statusCode).toBe(409);
    }, 60_000);

    test("salvage keeps the valid questions and shows what it dropped; a cut-off reply says so", async () => {
      const real = scripted({});
      let batch: string | undefined;
      env.setReply((body) => {
        // The repair round is asked about the same reply, and a model that can't fix it sends it again.
        if (batch && JSON.stringify(body).includes("broken")) return batch;
        const reply = real(body);
        if (typeof reply !== "string" || !reply.startsWith('{"questions"')) return reply;
        const questions = JSON.parse(reply).questions;
        batch = JSON.stringify({ questions: [questions[0], { tempId: "broken" }, questions[1]] });
        return batch;
      });
      const s = await ready({ count: 2 });
      await generate(s.session.id);
      const salvaged = (await review(env.proctor, s.session.id)) as SessionDetail;
      expect(salvaged.progress.batches[0]).toMatchObject({ errorCode: null, written: 2 });
      expect(salvaged.progress.batches[0]?.failedItems).toEqual([
        expect.objectContaining({ kind: "invalid", index: 1 }),
      ]);

      env.setReply((body) => {
        const reply = real(body);
        if (typeof reply !== "string" || !reply.startsWith('{"questions"')) return reply;
        const questions = JSON.parse(reply).questions as unknown[];
        const text = `{"questions":[${JSON.stringify(questions[0])},{"tempId":"cut","objectiveIds":["O1"],"type":"sing`;
        return { text, finishReason: "length" };
      });
      const t = await ready({ count: 2 });
      await generate(t.session.id);
      const cut = (await review(env.proctor, t.session.id)) as SessionDetail;
      expect(cut.progress.batches[0]?.status).toBe("done");
      expect(cut.progress.batches[0]?.written).toBe(1);
      expect(cut.progress.batches[0]?.failedItems.map((f) => f.kind)).toContain("truncated");
    }, 90_000);
  });

  describe("E26: stop", () => {
    test("cancel aborts the running call and no queued batch starts", async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const real = scripted({});
      const before = env.mock.chatRequests().length;
      env.setReply((body) => {
        const reply = real(body);
        return typeof reply === "string" && reply.startsWith('{"questions"') ? { text: reply, holdUntil: gate } : reply;
      });
      const s = await ready({ titles: ["Inner product", "Norms", "Chapter 2: Matrices"], count: 1 });
      await generate(s.session.id);
      // Running isn't enough: cancel must find the call in flight, so wait until the model has the request.
      await waitFor("the call to reach the model", async () =>
        env.mock
          .chatRequests()
          .slice(before)
          .some((r) => JSON.stringify(r.body).includes("Source chunk [")),
      );
      const cancelled = await env.proctor.post(`${API}/authoring/sessions/${s.session.id}/generate:cancel`);
      expect(cancelled.statusCode).toBe(200);
      release();
      const detail = (await review(env.proctor, s.session.id)) as SessionDetail;
      expect(detail.progress.batches.map((b) => b.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
      expect(detail.questions).toHaveLength(0);
      expect(detail.session.status).toBe("draft");
      await Bun.sleep(300);
      const started = env.mock
        .chatRequests()
        .slice(before)
        .filter((r) => JSON.stringify(r.body).includes("Source chunk ["));
      expect(started).toHaveLength(1);
      const rows = await env.t.db.select().from(AuthoringBatch).where(eq(AuthoringBatch.sessionId, s.session.id));
      expect(rows.every((r) => r.status === "cancelled")).toBe(true);
    }, 60_000);
  });

  describe("E27: progress events", () => {
    test("every change is published, a connection starts with the state, and a reconnect recovers it", async () => {
      env.setReply(scripted({}));
      const s = await ready({ titles: ["Inner product", "Norms"], count: 2 });
      let published = 0;
      const stop = env.t.ctx.events.subscribe(`authoring:${s.session.id}`, () => {
        published += 1;
      });
      await generate(s.session.id);
      const detail = (await review(env.proctor, s.session.id)) as SessionDetail;
      stop();
      expect(published).toBeGreaterThan(4);
      const frame = async (client: typeof env.proctor) => {
        const res = await client.get(`${API}/authoring/sessions/${s.session.id}/events?once=true`);
        expect(res.headers["content-type"]).toContain("text/event-stream");
        return JSON.parse(res.body.replace(/^data: /, "").trim());
      };
      const first = await frame(env.proctor);
      expect(first).toMatchObject({ status: "review", written: 4, pending: 0 });
      expect(first.checked).toBe(4);
      // Dropping the stream loses nothing: the state is read again.
      expect(await frame(env.proctor)).toEqual(first);
      expect(first.batches.map((b: { id: string }) => b.id)).toEqual(detail.progress.batches.map((b) => b.id));
      expect((await env.other.get(`${API}/authoring/sessions/${s.session.id}/events?once=true`)).statusCode).toBe(404);
      expect((await env.student.get(`${API}/authoring/sessions/${s.session.id}/events?once=true`)).statusCode).toBe(
        403,
      );
    }, 60_000);
  });

  describe("E32–E34: L7 through generation", () => {
    test("E32: the answer is computed, the options built, the event written, the runs linked to the draft", async () => {
      const { id, detail } = await run({ computable: true });
      const q = detail.questions.find((x) => x.content.computable);
      expect(q).toBeDefined();
      const c = q?.content;
      expect(c?.correctAnswer).not.toBeNull();
      expect(c?.options).toHaveLength(4);
      expect(c?.options?.filter((o) => o.isCorrect)).toHaveLength(1);
      expect(c?.question).not.toContain("{x}");
      expect(c?.template).toContain("{x}");
      expect(c?.verification).toMatchObject({ status: "computed", answerSource: "computed" });
      expect(q && resultOf(q, "L7")).toMatchObject({ outcome: "pass" });
      expect(q?.blocked).toBe(false);
      const events = await env.t.db
        .select()
        .from(QuestionEvent)
        .where(eq(QuestionEvent.draftQuestionId, q?.id as string));
      expect(events.map((e) => e.kind).sort()).toEqual(["answer_computed", "generated"]);
      const runs = await env.t.db
        .select()
        .from(VerificationRun)
        .where(eq(VerificationRun.draftQuestionId, q?.id as string));
      expect(runs.length).toBeGreaterThanOrEqual(2);
      expect(runs.map((r) => r.programKind)).toContain("blind");
      expect((await draftsOf(env, id)).length).toBe(4);
    }, 90_000);

    test("E33: values are used once per test", async () => {
      const { id } = await run({ computable: true }, { titles: ["Inner product", "Norms"], count: 2 });
      const [row] = await env.t.db.select().from(AuthoringSession).where(eq(AuthoringSession.id, id));
      const used = row?.usedValues as { keys: string[] };
      expect(used.keys.length).toBe(2);
      expect(new Set(used.keys).size).toBe(2);
    }, 90_000);

    test("E34: a calculation written as a concept question fails, with that reason; a symbolic definition passes", async () => {
      const calc = "Let $x = [1, 2]$ and $y = [-2, 1]$. Which statement is true?";
      const bad = await run({ conceptText: calc, classifyComputable: true });
      const failed = bad.detail.questions[0];
      expect(failed && resultOf(failed, "L7")).toMatchObject({ outcome: "fail", reason: "calculation_as_concept" });
      expect(failed?.blocked).toBe(true);
      const definition = "Which formula defines $x^T y = x_1 y_1 + \\cdots + x_n y_n$ for vectors?";
      const fine = await run({ conceptText: definition, classifyComputable: false });
      const passed = fine.detail.questions[0];
      expect(passed && resultOf(passed, "L7")).toMatchObject({ outcome: "pass" });
      expect(passed?.blocked).toBe(false);
    }, 90_000);

    test("programs that disagree fail the question, and it can't be accepted", async () => {
      const { detail } = await run({ computable: true, blindExpression: "x.dot(y) + 1" });
      const q = detail.questions.find((x) => x.content.computable) as SessionDetail["questions"][number];
      expect(resultOf(q, "L7")).toMatchObject({ outcome: "fail", reason: "programs_disagree" });
      expect(q.content.correctAnswer).toBeNull();
      const res = await env.proctor.patch(`${API}/authoring/questions/${q.id}`, { status: "accepted" });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("authoring_question_blocked");
    }, 90_000);
  });

  describe("E35: a prompt-injected source", () => {
    test("a program that attacks the sandbox is denied: the question fails, an audit row is written, the chunks are flagged", async () => {
      const before = (await env.t.db.select().from(AuditLog).where(eq(AuditLog.action, "verify.sandbox_denial")))
        .length;
      const { detail } = await run({ computable: true, authorProgram: "import os\nos.fork()\nresult = 1" });
      const q = detail.questions.find((x) => x.content.computable) as SessionDetail["questions"][number];
      expect(resultOf(q, "L7")).toMatchObject({ outcome: "fail", reason: "sandbox_denial" });
      expect(q.blocked).toBe(true);
      const audit = await env.t.db
        .select()
        .from(AuditLog)
        .where(eq(AuditLog.action, "verify.sandbox_denial"))
        .orderBy(desc(AuditLog.at));
      expect(audit.length).toBe(before + 1);
      expect(audit[0]?.targetId).not.toBeNull();
      expect(JSON.stringify(audit[0])).not.toContain("fork");
      const chunks = await flagged(env);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.every((c) => c.flagReason === "sandbox_denial")).toBe(true);
      const cited = new Set(q.content.evidence.map((e) => e.chunkId));
      expect(chunks.some((c) => cited.has(c.id))).toBe(true);
    }, 90_000);
  });
});
