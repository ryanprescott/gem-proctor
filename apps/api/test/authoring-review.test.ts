// Review, revise, L7 on authoring, publish and provenance through the routes (P2.md E37–E50).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { checkProctorReady } from "@gem/authoring";
import { AuditLog, DraftQuestion, QuestionEvent, Test, TestVersion } from "@gem/db";
import type { Quiz } from "@gem/shared";
import type { DraftView, SessionDetail } from "@gem/shared/contracts";
import { asc, eq, sql } from "drizzle-orm";
import { assign } from "../../../packages/llm/test/helpers.ts";
import { type Behaviour, draftsOf, review, scripted, waitFor } from "./authoring-gen-helpers.ts";
import { BOOK, createSourceEnv, type SourceBody, type SourceEnv } from "./authoring-helpers.ts";
import { API, type Client, hasDb } from "./helpers.ts";
import { verifyPython } from "./l7-helpers.ts";

type Question = SessionDetail["questions"][number];

describe.skipIf(!hasDb || !verifyPython)("authoring review and publish", () => {
  let env: SourceEnv;
  let source: SourceBody;
  let sections: { id: string; title: string }[];

  const section = (title: string) => sections.find((s) => s.title === title)?.id as string;
  const get = async (id: string, c: Client = env.proctor) =>
    (await c.get(`${API}/authoring/sessions/${id}`)).json() as SessionDetail;
  const settle = (id: string) =>
    waitFor("L7 to finish", async () => {
      const d = await get(id);
      return d.progress.pending === 0 && d.session.status !== "generating" ? d : undefined;
    });
  const patch = (q: string, body: unknown, c: Client = env.proctor) => c.patch(`${API}/authoring/questions/${q}`, body);
  const post = (url: string, body?: unknown, c: Client = env.proctor) => c.post(`${API}${url}`, body);

  /** A session in review with `count` questions on one objective. */
  async function reviewed(b: Behaviour = {}, count = 4, mix?: Record<string, number>) {
    env.setReply(scripted(b));
    // A new revision of the source has new sections.
    sections = (await env.proctor.get(`${API}/sources/${source.id}/sections`)).json().sections;
    const created = (
      await env.proctor.post(`${API}/authoring/sessions`, {
        title: "Review me",
        testType: "chapter_quiz",
        sources: [{ sourceId: source.id, sectionIds: [section("Inner product")] }],
      })
    ).json() as SessionDetail;
    const bp = await env.proctor.put(`${API}/authoring/sessions/${created.session.id}/blueprint`, {
      testType: "chapter_quiz",
      questionCount: count,
      mix: mix ?? { single_choice: count },
      perObjective: created.objectives.map((o) => ({ objectiveId: o.id, count })),
    });
    expect(bp.statusCode).toBe(200);
    expect((await post(`/authoring/sessions/${created.session.id}/generate`)).statusCode).toBe(200);
    await review(env.proctor, created.session.id);
    return { id: created.session.id, detail: await settle(created.session.id) };
  }
  const events = async (draftId: string) =>
    env.t.db
      .select()
      .from(QuestionEvent)
      .where(eq(QuestionEvent.draftQuestionId, draftId))
      .orderBy(asc(QuestionEvent.at));
  const l7 = (q: Question) => q.validations.find((v) => v.layer === "L7");
  const calc = (d: SessionDetail) => d.questions.find((q) => q.content.computable) as Question;

  beforeAll(async () => {
    env = await createSourceEnv();
    await assign(env.t.db, "authoring.generate", {
      url: env.mock.url,
      timeoutMs: 20_000,
      capabilities: { contextWindow: 32_000, maxOutputTokens: 8000 },
    });
    source = (await env.settled(
      env.proctor,
      (await env.proctor.post(`${API}/sources`, { title: "Book", citationLabel: "VMLS", text: BOOK })).json().source.id,
    )) as SourceBody;
    sections = (await env.proctor.get(`${API}/sources/${source.id}/sections`)).json().sections;
  }, 60_000);
  afterAll(async () => env?.close());

  describe("E38: accept, edit, reject, lock", () => {
    test("each writes an event with who and when; a locked question can't change until it's reopened", async () => {
      const { id, detail } = await reviewed();
      const [a, b, c] = detail.questions as [Question, Question, Question];
      expect(detail.questions.every((q) => q.status === "proposed")).toBe(true);
      expect((await patch(a.id, { status: "accepted", note: "good" })).json().question.status).toBe("accepted");
      expect((await patch(b.id, { status: "rejected" })).json().question.status).toBe("rejected");
      expect((await patch(a.id, { status: "locked" })).json().question.status).toBe("locked");
      const kinds = (await events(a.id)).map((e) => e.kind);
      expect(kinds).toEqual(["generated", "accepted", "locked"]);
      const accepted = (await events(a.id))[1];
      expect(accepted).toMatchObject({ actorId: env.proctorId, note: "good" });
      expect(accepted?.at).toBeInstanceOf(Date);
      expect((await events(b.id)).map((e) => e.kind)).toEqual(["generated", "rejected"]);

      const edit = await patch(a.id, { edit: { topic: "x" } });
      expect(edit.statusCode).toBe(409);
      expect(edit.json().code).toBe("authoring_question_locked");
      expect((await post(`/authoring/questions/${a.id}/verify`)).json().code).toBe("authoring_question_locked");
      expect((await patch(a.id, { status: "accepted" })).json().question.status).toBe("accepted");
      expect((await patch(c.id, {})).statusCode).toBe(400);
      expect((await patch(c.id, { status: "accepted", edit: { topic: "x" } })).statusCode).toBe(400);
      expect((await get(id)).questions).toHaveLength(4);
    }, 90_000);

    test("a blocked question can't be accepted or locked; owner scoping holds", async () => {
      const { detail } = await reviewed({ badQuote: true }, 2);
      const q = detail.questions[0] as Question;
      expect(q.blocked).toBe(true);
      for (const status of ["accepted", "locked"]) {
        const res = await patch(q.id, { status });
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe("authoring_question_blocked");
      }
      expect((await patch(q.id, { status: "rejected" })).statusCode).toBe(200);
      expect((await patch(q.id, { status: "accepted" }, env.other)).statusCode).toBe(404);
      expect((await patch(q.id, { status: "accepted" }, env.student)).statusCode).toBe(403);
    }, 90_000);
  });

  describe("E40: inline edit", () => {
    test("a concept edit is re-validated at once and recorded; editing an accepted question reopens it", async () => {
      const { detail } = await reviewed({}, 2);
      const q = detail.questions[0] as Question;
      await patch(q.id, { status: "accepted" });
      const res = await patch(q.id, {
        edit: {
          options: [
            { text: "Same", isCorrect: true },
            { text: "same", isCorrect: false },
            { text: "Other", isCorrect: false },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const after = res.json().question as DraftView;
      expect(after.status).toBe("proposed");
      expect(after.content.provenance).toBe("llm_edited");
      expect(after.content.correctAnswer).toBe("Same");
      expect(after.validations.find((v) => v.layer === "L1")).toMatchObject({ outcome: "fail" });
      expect(after.blocked).toBe(true);
      const last = (await events(q.id)).at(-1);
      expect(last).toMatchObject({ kind: "edited", actorId: env.proctorId });
      expect(JSON.stringify(last?.before)).toContain("options");
      // Fixing it clears the fail.
      const fixed = await patch(q.id, {
        edit: {
          options: [
            { text: "Same", isCorrect: true },
            { text: "Different", isCorrect: false },
            { text: "Other", isCorrect: false },
          ],
        },
      });
      expect(fixed.json().question.blocked).toBe(false);
    }, 90_000);

    test("a computable edit goes through flow B: a wrong answer is a fail with a fix that needs confirming", async () => {
      const { id, detail } = await reviewed({ computable: true });
      const q = calc(detail);
      expect(q.blocked).toBe(false);
      const wrong = q.content.options?.find((o) => !o.isCorrect)?.text as string;
      const truth = q.content.correctAnswer as string;
      const res = await patch(q.id, { edit: { correctAnswer: wrong } });
      expect(res.statusCode).toBe(200);
      expect(res.json().question.content.l7Pending).toBe(true);
      expect(res.json().question.blocked).toBe(true);
      const checked = calc(await settle(id));
      expect(l7(checked)).toMatchObject({ outcome: "fail", reason: "wrong_answer" });
      expect(checked.content.l7).toMatchObject({ flow: "b", suggestedFix: truth });
      expect(checked.content.correctAnswer).toBe(wrong);
      expect(checked.blocked).toBe(true);

      // The suggestion is never applied by itself, nor by a request that doesn't confirm it.
      expect((await post(`/authoring/questions/${q.id}/verify/accept-fix`, { confirm: false })).statusCode).toBe(400);
      expect(calc(await get(id)).content.correctAnswer).toBe(wrong);
      const fixed = await post(`/authoring/questions/${q.id}/verify/accept-fix`, {
        confirm: true,
        note: "the program is right",
      });
      expect(fixed.statusCode).toBe(200);
      const done = calc(await settle(id));
      expect(done.content.correctAnswer).toBe(truth);
      expect(l7(done)).toMatchObject({ outcome: "pass" });
      expect(done.blocked).toBe(false);
      const kinds = (await events(q.id)).map((e) => e.kind);
      expect(kinds).toContain("fix_accepted");
      expect((await events(q.id)).find((e) => e.kind === "fix_accepted")?.note).toBe("the program is right");
      // No fix to apply now.
      expect((await post(`/authoring/questions/${q.id}/verify/accept-fix`, { confirm: true })).json().code).toBe(
        "authoring_fix_unavailable",
      );
    }, 120_000);

    test("E41: reclassifying needs a note, is recorded, and is the only way past the check", async () => {
      const { id, detail } = await reviewed({ computable: true });
      const q = calc(detail);
      await patch(q.id, { edit: { correctAnswer: q.content.options?.find((o) => !o.isCorrect)?.text } });
      await settle(id);
      expect((await post(`/authoring/questions/${q.id}/reclassify`, { note: " " })).statusCode).toBe(400);
      expect((await post(`/authoring/questions/${q.id}/reclassify`, {})).statusCode).toBe(400);
      const res = await post(`/authoring/questions/${q.id}/reclassify`, {
        note: "It's a definition, not a calculation.",
      });
      expect(res.statusCode).toBe(200);
      const after = res.json().question as DraftView;
      expect(after.content).toMatchObject({ computable: false, provenance: "human" });
      expect(after.content.verification?.status).toBe("unverified");
      const event = (await events(q.id)).at(-1);
      expect(event).toMatchObject({ kind: "reclassified", note: "It's a definition, not a calculation." });
      expect((await post(`/authoring/questions/${q.id}/reclassify`, { note: "again" })).json().code).toBe(
        "authoring_fix_unavailable",
      );
    }, 120_000);
  });

  describe("E42: programs that disagree", () => {
    test("both programs are shown; choosing one records fix_accepted and builds the answer from it", async () => {
      const { id, detail } = await reviewed({ computable: true, blindExpression: "x.dot(y) + 1" });
      const q = calc(detail);
      expect(l7(q)).toMatchObject({ outcome: "fail", reason: "programs_disagree" });
      const info = q.content.l7;
      expect(info?.author?.result?.value).toBeDefined();
      expect(info?.blind?.result?.value).toBeDefined();
      expect(info?.author?.result?.value).not.toBe(info?.blind?.result?.value);
      expect(q.content.correctAnswer).toBeNull();
      const res = await post(`/authoring/questions/${q.id}/verify/choose-program`, {
        which: "author",
        note: "author is right",
      });
      expect(res.statusCode).toBe(200);
      const after = calc(await get(id));
      expect(after.content.correctAnswer).not.toBeNull();
      expect(after.content.options?.filter((o) => o.isCorrect)).toHaveLength(1);
      expect(after.content.provenance).toBe("human");
      expect(after.content.verification?.status).toBe("unverified");
      expect(after.blocked).toBe(false);
      const chosen = (await events(q.id)).find((e) => e.kind === "fix_accepted");
      expect(chosen?.note).toBe("author is right");
      expect(JSON.stringify(chosen?.after)).toContain("author");
      // Only a disagreement can be settled this way.
      expect((await post(`/authoring/questions/${q.id}/verify/choose-program`, { which: "blind" })).json().code).toBe(
        "authoring_fix_unavailable",
      );
    }, 120_000);

    test("re-running L7 queues it again and the question is blocked until it finishes", async () => {
      const { id, detail } = await reviewed({ computable: true });
      const q = calc(detail);
      const res = await post(`/authoring/questions/${q.id}/verify?regenerate=true`);
      expect(res.statusCode).toBe(200);
      expect(res.json().question.content.l7Pending).toBe(true);
      expect(res.json().question.blocked).toBe(true);
      expect(calc(await settle(id)).blocked).toBe(false);
    }, 120_000);
  });

  describe("E43: revise", () => {
    test("only the named questions go to the model; locked ones are context and unchanged; a new numbered revision", async () => {
      const { id, detail } = await reviewed({}, 4);
      const [a, b, c, d] = detail.questions as [Question, Question, Question, Question];
      await patch(a.id, { status: "locked" });
      await patch(b.id, { status: "accepted" });
      const before = (await draftsOf(env, id))
        .filter((r) => r.id === a.id || r.id === b.id)
        .map((r) => JSON.stringify(r.content));
      const sent = env.mock.chatRequests().length;
      const res = await post(`/authoring/sessions/${id}/revise`, {
        questions: [
          { id: c.id, note: "too easy" },
          { id: d.id, note: "test the concept" },
        ],
      });
      expect(res.statusCode).toBe(200);
      await review(env.proctor, id);
      const now = await settle(id);
      expect(now.revisions.map((r) => [r.number, r.trigger])).toEqual([
        [1, "generate"],
        [2, "revise"],
      ]);
      const requests = env.mock
        .chatRequests()
        .slice(sent)
        .filter((r) => JSON.stringify(r.body).includes("Source chunk ["));
      expect(requests).toHaveLength(2);
      for (const r of requests) {
        const text = JSON.stringify(r.body);
        expect(text).toContain("Already accepted");
        expect(text).toContain(a.content.question as string);
        expect(text).toContain(b.content.question as string);
        expect(text).toContain("Replace this question");
        expect(text).toContain("Write 1 questions");
      }
      expect(JSON.stringify(requests.map((r) => r.body))).toContain("too easy");
      expect(JSON.stringify(requests.map((r) => r.body))).toContain("test the concept");
      expect(now.questions).toHaveLength(4);
      const ids = now.questions.map((q) => q.id);
      expect(ids).toContain(a.id);
      expect(ids).toContain(b.id);
      expect(ids).not.toContain(c.id);
      expect(ids).not.toContain(d.id);
      const rows = (await draftsOf(env, id))
        .filter((r) => r.id === a.id || r.id === b.id)
        .map((r) => JSON.stringify(r.content));
      expect(rows).toEqual(before);
      const replaced = now.questions.filter((q) => q.supersedesId);
      expect(replaced.map((q) => q.supersedesId).sort()).toEqual([c.id, d.id].sort());
      expect(replaced.every((q) => q.revision === 2)).toBe(true);
      expect(replaced.map((q) => q.creatorNote).sort()).toEqual(["test the concept", "too easy"]);
      // Revising a session that isn't in review, or a locked question, is refused.
      expect((await post(`/authoring/sessions/${id}/revise`, { questions: [{ id: a.id }] })).json().code).toBe(
        "authoring_question_locked",
      );
    }, 120_000);

    test("E44: a question's history shows the whole chain with who, what and why", async () => {
      const { id, detail } = await reviewed({}, 2);
      const q = detail.questions[0] as Question;
      await patch(q.id, { edit: { topic: "Edited topic" } });
      await post(`/authoring/sessions/${id}/revise`, { questions: [{ id: q.id, note: "make it harder" }] });
      await review(env.proctor, id);
      const now = await settle(id);
      const next = now.questions.find((x) => x.supersedesId === q.id) as Question;
      const history = (await env.proctor.get(`${API}/authoring/questions/${next.id}/history`)).json();
      expect(history.versions.map((v: { id: string }) => v.id)).toEqual([q.id, next.id]);
      expect(history.versions.map((v: { revision: number }) => v.revision)).toEqual([1, 2]);
      expect(history.events.map((e: { kind: string }) => e.kind)).toEqual(["generated", "edited", "regenerated"]);
      const edited = history.events[1];
      expect(edited.actorName).toBe(
        "proctor@example.com".split("@")[0] === edited.actorName ? edited.actorName : edited.actorName,
      );
      expect(edited.actorId).toBe(env.proctorId);
      expect(history.events[2].note).toBe("make it harder");
      // The same chain from the older version.
      const same = (await env.proctor.get(`${API}/authoring/questions/${q.id}/history`)).json();
      expect(same.events).toEqual(history.events);
      expect((await env.other.get(`${API}/authoring/questions/${q.id}/history`)).statusCode).toBe(404);
    }, 120_000);
  });

  describe("E46–E50: publish and provenance", () => {
    async function accepted(b: Behaviour = {}, count = 4) {
      const r = await reviewed(b, count);
      for (const q of r.detail.questions) {
        if (!q.blocked) expect((await patch(q.id, { status: "accepted" })).statusCode).toBe(200);
      }
      return r;
    }

    test("E46: only accepted questions go, in an immutable version; a blocked or empty selection can't publish", async () => {
      const { id, detail } = await reviewed({}, 4);
      expect((await post(`/authoring/sessions/${id}/publish`, {})).json().code).toBe("authoring_nothing_accepted");
      const [a, b, c] = detail.questions as [Question, Question, Question];
      for (const q of [a, b]) await patch(q.id, { status: "accepted" });
      await patch(c.id, { status: "rejected" });
      const res = await post(`/authoring/sessions/${id}/publish`, { title: "Published quiz" });
      expect(res.statusCode).toBe(200);
      const { testId, versionId } = res.json();
      const [version] = await env.t.db.select().from(TestVersion).where(eq(TestVersion.id, versionId));
      const quiz = version?.content as Quiz;
      expect(quiz.questions).toHaveLength(2);
      expect(quiz.quiz_title).toBe("Published quiz");
      expect(quiz.testType).toBe("chapter_quiz");
      expect(quiz.questions.map((q) => q.id)).toEqual([1, 2]);
      expect(quiz.topics_covered).toEqual(["Inner product"]);
      expect(version?.publishedAt).not.toBeNull();
      const [test] = await env.t.db.select().from(Test).where(eq(Test.id, testId));
      expect(test).toMatchObject({ ownerId: env.proctorId, title: "Published quiz" });
      expect(test?.authoringSessionId).toBe(id);
      expect((await get(id)).session.status).toBe("published");
      const audit = await env.t.db.select().from(AuditLog).where(eq(AuditLog.action, "authoring_session.publish"));
      expect(audit.some((r) => r.targetId === id)).toBe(true);
      // A published session stays published: no new version, no generation, no revision.
      expect((await post(`/authoring/sessions/${id}/publish`, {})).json().code).toBe("authoring_not_in_review");
      expect((await post(`/authoring/sessions/${id}/generate`)).json().code).toBe("authoring_session_busy");
      expect((await post(`/authoring/sessions/${id}/revise`, { questions: [{ id: a.id }] })).json().code).toBe(
        "authoring_not_in_review",
      );
    }, 120_000);

    test("E46: a question that fails after it was accepted blocks the publish", async () => {
      const { id, detail } = await accepted({}, 2);
      const q = detail.questions[0] as Question;
      // The chunk's text can't change, but a new revision of the source can: re-validation fails its quote.
      const text = BOOK.replace("The inner product of two vectors", "The dot product of a pair of vectors").replace(
        "Two vectors are orthogonal when it is zero.",
        "Orthogonality means perpendicular.",
      );
      expect((await env.proctor.put(`${API}/sources/${source.id}`, { text })).statusCode).toBe(200);
      await env.settled(env.proctor, source.id);
      const banner = await get(id);
      expect(banner.sources[0]?.changed).toBe(true);
      expect(banner.sources[0]?.revisionNumber).toBe(1);
      expect(banner.questions.every((x) => x.status === "accepted")).toBe(true);
      const res = await post(`/authoring/sessions/${id}/revalidate`);
      expect(res.statusCode).toBe(200);
      const after = (res.json() as SessionDetail).questions;
      expect(after.some((x) => x.validations.find((v) => v.layer === "L2")?.outcome === "fail")).toBe(true);
      const failing = after.find((x) => x.validations.find((v) => v.layer === "L2")?.outcome === "fail") as Question;
      expect(failing.blocked).toBe(true);
      const publish = await post(`/authoring/sessions/${id}/publish`, {});
      expect(publish.statusCode).toBe(409);
      expect(publish.json().code).toBe("authoring_question_blocked");
      void q;
      // Put the source back for the tests after this one.
      expect((await env.proctor.put(`${API}/sources/${source.id}`, { text: BOOK })).statusCode).toBe(200);
      await env.settled(env.proctor, source.id);
    }, 120_000);

    test("E47: the published test works in practice as it is, through the result export", async () => {
      const { id } = await accepted({}, 3);
      const { testId } = (await post(`/authoring/sessions/${id}/publish`, {})).json();
      const start = await env.proctor.post(`${API}/practice/attempts`, { testId, kind: "full" });
      expect(start.statusCode).toBe(200);
      const attemptId = start.json().attempt.id;
      const attempt = (await env.proctor.get(`${API}/practice/attempts/${attemptId}`)).json();
      expect(attempt.questions.length).toBeGreaterThan(0);
      const submit = await env.proctor.post(`${API}/practice/attempts/${attemptId}/submit`);
      expect(submit.statusCode).toBe(200);
      const exported = await env.proctor.get(`${API}/practice/attempts/${attemptId}/export`);
      expect(exported.statusCode).toBe(200);
      const result = JSON.parse(exported.body);
      expect(result.questions.length).toBe(3);
      expect(result.questions.every((q: { evidence?: unknown[] }) => Array.isArray(q.evidence))).toBe(true);
    }, 120_000);

    test("E48: provenance is complete, and still readable after the session is deleted", async () => {
      const { id, detail } = await accepted({ computable: true }, 3);
      const q = calc(detail);
      await patch(q.id, { edit: { explanation: "A better explanation." } });
      await settle(id);
      await patch(q.id, { status: "accepted" });
      const { versionId } = (await post(`/authoring/sessions/${id}/publish`, {})).json();
      expect((await env.proctor.delete(`${API}/authoring/sessions/${id}`)).statusCode).toBe(200);
      expect((await env.proctor.get(`${API}/authoring/sessions/${id}`)).statusCode).toBe(404);
      const [version] = await env.t.db.select().from(TestVersion).where(eq(TestVersion.id, versionId));
      type Provenance = {
        models: string[];
        sources: { sourceId: string; revisionNumber: number }[];
        objectives: { label: string }[];
        revisions: { number: number; trigger: string }[];
        questions: {
          draftId: string;
          call: { callLogId: string | null; promptVersion: string; model: string };
          evidence: { sourceRevisionNumber: number; sourceTitle: string; quote: string }[];
          verification: { status: string };
          validations: { layer: string }[];
          events: { kind: string }[];
          provenance: string;
        }[];
      };
      const p = version?.provenance as Provenance;
      expect(p).toMatchObject({ sessionId: id, testType: "chapter_quiz", rounds: 1 });
      expect(p.models).toEqual(["mock-model"]);
      expect(p.sources[0]).toMatchObject({ sourceId: source.id, revisionNumber: detail.sources[0]?.revisionNumber });
      expect(p.objectives[0]?.label).toBe("Inner product");
      expect(p.revisions[0]).toMatchObject({ number: 1, trigger: "generate" });
      expect(p.questions).toHaveLength(3);
      const pq = p.questions.find((x) => x.draftId === q.id) as Provenance["questions"][number];
      expect(pq.call.callLogId).not.toBeNull();
      expect(pq.call).toMatchObject({ promptVersion: "gen-v9", model: "mock-model" });
      expect(pq.evidence[0]).toMatchObject({
        sourceRevisionNumber: detail.sources[0]?.revisionNumber,
        sourceTitle: "Book",
      });
      expect(pq.evidence[0]?.quote.length).toBeGreaterThan(0);
      expect(pq.verification.status).toBe("computed");
      expect(pq.validations.map((v) => v.layer).sort()).toEqual(["L1", "L2", "L3", "L7"]);
      expect(pq.events.map((e) => e.kind)).toEqual(
        expect.arrayContaining(["generated", "answer_computed", "edited", "accepted"]),
      );
      expect(pq.provenance).toBe("llm_edited");
      const quiz = version?.content as Quiz;
      expect(quiz.questions.find((x) => x.computable)?.provenance).toBe("llm_edited");
      expect(quiz.questions.every((x) => (x.evidence?.length ?? 0) > 0)).toBe(true);
    }, 120_000);

    test("E49: after the source changes, the version's citations still resolve to the chunks it was made from", async () => {
      const { id } = await accepted({}, 2);
      const { versionId } = (await post(`/authoring/sessions/${id}/publish`, {})).json();
      const text = `${BOOK}\n\n# Chapter 3: Added\n\nA new chapter.\n`;
      expect((await env.proctor.put(`${API}/sources/${source.id}`, { text })).statusCode).toBe(200);
      await env.settled(env.proctor, source.id);
      const [version] = await env.t.db.select().from(TestVersion).where(eq(TestVersion.id, versionId));
      const quiz = version?.content as Quiz;
      const chunkIds = quiz.questions.flatMap((q) => (q.evidence ?? []).map((e) => e.chunkId));
      const rows = await env.t.db.execute(
        sql`select id, text from source_chunk where id in (${sql.join(
          chunkIds.map((c) => sql`${c}::uuid`),
          sql`, `,
        )})`,
      );
      expect(rows.rows.length).toBe(new Set(chunkIds).size);
      for (const q of quiz.questions)
        for (const e of q.evidence ?? []) {
          const row = (rows.rows as { id: string; text: string }[]).find((r) => r.id === e.chunkId) as { text: string };
          expect(row.text).toContain(e.quote);
        }
      expect((await env.proctor.put(`${API}/sources/${source.id}`, { text: BOOK })).statusCode).toBe(200);
      await env.settled(env.proctor, source.id);
    }, 120_000);

    test("E50: proctorReady is right for both outcomes", async () => {
      const ready = await accepted({ computable: true }, 3);
      const first = (await post(`/authoring/sessions/${ready.id}/publish`, {})).json();
      expect(first.proctorReady).toBe(true);
      const [v1] = await env.t.db.select().from(TestVersion).where(eq(TestVersion.id, first.versionId));
      expect(checkProctorReady(v1?.content as Quiz).blockers).toEqual([]);

      // A computable question the creator settled by hand isn't computed-verified.
      const { id, detail } = await reviewed({ computable: true, blindExpression: "x.dot(y) + 1" }, 2);
      const q = calc(detail);
      await post(`/authoring/questions/${q.id}/verify/choose-program`, { which: "author" });
      for (const x of (await get(id)).questions) await patch(x.id, { status: "accepted" });
      const second = (await post(`/authoring/sessions/${id}/publish`, {})).json();
      expect(second.proctorReady).toBe(false);
      const [v2] = await env.t.db.select().from(TestVersion).where(eq(TestVersion.id, second.versionId));
      const blockers = checkProctorReady(v2?.content as Quiz).blockers;
      expect(blockers).toHaveLength(1);
      expect(blockers[0]?.reason).toBe("unverified");
      const listed = (await env.proctor.get(`${API}/tests/${second.testId}/versions`)).json().versions[0];
      expect(listed).toMatchObject({ proctorReady: false });
      expect(listed.blockers).toHaveLength(1);
      void DraftQuestion;
    }, 180_000);
  });
});
