import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  createDb,
  createPool,
  type Db,
  decryptSecret,
  Endpoint,
  encryptSecret,
  LlmCallLog,
  LlmEvalRun,
  newId,
  RoleAssignment,
  InstanceSettings as SettingsTable,
} from "@gem/db";
import { DEFAULT_VERIFY_SETTINGS } from "@gem/shared";
import { eq, sql } from "drizzle-orm";
import type pg from "pg";
import { getSettings } from "../src/settings.ts";
import { API, createTestApp, createTestDatabase, hasDb, registerUser, type TestDatabase } from "./helpers.ts";

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

const CHECK = "23514";
const UNIQUE = "23505";
const FK = "23503";
const DENIED = "42501";

describe("C3: secret crypto", () => {
  const key = randomBytes(32).toString("base64");
  const id = "01890000-0000-7000-8000-000000000000";

  test("round-trip", () => {
    expect(decryptSecret(encryptSecret("sk-täst", key, id), key, id)).toBe("sk-täst");
  });

  test("a fresh IV per write: two encryptions differ", () => {
    expect(encryptSecret("sk", key, id)).not.toBe(encryptSecret("sk", key, id));
  });

  test("a tampered ciphertext, a wrong key, or another endpoint id fails", () => {
    const c = encryptSecret("sk-test", key, id);
    const raw = Buffer.from(c, "base64");
    raw[14] = (raw[14] as number) ^ 1;
    expect(() => decryptSecret(raw.toString("base64"), key, id)).toThrow();
    expect(() => decryptSecret(c, randomBytes(32).toString("base64"), id)).toThrow();
    expect(() => decryptSecret(c, key, "01890000-0000-7000-8000-000000000001")).toThrow();
  });

  test("the format is base64(iv ‖ ciphertext ‖ tag)", () => {
    expect(Buffer.from(encryptSecret("abc", key, id), "base64")).toHaveLength(12 + 3 + 16);
  });
});

describe.skipIf(!hasDb)("LLM tables, as gem_app", () => {
  let database: TestDatabase;
  let pool: pg.Pool;
  let db: Db;
  let endpointId = "";
  const capabilities = { structuredOutput: "native_schema", contextWindow: 8192, maxOutputTokens: 1024 };

  beforeAll(async () => {
    database = await createTestDatabase();
    pool = createPool(database.appUrl, 2);
    db = createDb(pool);
    endpointId = newId();
    await db.insert(Endpoint).values({ id: endpointId, label: "E", provider: "openai-compatible", location: "local" });
  });
  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  const log = () => ({
    id: newId(),
    endpointId,
    model: "m",
    kind: "call" as const,
    mode: "native_schema",
    outcome: "ok" as const,
    normalizationFixes: [],
    usage: {},
  });

  test("C2: read/write on endpoint, role_assignment, llm_eval_run; llm_call_log and audit_log append-only", async () => {
    const r = await pool.query(
      `SELECT t, p, has_table_privilege(current_user, t, p) AS ok
       FROM unnest(ARRAY['endpoint', 'role_assignment', 'llm_eval_run', 'llm_call_log', 'audit_log']) t,
            unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p`,
    );
    for (const row of r.rows) {
      const appendOnly = row.t === "llm_call_log" || row.t === "audit_log";
      expect(`${row.t} ${row.p} ${row.ok}`).toBe(
        `${row.t} ${row.p} ${!appendOnly || row.p === "SELECT" || row.p === "INSERT"}`,
      );
    }
  });

  test("C2: an UPDATE or DELETE on llm_call_log fails; an INSERT works", async () => {
    await db.insert(LlmCallLog).values(log());
    await fails(db.update(LlmCallLog).set({ model: "x" }), DENIED);
    await fails(db.delete(LlmCallLog), DENIED);
  });

  test("C1: the role check", async () => {
    await fails(
      db.insert(RoleAssignment).values({ role: "nope" as "analysis", endpointId, model: "m", capabilities }),
      CHECK,
    );
  });

  test("C1: embedding only on embeddings, and required there", async () => {
    await fails(
      db.insert(RoleAssignment).values({ role: "analysis", endpointId, model: "m", capabilities, embedding: {} }),
      CHECK,
    );
    await fails(db.insert(RoleAssignment).values({ role: "embeddings", endpointId, model: "m", capabilities }), CHECK);
    await db
      .insert(RoleAssignment)
      .values({ role: "embeddings", endpointId, model: "m", capabilities, embedding: { dimensions: 768 } });
    await db.insert(RoleAssignment).values({ role: "analysis", endpointId, model: "m", capabilities });
    const [row] = await db.select().from(RoleAssignment).where(eq(RoleAssignment.role, "analysis"));
    expect(row?.embedding).toBeNull();
    const nulls = await pool.query("SELECT embedding IS NULL AS n FROM role_assignment WHERE role = 'analysis'");
    expect(nulls.rows[0].n).toBe(true);
  });

  test("C1: endpoint, kind, outcome and status checks; the FK to endpoint", async () => {
    await fails(
      db.insert(Endpoint).values({ id: newId(), label: "E", provider: "p", location: "moon" as "local" }),
      CHECK,
    );
    await fails(db.insert(LlmCallLog).values({ ...log(), kind: "x" as "call" }), CHECK);
    await fails(db.insert(LlmCallLog).values({ ...log(), outcome: "x" as "ok" }), CHECK);
    await fails(db.insert(LlmCallLog).values({ ...log(), endpointId: newId() }), FK);
  });

  test("C1: the indexes on llm_call_log", async () => {
    const r = await pool.query("SELECT indexdef FROM pg_indexes WHERE tablename = 'llm_call_log'");
    const defs = r.rows.map((x) => x.indexdef as string).join("\n");
    expect(defs).toContain("(at)");
    expect(defs).toContain("(role, endpoint_id, model, at)");
  });

  test("one active eval run per role", async () => {
    const run = () => ({
      id: newId(),
      evalSet: "s",
      role: "analysis",
      endpointId,
      model: "m",
      promptVersion: "v",
      status: "queued" as const,
      trials: 1,
    });
    const first = run();
    await db.insert(LlmEvalRun).values(first);
    await fails(db.insert(LlmEvalRun).values(run()), UNIQUE);
    await db.update(LlmEvalRun).set({ status: "done" }).where(eq(LlmEvalRun.id, first.id));
    await db.insert(LlmEvalRun).values(run());
  });

  test("a body that is a bare JSON string stays a string", async () => {
    const entry = { ...log(), responseBody: "3.505" };
    await db.insert(LlmCallLog).values(entry);
    const [row] = await db.select().from(LlmCallLog).where(eq(LlmCallLog.id, entry.id));
    expect(row?.responseBody).toBe("3.505");
    const t = await db.execute(sql`SELECT jsonb_typeof(response_body) AS t FROM llm_call_log WHERE id = ${entry.id}`);
    expect(t.rows[0]?.t).toBe("string");
  });
});

describe.skipIf(!hasDb)("C6: localEndpointsOnly", () => {
  test("defaults to false; a settings table without it still loads; a PUT without it keeps it", async () => {
    const t = await createTestApp();
    try {
      await t.db.insert(SettingsTable).values({ key: "selfRegistration", value: false });
      expect(await getSettings(t.db)).toEqual({
        selfRegistration: false,
        localEndpointsOnly: false,
        verify: DEFAULT_VERIFY_SETTINGS,
      });
      await t.db.update(SettingsTable).set({ value: true }).where(eq(SettingsTable.key, "selfRegistration"));
      const { client } = await registerUser(t.app, "admin@example.com");
      const on = await client.put(`${API}/admin/settings`, { selfRegistration: true, localEndpointsOnly: true });
      expect(on.json().settings.localEndpointsOnly).toBe(true);
      const kept = await client.put(`${API}/admin/settings`, { selfRegistration: false });
      expect(kept.json().settings).toEqual({
        selfRegistration: false,
        localEndpointsOnly: true,
        verify: DEFAULT_VERIFY_SETTINGS,
      });
    } finally {
      await t.close();
    }
  });
});
