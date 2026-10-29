import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AuditLog, User, UserSession } from "@gem/db";
import { eq } from "drizzle-orm";
import { BCRYPT_COST } from "../src/auth/passwords.ts";
import { bootstrapEnvAdmin, LOCKOUT_THRESHOLD } from "../src/routes/auth.ts";
import { API, Client, createTestApp, hasDb, PASSWORD, registerUser, signIn, type TestApp } from "./helpers.ts";

describe.skipIf(!hasDb)("auth", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t?.close());

  test("A18: without env, the first registration becomes admin and the second student", async () => {
    const a = await registerUser(t.app, "first@example.com");
    const b = await registerUser(t.app, "second@example.com");
    expect(a.user.role).toBe("admin");
    expect(b.user.role).toBe("student");
    const created = await t.db.select().from(AuditLog).where(eq(AuditLog.action, "user.create"));
    expect(created).toHaveLength(1);
    expect(created[0]?.after).toMatchObject({ role: "admin", via: "first_registration" });
  });

  test("A12: passwords are stored as bcrypt with cost >= 12", async () => {
    const rows = await t.db.select().from(User).where(eq(User.email, "first@example.com"));
    const hash = rows[0]?.passwordHash ?? "";
    expect(hash).toMatch(/^\$2[aby]\$\d\d\$/);
    expect(Number(hash.slice(4, 6))).toBeGreaterThanOrEqual(12);
    expect(BCRYPT_COST).toBe(12);
    expect(hash).not.toContain(PASSWORD);
  });

  test("A12: password inputs over 72 bytes are rejected with an error code", async () => {
    const long = "é".repeat(37); // 74 bytes, 37 characters
    const c = new Client(t.app);
    const res = await c.post(`${API}/auth/register`, { email: "long@example.com", password: long, displayName: "L" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ code: "auth_password_too_long", params: { maxBytes: 72 } });
    const login = await c.post(`${API}/auth/login`, { email: "first@example.com", password: long });
    expect(login.json().code).toBe("auth_invalid_credentials");
  });

  test("A13: the session cookie is httpOnly, SameSite=Lax and Secure", async () => {
    const { res } = await signIn(t.app, "first@example.com");
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === "gem_session");
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", secure: true, path: "/" });
  });

  test("A13: Secure is off only when NODE_ENV=development", async () => {
    const dev = await createTestApp({ env: { NODE_ENV: "development" }, database: t.database });
    try {
      const { res } = await signIn(dev.app, "first@example.com");
      const cookie = res.cookies.find((c) => c.name === "gem_session");
      expect(cookie?.secure).toBeFalsy();
      expect(cookie?.httpOnly).toBe(true);
    } finally {
      await dev.close();
    }
  });

  test("A14: logout invalidates the (cached) session within the same request", async () => {
    const { client } = await signIn(t.app, "second@example.com");
    expect((await client.get(`${API}/auth/me`)).statusCode).toBe(200); // now cached
    const token = client.cookie;
    expect((await client.post(`${API}/auth/logout`)).statusCode).toBe(200);
    const reused = new Client(t.app);
    reused.cookie = token;
    const res = await reused.get(`${API}/auth/me`);
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("unauthenticated");
  });

  test("A14: a role change takes effect on the very next request (cached decision cleared)", async () => {
    const admin = (await signIn(t.app, "first@example.com")).client;
    const { client: student } = await signIn(t.app, "second@example.com");
    expect((await student.get(`${API}/tests`)).statusCode).toBe(403); // decision cached as deny
    const id = (await student.get(`${API}/auth/me`)).json().user.id;
    expect((await admin.put(`${API}/admin/users/${id}/roles`, { role: "proctor" })).statusCode).toBe(200);
    expect((await student.get(`${API}/tests`)).statusCode).toBe(200);
    expect((await student.get(`${API}/auth/me`)).json().user.role).toBe("proctor");
    expect((await admin.put(`${API}/admin/users/${id}/roles`, { role: "student" })).statusCode).toBe(200);
    expect((await student.get(`${API}/tests`)).statusCode).toBe(403);
  });

  test("A15: lockout after 10 failed logins; correct password then refused; admin reset clears it", async () => {
    await registerUser(t.app, "victim@example.com");
    const c = new Client(t.app);
    for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i++) {
      const r = await c.post(`${API}/auth/login`, { email: "victim@example.com", password: "wrong password" });
      expect(r.json().code).toBe("auth_invalid_credentials");
    }
    const tenth = await c.post(`${API}/auth/login`, { email: "victim@example.com", password: "wrong password" });
    expect(tenth.statusCode).toBe(423);
    expect(tenth.json().code).toBe("auth_account_locked");
    const right = await c.post(`${API}/auth/login`, { email: "victim@example.com", password: PASSWORD });
    expect(right.json().code).toBe("auth_account_locked");

    const admin = (await signIn(t.app, "first@example.com")).client;
    const users = (await admin.get(`${API}/admin/users`)).json().users as {
      id: string;
      email: string;
      lockedUntil: string | null;
    }[];
    const victim = users.find((u) => u.email === "victim@example.com");
    expect(victim?.lockedUntil).not.toBeNull();
    const reset = await admin.post(`${API}/admin/users/${victim?.id}/reset-password`, { password: "a new password 1" });
    expect(reset.json().user.lockedUntil).toBeNull();
    expect(
      (await c.post(`${API}/auth/login`, { email: "victim@example.com", password: "a new password 1" })).statusCode,
    ).toBe(200);
    // ~15 bcrypt (cost 12) operations: well over the default 5 s on a slow or busy machine.
  }, 30_000);

  test("A15: rate limit on login/register returns 429 with an error code", async () => {
    const limited = await createTestApp({ env: { AUTH_RATE_LIMIT_MAX: "3" }, database: t.database });
    try {
      const c = new Client(limited.app);
      const codes: number[] = [];
      let last: { code?: string } = {};
      for (let i = 0; i < 4; i++) {
        const r = await c.post(`${API}/auth/login`, { email: "nobody@example.com", password: "whatever pw" });
        codes.push(r.statusCode);
        last = r.json();
      }
      expect(codes).toEqual([401, 401, 401, 429]);
      expect(last).toMatchObject({ code: "rate_limited" });
      // Registration has its own limit.
      const regCodes: number[] = [];
      for (let i = 0; i < 4; i++) {
        const r = await c.post(`${API}/auth/register`, {
          email: "taken@example",
          password: PASSWORD,
          displayName: "R",
        });
        regCodes.push(r.statusCode);
        last = r.json();
      }
      expect(regCodes).toEqual([400, 400, 400, 429]);
      expect(last).toMatchObject({ code: "rate_limited" });
    } finally {
      await limited.close();
    }
  });

  test("A19: self-registration off → POST /auth/register is 403 with an error code", async () => {
    const admin = (await signIn(t.app, "first@example.com")).client;
    expect((await admin.put(`${API}/admin/settings`, { selfRegistration: false })).statusCode).toBe(200);
    const res = await new Client(t.app).post(`${API}/auth/register`, {
      email: "late@example.com",
      password: PASSWORD,
      displayName: "Late",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ code: "auth_registration_disabled", params: {} });
    await admin.put(`${API}/admin/settings`, { selfRegistration: true });
  });

  test("disabling a user ends their sessions and blocks login", async () => {
    const admin = (await signIn(t.app, "first@example.com")).client;
    const { client: u, user } = await registerUser(t.app, "todisable@example.com");
    expect((await admin.post(`${API}/admin/users/${user.id}/disable`, { disabled: true })).statusCode).toBe(200);
    expect((await u.get(`${API}/auth/me`)).statusCode).toBe(401);
    expect((await t.db.select().from(UserSession).where(eq(UserSession.userId, user.id))).length).toBe(0);
    const again = await signIn(t.app, "todisable@example.com");
    expect(again.res.json().code).toBe("auth_account_disabled");
  });

  test("the last admin can't be demoted or disabled", async () => {
    const admin = (await signIn(t.app, "first@example.com")).client;
    const id = (await admin.get(`${API}/auth/me`)).json().user.id;
    expect((await admin.put(`${API}/admin/users/${id}/roles`, { role: "student" })).json().code).toBe(
      "admin_last_admin",
    );
    expect((await admin.post(`${API}/admin/users/${id}/disable`, { disabled: true })).json().code).toBe(
      "admin_last_admin",
    );
  });
});

describe.skipIf(!hasDb)("A18: env bootstrap", () => {
  test("the env admin is created once; the first registration is then a student", async () => {
    const t = await createTestApp({ env: { ADMIN_EMAIL: "root@example.com", ADMIN_PASSWORD: "root password 1" } });
    try {
      await bootstrapEnvAdmin(t.ctx);
      await bootstrapEnvAdmin(t.ctx);
      const users = await t.db.select().from(User);
      expect(users.map((u) => u.email)).toEqual(["root@example.com"]);
      const { res, client } = await signIn(t.app, "root@example.com", "root password 1");
      expect(res.json().user.role).toBe("admin");
      const audit = await t.db.select().from(AuditLog);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ action: "user.create", actorId: null, targetId: users[0]?.id });
      expect(JSON.stringify(audit[0])).not.toContain("root password 1");
      const first = await registerUser(t.app, "someone@example.com");
      expect(first.user.role).toBe("student");
      expect((await client.get(`${API}/admin/users`)).statusCode).toBe(200);
    } finally {
      await t.close();
    }
  });
});
