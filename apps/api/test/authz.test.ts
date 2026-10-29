import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACTS } from "@gem/shared/contracts";
import { API, Client, createTestApp, hasDb, registerUser, signIn, type TestApp } from "./helpers.ts";

const FIXTURE = readFileSync(
  join(import.meta.dir, "..", "..", "..", "tests", "engr108_chapter1_new_20q_quiz.json"),
  "utf8",
);
const FIXED = FIXTURE.replace('"correctAnswer": "1"', '"correctAnswer": "-1"');

type Who = "anonymous" | "student" | "owner" | "other" | "admin";
const WHO: Who[] = ["anonymous", "student", "owner", "other", "admin"];
type Expect = "allow" | "deny";

describe.skipIf(!hasDb)("A17: authz matrix — every P0 route × role", () => {
  let t: TestApp;
  const clients = {} as Record<Who, Client>;
  let testId = "";
  let targetId = "";

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
  const adminOnly: Record<Who, Expect> = {
    anonymous: "deny",
    student: "deny",
    owner: "deny",
    other: "deny",
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
