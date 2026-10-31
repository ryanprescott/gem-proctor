// Sessions, objectives and blueprints through the routes (P2.md E19–E23), with the mock model.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AuditLog, AuthoringSession } from "@gem/db";
import { styleLine } from "@gem/llm";
import type { ObjectiveView, SessionDetail } from "@gem/shared/contracts";
import { eq, sql } from "drizzle-orm";
import { assign } from "../../../packages/llm/test/helpers.ts";
import { BOOK, createSourceEnv, type SourceBody, type SourceEnv } from "./authoring-helpers.ts";
import { API, type Client, hasDb } from "./helpers.ts";
import { verifyPython } from "./l7-helpers.ts";

interface Section {
  id: string;
  title: string;
}

describe.skipIf(!hasDb || !verifyPython)("authoring sessions", () => {
  let env: SourceEnv;
  let source: SourceBody;
  let sections: Section[];
  let otherSource: SourceBody;

  const addSource = async (client: Client, text = BOOK) => {
    const res = await client.post(`${API}/sources`, { title: "Book", citationLabel: "VMLS", text });
    expect(res.statusCode).toBe(200);
    return env.settled(client, res.json().source.id);
  };
  const create = (client: Client, over: Record<string, unknown> = {}) =>
    client.post(`${API}/authoring/sessions`, {
      title: "Quiz 1",
      testType: "chapter_quiz",
      sources: [{ sourceId: source.id }],
      ...over,
    });
  const session = async (over: Record<string, unknown> = {}) =>
    (await create(env.proctor, over)).json() as SessionDetail;
  const section = (title: string) => sections.find((s) => s.title === title)?.id as string;
  const inputOf = (o: ObjectiveView) => ({
    id: o.id,
    label: o.label,
    description: o.description,
    evidence: o.evidence,
    sectionIds: o.sectionIds,
  });

  beforeAll(async () => {
    env = await createSourceEnv();
    await assign(env.t.db, "authoring.objectives", {
      url: env.mock.url,
      timeoutMs: 20_000,
      capabilities: { contextWindow: 32_000, maxOutputTokens: 4000 },
    });
    await assign(env.t.db, "authoring.generate", {
      url: env.mock.url,
      timeoutMs: 20_000,
      capabilities: { contextWindow: 32_000, maxOutputTokens: 8000 },
    });
    source = await addSource(env.proctor);
    sections = (await env.proctor.get(`${API}/sources/${source.id}/sections`)).json().sections;
    otherSource = await addSource(env.other);
  }, 60_000);
  afterAll(async () => env?.close());

  describe("E19: owner-scoped", () => {
    test("create, audited; list and read by the owner; another proctor 404; a student 403", async () => {
      const res = await create(env.proctor, { title: "Mine" });
      expect(res.statusCode).toBe(200);
      const { session: s } = res.json() as SessionDetail;
      expect(s.status).toBe("draft");
      const audit = await env.t.db.select().from(AuditLog).where(eq(AuditLog.action, "authoring_session.create"));
      expect(audit.some((r) => r.targetId === s.id)).toBe(true);

      const list = (await env.proctor.get(`${API}/authoring/sessions`)).json().sessions;
      expect(list.some((x: { id: string }) => x.id === s.id)).toBe(true);
      expect((await env.other.get(`${API}/authoring/sessions`)).json().sessions).toEqual([]);

      const denied = await env.other.get(`${API}/authoring/sessions/${s.id}`);
      expect(denied.statusCode).toBe(404);
      expect(denied.json().code).toBe("authoring_session_not_found");
      expect((await env.other.delete(`${API}/authoring/sessions/${s.id}`)).statusCode).toBe(404);
      expect((await env.student.get(`${API}/authoring/sessions`)).statusCode).toBe(403);
      expect((await env.student.get(`${API}/authoring/sessions/${s.id}`)).statusCode).toBe(403);
      expect((await env.admin.get(`${API}/authoring/sessions/${s.id}`)).statusCode).toBe(200);
    }, 20_000);

    test("a session can't use another user's source, even for an admin", async () => {
      const res = await create(env.proctor, { sources: [{ sourceId: otherSource.id }] });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe("source_not_found");
      expect((await create(env.admin)).statusCode).toBe(404);
      const { session: s } = await session();
      const put = await env.proctor.put(`${API}/authoring/sessions/${s.id}/scope`, {
        sources: [{ sourceId: otherSource.id }],
      });
      expect(put.statusCode).toBe(404);
    }, 20_000);

    test("a source that isn't ready can't be used", async () => {
      env.mock.options.embedDelayMs = 400;
      try {
        const res = await env.proctor.post(`${API}/sources`, { title: "New", citationLabel: "N", text: BOOK });
        const denied = await create(env.proctor, { sources: [{ sourceId: res.json().source.id }] });
        expect(denied.statusCode).toBe(409);
        expect(denied.json().code).toBe("source_not_ready");
        await env.settled(env.proctor, res.json().source.id);
      } finally {
        env.mock.options.embedDelayMs = undefined;
      }
    }, 20_000);

    test("delete is soft and audited: gone from the API, its row stays", async () => {
      const { session: s } = await session();
      expect((await env.proctor.delete(`${API}/authoring/sessions/${s.id}`)).statusCode).toBe(200);
      expect((await env.proctor.get(`${API}/authoring/sessions/${s.id}`)).statusCode).toBe(404);
      const [row] = await env.t.db.select().from(AuthoringSession).where(eq(AuthoringSession.id, s.id));
      expect(row?.deletedAt).not.toBeNull();
      const audit = await env.t.db.select().from(AuditLog).where(eq(AuditLog.action, "authoring_session.delete"));
      expect(audit.some((r) => r.targetId === s.id)).toBe(true);
    }, 20_000);
  });

  describe("E20: objectives", () => {
    test("each selected section with text starts one, citing its chunks; a scope narrows them", async () => {
      const whole = await session();
      expect(whole.objectives.map((o) => o.label)).toEqual([
        "Chapter 1: Vectors",
        "Inner product",
        "Norms",
        "Chapter 2: Matrices",
      ]);
      expect(whole.objectives.every((o) => o.origin === "heading")).toBe(true);
      expect(whole.objectives.every((o) => o.evidence.length > 0)).toBe(true);
      const narrow = await session({ sources: [{ sourceId: source.id, sectionIds: [section("Chapter 1: Vectors")] }] });
      expect(narrow.objectives.map((o) => o.label)).toEqual(["Chapter 1: Vectors", "Inner product", "Norms"]);
      const only = await session({ sources: [{ sourceId: source.id, sectionIds: [section("Norms")] }] });
      expect(only.objectives.map((o) => o.label)).toEqual(["Norms"]);
    }, 20_000);

    test("the model proposes per section, each citing real chunks, and the passages sent are in the prompt", async () => {
      const { session: s, objectives } = await session();
      const sent = env.mock.chatRequests().length;
      env.setReply((body) => {
        const content = JSON.stringify(body.messages);
        const key = /\[(vmls:[^\]]+:c1)\]/.exec(content)?.[1] as string;
        return JSON.stringify({
          objectives: [{ label: `Learn ${key}`, description: "Covers it.", chunkIds: [key] }],
        });
      });
      const res = await env.proctor.post(`${API}/authoring/sessions/${s.id}/objectives:propose`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.notice).toBeNull();
      expect(body.rejected).toBe(0);
      expect(env.mock.chatRequests().length - sent).toBe(objectives.length);
      expect(body.objectives).toHaveLength(objectives.length);
      expect(body.objectives.every((o: ObjectiveView) => o.origin === "llm")).toBe(true);
      const chunks = (await env.proctor.get(`${API}/sources/${source.id}/chunks`)).json().chunks;
      const ids = new Set(chunks.map((c: { id: string }) => c.id));
      for (const o of body.objectives) for (const e of o.evidence) expect(ids.has(e.chunkId)).toBe(true);
      const request = env.mock.chatRequests().at(-1)?.body as Record<string, unknown>;
      expect(JSON.stringify(request.messages)).toContain("[vmls:");
    }, 20_000);

    test("a citation to an unknown chunk is rejected, and that section keeps its heading", async () => {
      const { session: s } = await session({ sources: [{ sourceId: source.id, sectionIds: [section("Norms")] }] });
      env.setReply(() =>
        JSON.stringify({ objectives: [{ label: "Invented", description: "x", chunkIds: ["vmls:made-up:c9"] }] }),
      );
      const body = (await env.proctor.post(`${API}/authoring/sessions/${s.id}/objectives:propose`)).json();
      expect(body.rejected).toBe(1);
      expect(body.objectives.map((o: ObjectiveView) => o.label)).toEqual(["Norms"]);
    }, 20_000);

    test("a model failure on a section keeps its heading, and is reported", async () => {
      const { session: s } = await session({ sources: [{ sourceId: source.id, sectionIds: [section("Norms")] }] });
      env.setReply(() => ({ status: 500 }));
      const body = (await env.proctor.post(`${API}/authoring/sessions/${s.id}/objectives:propose`)).json();
      expect(body.failedSections).toEqual(["Norms"]);
      expect(body.objectives.map((o: ObjectiveView) => o.label)).toEqual(["Norms"]);
    }, 20_000);

    test("the creator can edit, merge, remove and add; what they wrote survives a new proposal", async () => {
      const { session: s, objectives } = await session();
      const [a, b, c, d] = objectives as [ObjectiveView, ObjectiveView, ObjectiveView, ObjectiveView];
      const url = `${API}/authoring/sessions/${s.id}/objectives`;
      const put = await env.proctor.put(url, {
        objectives: [
          // Edit one, keeping its id; merge two by joining their evidence; remove one; add one.
          { ...inputOf(a), label: "Edited label" },
          {
            ...inputOf(b),
            label: "Merged",
            evidence: [...b.evidence, ...c.evidence],
            sectionIds: [...b.sectionIds, ...c.sectionIds],
          },
          { label: "Added by hand", evidence: d.evidence, sectionIds: [] },
        ],
      });
      expect(put.statusCode).toBe(200);
      const next = put.json().objectives as ObjectiveView[];
      expect(next.map((o) => [o.label, o.origin])).toEqual([
        ["Edited label", "heading"],
        ["Merged", "heading"],
        ["Added by hand", "human"],
      ]);
      expect(next[0]?.id).toBe(a.id);
      expect(next[1]?.evidence).toHaveLength(b.evidence.length + c.evidence.length);

      env.setReply(() => JSON.stringify({ objectives: [] }));
      const after = (await env.proctor.post(`${API}/authoring/sessions/${s.id}/objectives:propose`)).json();
      expect(after.objectives.some((o: ObjectiveView) => o.label === "Added by hand")).toBe(true);
    }, 20_000);

    test("evidence must be a chunk in scope, and an id must be this session's", async () => {
      const { session: s, objectives } = await session({
        sources: [{ sourceId: source.id, sectionIds: [section("Norms")] }],
      });
      const chunks = (await env.proctor.get(`${API}/sources/${source.id}/chunks`)).json().chunks as {
        id: string;
        text: string;
      }[];
      const outOfScope = chunks.find((c) => c.text.includes("Matrix multiplication")) as { id: string };
      const url = `${API}/authoring/sessions/${s.id}/objectives`;
      const bad = await env.proctor.put(url, {
        objectives: [{ label: "X", evidence: [{ chunkId: outOfScope.id }], sectionIds: [] }],
      });
      expect(bad.statusCode).toBe(422);
      expect(bad.json().code).toBe("authoring_chunk_unknown");
      const foreign = await env.proctor.put(url, {
        objectives: [{ id: "01890000-0000-7000-8000-000000000000", label: "X", evidence: [], sectionIds: [] }],
      });
      expect(foreign.json().code).toBe("authoring_objective_unknown");
      expect(objectives).toHaveLength(1);
    }, 20_000);
  });

  describe("E21: roles", () => {
    test("`authoring.objectives` unassigned: headings only, with a notice, and no model call", async () => {
      const { session: s, objectives } = await session();
      await env.t.db.execute(sql`delete from role_assignment where role = 'authoring.objectives'`);
      try {
        const sent = env.mock.chatRequests().length;
        const res = await env.proctor.post(`${API}/authoring/sessions/${s.id}/objectives:propose`);
        expect(res.statusCode).toBe(200);
        expect(res.json().notice).toBe("headings_only");
        expect(res.json().objectives.map((o: ObjectiveView) => o.label)).toEqual(objectives.map((o) => o.label));
        expect(env.mock.chatRequests().length).toBe(sent);
      } finally {
        await assign(env.t.db, "authoring.objectives", { url: env.mock.url, timeoutMs: 20_000 });
      }
    }, 20_000);

    test("`embeddings` unassigned blocks authoring, with the reason", async () => {
      await env.t.db.execute(sql`delete from role_assignment where role = 'embeddings'`);
      try {
        const res = await create(env.proctor);
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe("llm_role_unassigned");
      } finally {
        await env.assignEmbeddings();
      }
    }, 20_000);
  });

  describe("E22: blueprint", () => {
    const put = (id: string, body: unknown) => env.proctor.put(`${API}/authoring/sessions/${id}/blueprint`, body);

    test("a test type fills the defaults, with per-objective counts for this session", async () => {
      const { session: s, objectives } = await session();
      const res = await put(s.id, { testType: "chapter_quiz" });
      expect(res.statusCode).toBe(200);
      const { blueprint } = res.json();
      expect(blueprint.questionCount).toBe(10);
      expect(blueprint.spread).toBe("even");
      expect(blueprint.perObjective.map((o: { objectiveId: string }) => o.objectiveId)).toEqual(
        objectives.map((o) => o.id),
      );
      expect((await env.proctor.get(`${API}/authoring/sessions/${s.id}`)).json().blueprint).toEqual(blueprint);
    }, 20_000);

    test("proportional spread reads the sections' token counts, with at least one per objective", async () => {
      const long = `# Long\n\n${"Plain sentence about vectors. ".repeat(600)}\n\n# Short\n\nA line.`;
      const big = await addSource(env.proctor, long);
      const { session: s, objectives } = await session({ sources: [{ sourceId: big.id }] });
      const { blueprint } = (await put(s.id, { testType: "midterm" })).json();
      const counts = blueprint.perObjective.map((o: { count: number }) => o.count) as number[];
      expect(objectives.map((o) => o.label)).toEqual(["Long", "Short"]);
      expect(counts).toEqual([34, 1]);
    }, 20_000);

    test("every value can change, and counts that don't add up are refused", async () => {
      const { session: s, objectives } = await session({
        sources: [{ sourceId: source.id, sectionIds: [section("Norms")] }],
      });
      const [only] = objectives as [ObjectiveView];
      const custom = {
        testType: "custom",
        questionCount: 6,
        mix: { numeric: 4, short_answer: 2 },
        spread: "proportional",
        perObjective: [{ objectiveId: only.id, count: 6 }],
        style: "Keep it short.",
        constraints: "no questions on §1.4",
      };
      const ok = await put(s.id, custom);
      expect(ok.statusCode).toBe(200);
      expect(ok.json().blueprint).toMatchObject(custom);

      const bad = await put(s.id, { ...custom, questionCount: 7 });
      expect(bad.statusCode).toBe(422);
      expect(bad.json()).toEqual({ code: "authoring_blueprint_invalid", params: { problem: "mix_sum" } });
      const foreign = await put(s.id, {
        ...custom,
        perObjective: [{ objectiveId: "01890000-0000-7000-8000-000000000000", count: 6 }],
      });
      expect(foreign.json().code).toBe("authoring_objective_unknown");
    }, 20_000);
  });

  test("E23: the style line comes from a versioned prompt file, and is saved with its version", async () => {
    const line = styleLine("chapter_quiz", "m");
    expect(line.version).toBe("style-v1");
    expect(line.line).toContain("Test individual concepts and definitions");
    expect(styleLine("custom", "m").line).toBe("");
    const { session: s } = await session();
    const { blueprint } = (
      await env.proctor.put(`${API}/authoring/sessions/${s.id}/blueprint`, { testType: "chapter_quiz" })
    ).json();
    expect(blueprint.style).toBe(line.line);
    expect(blueprint.styleVersion).toBe("style-v1");
  }, 20_000);
});
