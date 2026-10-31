import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newId, PracticeAttempt, Source, SourceRevision, VerificationJob } from "@gem/db";
import { CONTRACTS } from "@gem/shared/contracts";
import { API, Client, createTestApp, hasDb, registerUser, signIn, type TestApp } from "./helpers.ts";

const FIXTURE = readFileSync(
  join(import.meta.dir, "..", "..", "..", "tests", "engr108_chapter1_new_20q_quiz.json"),
  "utf8",
);
const FIXED = FIXTURE.replace('"correctAnswer": "1"', '"correctAnswer": "-1"');

/** The LLM routes (C26): only admins reach `/admin/llm/*`; every signed-in user reaches `/llm/roles`. */
function llmRows(admin: Record<Who, Expect>, signedIn: Record<Who, Expect>) {
  const id = "01890000-0000-7000-8000-000000000000";
  return [
    { id: "admin.llm.endpoints.list", method: "GET", url: () => "/admin/llm/endpoints", expect: admin },
    {
      id: "admin.llm.endpoints.create",
      method: "POST",
      url: () => "/admin/llm/endpoints",
      body: () => ({ label: "E", baseUrl: "http://127.0.0.1:9/v1", location: "local" }),
      expect: admin,
    },
    { id: "admin.llm.endpoints.get", method: "GET", url: () => `/admin/llm/endpoints/${id}`, expect: admin },
    {
      id: "admin.llm.endpoints.update",
      method: "PATCH",
      url: () => `/admin/llm/endpoints/${id}`,
      body: () => ({ label: "F" }),
      expect: admin,
    },
    { id: "admin.llm.endpoints.delete", method: "DELETE", url: () => `/admin/llm/endpoints/${id}`, expect: admin },
    { id: "admin.llm.endpoints.models", method: "GET", url: () => `/admin/llm/endpoints/${id}/models`, expect: admin },
    {
      id: "admin.llm.endpoints.probe",
      method: "POST",
      url: () => `/admin/llm/endpoints/${id}/probe`,
      body: () => ({ model: "m", kind: "chat" }),
      expect: admin,
    },
    { id: "admin.llm.roles.list", method: "GET", url: () => "/admin/llm/roles", expect: admin },
    {
      id: "admin.llm.roles.put",
      method: "PUT",
      url: () => "/admin/llm/roles/analysis",
      body: () => ({
        endpointId: id,
        model: "m",
        capabilities: { structuredOutput: "native_schema", contextWindow: 8192, maxOutputTokens: 1024 },
      }),
      expect: admin,
    },
    { id: "admin.llm.roles.delete", method: "DELETE", url: () => "/admin/llm/roles/analysis", expect: admin },
    { id: "admin.llm.stats", method: "GET", url: () => "/admin/llm/stats", expect: admin },
    {
      id: "admin.llm.evals.run",
      method: "POST",
      url: () => "/admin/llm/evals/run",
      body: () => ({ evalSet: "generate-smoke" }),
      expect: admin,
    },
    { id: "admin.llm.evals.list", method: "GET", url: () => "/admin/llm/evals", expect: admin },
    { id: "admin.llm.evals.get", method: "GET", url: () => `/admin/llm/evals/${id}`, expect: admin },
    { id: "llm.roles", method: "GET", url: () => "/llm/roles", expect: signedIn },
  ];
}

type Who = "anonymous" | "student" | "owner" | "other" | "admin";
const WHO: Who[] = ["anonymous", "student", "owner", "other", "admin"];
/**
 * `missing`: 404 `not_found`, for a resource that exists but is private to someone else (P1.md §5).
 * `hidden`: the same with the resource's own code (P2.md §5).
 */
type Expect = "allow" | "deny" | "missing" | "hidden";

/** The source routes (P2.md E9). Delete comes last, since it ends the source for the rows after it. */
function sourceRows(id: () => string, proctor: Record<Who, Expect>, own: Record<Who, Expect>) {
  return [
    {
      id: "sources.preview",
      method: "POST",
      url: () => "/sources/preview",
      body: () => ({ text: "# A\n\nx" }),
      expect: proctor,
    },
    {
      id: "sources.create",
      method: "POST",
      url: () => "/sources",
      body: () => ({ title: "T", citationLabel: "L", text: "# A\n\nx" }),
      expect: proctor,
    },
    { id: "sources.list", method: "GET", url: () => "/sources", expect: proctor },
    { id: "sources.get", method: "GET", url: () => `/sources/${id()}`, expect: own },
    {
      id: "sources.update",
      method: "PUT",
      url: () => `/sources/${id()}`,
      body: () => ({ text: "# B\n\ny" }),
      expect: own,
    },
    { id: "sources.revision", method: "GET", url: () => `/sources/${id()}/revisions/1`, expect: own },
    { id: "sources.sections", method: "GET", url: () => `/sources/${id()}/sections`, expect: own },
    { id: "sources.chunks", method: "GET", url: () => `/sources/${id()}/chunks`, expect: own },
    { id: "sources.embedRetry", method: "POST", url: () => `/sources/${id()}/embed:retry`, expect: own },
    { id: "sources.events", method: "GET", url: () => `/sources/${id()}/events?once=true`, expect: own },
    { id: "sources.delete", method: "DELETE", url: () => `/sources/${id()}`, expect: own },
  ];
}

describe.skipIf(!hasDb)("A17 + B21: authz matrix — every route × role", () => {
  let t: TestApp;
  const clients = {} as Record<Who, Client>;
  let testId = "";
  let targetId = "";
  let attemptId = "";
  let jobId = "";
  let sourceId = "";

  beforeAll(async () => {
    t = await createTestApp();
    clients.admin = (await registerUser(t.app, "admin@example.com")).client;
    clients.student = (await registerUser(t.app, "student@example.com")).client;
    const owner = await registerUser(t.app, "owner@example.com");
    const other = await registerUser(t.app, "other@example.com");
    const target = await registerUser(t.app, "target@example.com");
    targetId = target.user.id;
    for (const u of [owner, other]) {
      await clients.admin.put(`${API}/admin/users/${u.user.id}/roles`, { role: "proctor" });
    }
    clients.owner = (await signIn(t.app, "owner@example.com")).client;
    clients.other = (await signIn(t.app, "other@example.com")).client;
    clients.anonymous = new Client(t.app);
    const created = await clients.owner.post(`${API}/imports`, { originalText: FIXED, text: FIXED });
    expect(created.statusCode).toBe(200);
    testId = created.json().testId;
    jobId = newId();
    await t.db
      .insert(VerificationJob)
      .values({ id: jobId, ownerId: owner.user.id, status: "done", input: { questions: [] }, inputHash: "h" });
    sourceId = newId();
    await t.db.insert(Source).values({ id: sourceId, ownerId: owner.user.id, title: "S", citationLabel: "S" });
    await t.db.insert(SourceRevision).values({
      id: newId(),
      sourceId,
      number: 1,
      markdown: "# A\n\nx",
      format: "markdown",
      contentHash: "h",
      embedStatus: "ready",
      createdBy: owner.user.id,
    });
    attemptId = newId();
    await t.db.insert(PracticeAttempt).values({
      id: attemptId,
      userId: owner.user.id,
      testVersionId: created.json().versionId,
      kind: "full",
      shuffleSeed: "0123456789abcdef0123456789abcdef",
      maxScore: 20,
    });
  });
  afterAll(async () => t?.close());

  const all = (e: Expect): Record<Who, Expect> => ({ anonymous: e, student: e, owner: e, other: e, admin: e });
  const signedIn: Record<Who, Expect> = {
    anonymous: "deny",
    student: "allow",
    owner: "allow",
    other: "allow",
    admin: "allow",
  };
  const proctor: Record<Who, Expect> = {
    anonymous: "deny",
    student: "deny",
    owner: "allow",
    other: "allow",
    admin: "allow",
  };
  const ownerOnly: Record<Who, Expect> = {
    anonymous: "deny",
    student: "deny",
    owner: "allow",
    other: "deny",
    admin: "allow",
  };
  // Someone's own practice attempt: everyone else gets 404, admins included (P1.md §5).
  const ownAttempt: Record<Who, Expect> = {
    anonymous: "deny",
    student: "deny",
    owner: "allow",
    other: "missing",
    admin: "missing",
  };
  const adminOnly: Record<Who, Expect> = {
    anonymous: "deny",
    student: "deny",
    owner: "deny",
    other: "deny",
    admin: "allow",
  };
  // A source: another proctor gets 404, as if it didn't exist; an admin may reach it (P2.md §5).
  const ownSource: Record<Who, Expect> = {
    anonymous: "deny",
    student: "deny",
    owner: "allow",
    other: "hidden",
    admin: "allow",
  };

  // Every contract appears here exactly once (checked below).
  const matrix: { id: string; method: string; url: () => string; body?: () => unknown; expect: Record<Who, Expect> }[] =
    [
      { id: "health", method: "GET", url: () => "/health", expect: all("allow") },
      {
        id: "auth.register",
        method: "POST",
        url: () => "/auth/register",
        body: () => ({ email: "x", password: "x", displayName: "x" }),
        expect: all("allow"),
      },
      {
        id: "auth.login",
        method: "POST",
        url: () => "/auth/login",
        body: () => ({ email: "nobody@example.com", password: "nope nope" }),
        expect: all("allow"),
      },
      { id: "schema.quiz", method: "GET", url: () => "/schema/quiz.json", expect: all("allow") },
      { id: "schema.result", method: "GET", url: () => "/schema/result.json", expect: all("allow") },
      { id: "auth.me", method: "GET", url: () => "/auth/me", expect: signedIn },
      {
        id: "imports.preview",
        method: "POST",
        url: () => "/imports/preview",
        body: () => ({ text: FIXTURE }),
        expect: proctor,
      },
      {
        id: "imports.create",
        method: "POST",
        url: () => "/imports",
        body: () => ({ originalText: FIXED, text: FIXED }),
        expect: proctor,
      },
      { id: "tests.list", method: "GET", url: () => "/tests", expect: proctor },
      { id: "tests.get", method: "GET", url: () => `/tests/${testId}`, expect: ownerOnly },
      {
        id: "tests.update",
        method: "PATCH",
        url: () => `/tests/${testId}`,
        body: () => ({ tags: ["ch1"] }),
        expect: ownerOnly,
      },
      { id: "tests.versions", method: "GET", url: () => `/tests/${testId}/versions`, expect: ownerOnly },
      { id: "tests.export", method: "GET", url: () => `/tests/${testId}/export`, expect: ownerOnly },
      { id: "admin.users", method: "GET", url: () => "/admin/users", expect: adminOnly },
      {
        id: "admin.users.roles",
        method: "PUT",
        url: () => `/admin/users/${targetId}/roles`,
        body: () => ({ role: "student" }),
        expect: adminOnly,
      },
      {
        id: "admin.users.resetPassword",
        method: "POST",
        url: () => `/admin/users/${targetId}/reset-password`,
        body: () => ({ password: "another password" }),
        expect: adminOnly,
      },
      {
        id: "admin.users.disable",
        method: "POST",
        url: () => `/admin/users/${targetId}/disable`,
        body: () => ({ disabled: false }),
        expect: adminOnly,
      },
      {
        id: "imports.verify.start",
        method: "POST",
        url: () => "/imports/verify",
        body: () => ({ value: { questions: [{ id: 1 }] } }),
        expect: proctor,
      },
      { id: "imports.verify.get", method: "GET", url: () => `/imports/verify/${jobId}`, expect: ownerOnly },
      { id: "admin.settings.get", method: "GET", url: () => "/admin/settings", expect: adminOnly },
      {
        id: "admin.settings.put",
        method: "PUT",
        url: () => "/admin/settings",
        body: () => ({ selfRegistration: true }),
        expect: adminOnly,
      },
      { id: "admin.auditLog", method: "GET", url: () => "/admin/audit-log", expect: adminOnly },
      { id: "admin.auditLog.csv", method: "GET", url: () => "/admin/audit-log.csv", expect: adminOnly },
      {
        id: "practice.start",
        method: "POST",
        url: () => "/practice/attempts",
        body: () => ({ testId, kind: "full" }),
        // The handler also checks `test` / `practice`: the test's owner, or an admin (P1.md §6).
        expect: ownerOnly,
      },
      { id: "practice.list", method: "GET", url: () => `/practice/attempts?testId=${testId}`, expect: proctor },
      { id: "practice.get", method: "GET", url: () => `/practice/attempts/${attemptId}`, expect: ownAttempt },
      {
        id: "practice.saveResponse",
        method: "PUT",
        url: () => `/practice/attempts/${attemptId}/responses/1`,
        body: () => ({ flagged: true }),
        expect: ownAttempt,
      },
      {
        id: "practice.selfGrade",
        method: "POST",
        url: () => `/practice/attempts/${attemptId}/responses/1/self-grade`,
        body: () => ({ right: true }),
        expect: ownAttempt,
      },
      {
        id: "practice.submit",
        method: "POST",
        url: () => `/practice/attempts/${attemptId}/submit`,
        expect: ownAttempt,
      },
      {
        id: "practice.export",
        method: "GET",
        url: () => `/practice/attempts/${attemptId}/export`,
        expect: ownAttempt,
      },
      {
        id: "practice.discard",
        method: "DELETE",
        url: () => `/practice/attempts/${attemptId}`,
        expect: ownAttempt,
      },
      ...llmRows(adminOnly, signedIn),
      ...sourceRows(() => sourceId, proctor, ownSource),
      // Last: it ends each session.
      { id: "auth.logout", method: "POST", url: () => "/auth/logout", expect: signedIn },
    ];

  test("the matrix covers every contract", () => {
    expect(matrix.map((m) => m.id).sort()).toEqual(CONTRACTS.map((c) => c.id).sort());
  });

  for (const row of matrix) {
    for (const who of WHO) {
      const want = row.expect[who];
      test(`${row.id} as ${who} → ${want}`, async () => {
        const res = await clients[who].request({
          method: row.method as "GET",
          url: `${API}${row.url()}`,
          payload: row.body?.() as never,
        });
        const code = res.statusCode >= 400 ? (res.json() as { code: string }).code : undefined;
        if (want === "allow") {
          expect(["unauthenticated", "forbidden"]).not.toContain(code);
          // A missing endpoint or eval run is 404 for an admin: a row in the matrix that has none is still allowed.
          if (!row.id.startsWith("admin.llm.")) expect(code).not.toBe("not_found");
        } else if (want === "missing") {
          expect(res.statusCode).toBe(404);
          expect(code).toBe("not_found");
        } else if (want === "hidden") {
          expect(res.statusCode).toBe(404);
        } else if (who === "anonymous") {
          expect(res.statusCode).toBe(401);
          expect(res.json().code).toBe("unauthenticated");
        } else {
          expect(res.statusCode).toBe(403);
          expect(res.json().code).toBe("forbidden");
        }
      });
    }
  }

  test("students get 403 even for tests that don't exist; proctors get 404", async () => {
    const { client: s } = await signIn(t.app, "student@example.com");
    const missing = "01890000-0000-7000-8000-000000000000";
    expect((await s.get(`${API}/tests/${missing}`)).statusCode).toBe(403);
    const { client: p } = await signIn(t.app, "other@example.com");
    const res = await p.get(`${API}/tests/${missing}`);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("test_not_found");
  });

  test("B21: starting on a test that doesn't exist is 404 for a proctor and 403 for a student", async () => {
    const missing = "01890000-0000-7000-8000-000000000000";
    const { client: p } = await signIn(t.app, "other@example.com");
    const res = await p.post(`${API}/practice/attempts`, { testId: missing, kind: "full" });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("test_not_found");
    const { client: s } = await signIn(t.app, "student@example.com");
    expect((await s.post(`${API}/practice/attempts`, { testId: missing, kind: "full" })).statusCode).toBe(403);
  });

  test("B21: another user's attempt is 404 for every route, admins included, and a missing id is 404 too", async () => {
    const missing = "01890000-0000-7000-8000-000000000000";
    for (const email of ["other@example.com", "admin@example.com"]) {
      const { client } = await signIn(t.app, email);
      for (const id of [attemptId, missing]) {
        for (const [method, url] of [
          ["GET", `/practice/attempts/${id}`],
          ["GET", `/practice/attempts/${id}/export`],
          ["POST", `/practice/attempts/${id}/submit`],
          ["DELETE", `/practice/attempts/${id}`],
        ] as const) {
          const res = await client.request({ method, url: `${API}${url}` });
          expect(res.statusCode).toBe(404);
          expect(res.json().code).toBe("not_found");
        }
      }
      // Their own history doesn't include it either.
      const list = (await client.get(`${API}/practice/attempts?testId=${testId}`)).json();
      expect(list.attempts.map((a: { id: string }) => a.id)).not.toContain(attemptId);
    }
  });

  test("proctors only list their own tests; admins see all", async () => {
    const { client: other } = await signIn(t.app, "other@example.com");
    expect((await other.get(`${API}/tests`)).json().tests).toHaveLength(1); // created in the matrix
    const { client: owner } = await signIn(t.app, "owner@example.com");
    const own = (await owner.get(`${API}/tests`)).json().tests as { ownerId: string }[];
    expect(own.length).toBeGreaterThanOrEqual(2);
    const { client: admin } = await signIn(t.app, "admin@example.com");
    expect((await admin.get(`${API}/tests`)).json().tests.length).toBe(own.length + 1 + 1);
  });
});

describe.skipIf(!hasDb)("A16: startup check", () => {
  test("a route without a permission declaration fails at startup", async () => {
    let error: unknown;
    try {
      const t = await createTestApp({
        build: {
          extraRoutes: (app) => {
            app.get("/api/v1/forgotten", async () => ({ ok: true }));
          },
        },
      });
      await t.close();
    } catch (e) {
      error = e;
    }
    expect(String(error)).toContain("routes without a permission declaration");
    expect(String(error)).toContain("/api/v1/forgotten");
  });
});
