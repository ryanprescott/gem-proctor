import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { AuditLog, decryptSecret, Endpoint, LlmCallLog, RoleAssignment } from "@gem/db";
import { MockLlmServer } from "@gem/llm/mock";
import { desc, eq, inArray } from "drizzle-orm";
import { type Config, loadConfig } from "../src/config.ts";
import { seedDevLlm } from "../src/llm-seed.ts";
import { API, type Client, createTestApp, hasDb, registerUser, signIn, type TestApp, testConfig } from "./helpers.ts";

const SECRET = randomBytes(32).toString("base64");
const KEY = "sk-plain-text-key";
const capabilities = { structuredOutput: "native_schema", contextWindow: 8192, maxOutputTokens: 1024 };

describe.skipIf(!hasDb)("LLM admin API", () => {
  let t: TestApp;
  let admin: Client;
  let adminId = "";
  let student: Client;
  const mocks: MockLlmServer[] = [];

  const mock = (o: ConstructorParameters<typeof MockLlmServer>[0] = {}) => {
    const m = new MockLlmServer(o);
    mocks.push(m);
    return m;
  };

  beforeAll(async () => {
    t = await createTestApp({ env: { ENDPOINT_SECRET_KEY: SECRET, LLM_RATE_LIMIT_MAX: "1000" } });
    const a = await registerUser(t.app, "admin@example.com");
    admin = a.client;
    adminId = a.user.id;
    student = (await registerUser(t.app, "student@example.com")).client;
  });
  afterAll(async () => {
    for (const m of mocks) m.stop();
    await t?.close();
  });

  const create = async (over: Record<string, unknown> = {}) => {
    const res = await admin.post(`${API}/admin/llm/endpoints`, {
      label: "Local",
      baseUrl: "http://127.0.0.1:9/v1",
      location: "local",
      ...over,
    });
    expect(res.statusCode).toBe(200);
    return res.json().endpoint as { id: string; hasKey: boolean; [k: string]: unknown };
  };
  const put = (role: string, endpointId: string, over: Record<string, unknown> = {}) =>
    admin.put(`${API}/admin/llm/roles/${role}`, { endpointId, model: "m", capabilities, ...over });
  const audits = async (targetId: string) =>
    t.db.select().from(AuditLog).where(eq(AuditLog.targetId, targetId)).orderBy(desc(AuditLog.at));
  const row = async (id: string) => (await t.db.select().from(Endpoint).where(eq(Endpoint.id, id)))[0];

  describe("C20: endpoint CRUD", () => {
    test("create, with audit rows and no secret in them; the key is encrypted and write-only", async () => {
      const e = await create({ apiKey: KEY, server: "ollama", concurrency: 2 });
      expect(e).toMatchObject({ hasKey: true, server: "ollama", concurrency: 2, timeoutMs: 300_000 });
      expect(JSON.stringify(e)).not.toContain(KEY);
      const stored = await row(e.id);
      expect(stored?.apiKeyCiphertext).not.toContain(KEY);
      expect(decryptSecret(stored?.apiKeyCiphertext as string, SECRET, e.id)).toBe(KEY);
      const rows = await audits(e.id);
      expect(rows.map((r) => r.action).sort()).toEqual(["llm.endpoint.create", "llm.endpoint.secret_change"]);
      expect(rows.find((r) => r.action.endsWith("secret_change"))?.after).toEqual({ set: true });
      expect(JSON.stringify(rows)).not.toContain(KEY);
      expect(JSON.stringify(rows)).not.toContain(stored?.apiKeyCiphertext as string);
      expect(rows[0]?.actorId).toBe(adminId);
      const list = (await admin.get(`${API}/admin/llm/endpoints`)).json();
      expect(JSON.stringify(list)).not.toContain("iphertext");
      expect((await admin.get(`${API}/admin/llm/endpoints/${e.id}`)).json().endpoint.hasKey).toBe(true);
    });

    test("apiKey: a string sets, null clears, absent keeps; secret_change on set and clear", async () => {
      const e = await create();
      expect(e.hasKey).toBe(false);
      const keep = await admin.patch(`${API}/admin/llm/endpoints/${e.id}`, { label: "Renamed" });
      expect(keep.json().endpoint).toMatchObject({ label: "Renamed", hasKey: false });
      await admin.patch(`${API}/admin/llm/endpoints/${e.id}`, { apiKey: KEY });
      const stored = (await row(e.id))?.apiKeyCiphertext;
      expect(stored).toBeString();
      const kept = await admin.patch(`${API}/admin/llm/endpoints/${e.id}`, { label: "Again" });
      expect(kept.json().endpoint.hasKey).toBe(true);
      expect((await row(e.id))?.apiKeyCiphertext).toBe(stored as string);
      const cleared = await admin.patch(`${API}/admin/llm/endpoints/${e.id}`, { apiKey: null });
      expect(cleared.json().endpoint.hasKey).toBe(false);
      expect((await row(e.id))?.apiKeyCiphertext).toBeNull();
      const rows = await audits(e.id);
      const secret = rows.filter((r) => r.action === "llm.endpoint.secret_change").map((r) => r.after);
      expect(secret).toContainEqual({ set: true });
      expect(secret).toContainEqual({ cleared: true });
      const update = rows.find(
        (r) => r.action === "llm.endpoint.update" && (r.after as { label: string }).label === "Again",
      );
      expect(update?.before).toMatchObject({ label: "Renamed" });
      expect(JSON.stringify(rows)).not.toContain(KEY);
    });

    test("a key without ENDPOINT_SECRET_KEY is 409 llm_secret_key_missing", async () => {
      const bare = await createTestApp();
      try {
        const { client } = await registerUser(bare.app, "a@example.com");
        const res = await client.post(`${API}/admin/llm/endpoints`, {
          label: "L",
          baseUrl: "http://127.0.0.1:9/v1",
          location: "local",
          apiKey: "k",
        });
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe("llm_secret_key_missing");
      } finally {
        await bare.close();
      }
    });

    test("validation: unknown provider, missing baseUrl, a URL with credentials", async () => {
      const post = (b: object) => admin.post(`${API}/admin/llm/endpoints`, { label: "L", location: "local", ...b });
      expect((await post({ provider: "nope", baseUrl: "http://x/v1" })).statusCode).toBe(400);
      expect((await post({})).statusCode).toBe(400);
      expect((await post({ baseUrl: "http://u:p@x/v1" })).statusCode).toBe(400);
      expect((await post({ baseUrl: "ftp://x/v1" })).statusCode).toBe(400);
      const e = await create();
      const res = await admin.patch(`${API}/admin/llm/endpoints/${e.id}`, { baseUrl: null });
      expect(res.statusCode).toBe(400);
    });

    test("delete is soft; in use is 409; a deleted endpoint is hidden and can't be assigned", async () => {
      const e = await create({ apiKey: KEY });
      expect((await put("analysis", e.id)).statusCode).toBe(200);
      const busy = await admin.delete(`${API}/admin/llm/endpoints/${e.id}`);
      expect(busy.statusCode).toBe(409);
      expect(busy.json().code).toBe("llm_endpoint_in_use");
      expect(busy.json().params.roles).toBe("analysis");
      await admin.delete(`${API}/admin/llm/roles/analysis`);
      expect((await admin.delete(`${API}/admin/llm/endpoints/${e.id}`)).statusCode).toBe(200);
      const stored = await row(e.id);
      expect(stored?.deletedAt).toBeInstanceOf(Date);
      expect(stored?.apiKeyCiphertext).toBeNull();
      expect((await audits(e.id)).map((r) => r.action)).toContain("llm.endpoint.delete");
      expect((await admin.get(`${API}/admin/llm/endpoints/${e.id}`)).statusCode).toBe(404);
      const list = (await admin.get(`${API}/admin/llm/endpoints`)).json().endpoints as { id: string }[];
      expect(list.map((x) => x.id)).not.toContain(e.id);
      const assign = await put("analysis", e.id);
      expect(assign.statusCode).toBe(404);
      expect((await admin.delete(`${API}/admin/llm/endpoints/${e.id}`)).statusCode).toBe(404);
    });
  });

  describe("C21: discovery", () => {
    test("returns the mock's models", async () => {
      const m = mock({ models: ["qwen", "gemma"] });
      const e = await create({ baseUrl: m.url });
      const res = await admin.get(`${API}/admin/llm/endpoints/${e.id}/models`);
      expect(res.statusCode).toBe(200);
      expect(res.json().models.map((x: { id: string }) => x.id)).toEqual(["qwen", "gemma"]);
    });

    test("no models endpoint: 409 llm_models_unsupported", async () => {
      const m = mock({ noModels: true });
      const e = await create({ baseUrl: m.url });
      const res = await admin.get(`${API}/admin/llm/endpoints/${e.id}/models`);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("llm_models_unsupported");
    });

    test("transport and key errors keep their codes; the key is sent", async () => {
      const down = await create();
      const refused = await admin.get(`${API}/admin/llm/endpoints/${down.id}/models`);
      expect(refused.statusCode).toBe(502);
      expect(refused.json().code).toBe("llm_endpoint_unreachable");
      const m = mock({ apiKey: KEY });
      const bad = await create({ baseUrl: m.url, apiKey: "wrong" });
      expect((await admin.get(`${API}/admin/llm/endpoints/${bad.id}/models`)).json().code).toBe("llm_endpoint_auth");
      const good = await create({ baseUrl: m.url, apiKey: KEY });
      expect((await admin.get(`${API}/admin/llm/endpoints/${good.id}/models`)).statusCode).toBe(200);
    });
  });

  describe("C22: probe", () => {
    const GOOD = '{"answer": 4}';

    for (const server of ["ollama", "vllm", "llamacpp"] as const) {
      test(`chat on ${server}: latency, schema respected, reported context`, async () => {
        const m = mock({ server, contextLength: 32768, reply: () => GOOD });
        const e = await create({ baseUrl: m.url, server });
        const res = await admin.post(`${API}/admin/llm/endpoints/${e.id}/probe`, { model: "mock-model", kind: "chat" });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.reportedContext).toBe(32768);
        expect(body.modes).toHaveLength(1);
        expect(body.modes[0]).toMatchObject({ mode: "native_schema", schemaRespected: true, finishReason: "stop" });
        expect(body.modes[0].latencyMs).toBeGreaterThanOrEqual(0);
        const format = m.chatRequests()[0]?.body.response_format as { type: string };
        expect(format.type).toBe("json_schema");
      });
    }

    test("chat: native fails, prompt_only is tried and reported", async () => {
      const m = mock({ reply: (body) => (body.response_format ? "not json" : `Sure: ${GOOD}`) });
      const e = await create({ baseUrl: m.url });
      const body = (await admin.post(`${API}/admin/llm/endpoints/${e.id}/probe`, { model: "m", kind: "chat" })).json();
      expect(body.modes.map((x: { mode: string; schemaRespected: boolean }) => [x.mode, x.schemaRespected])).toEqual([
        ["native_schema", false],
        ["prompt_only", true],
      ]);
      expect(body.modes[0].errorCode).toBe("llm_output_invalid");
      expect(body.reportedContext).toBeNull();
    });

    test("chat: an unreachable endpoint is reported per mode; probes log metadata only, with kind probe", async () => {
      const e = await create();
      const body = (await admin.post(`${API}/admin/llm/endpoints/${e.id}/probe`, { model: "m", kind: "chat" })).json();
      expect(body.modes[0].errorCode).toBe("llm_endpoint_unreachable");
      const rows = await t.db.select().from(LlmCallLog).where(eq(LlmCallLog.endpointId, e.id));
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ kind: "probe", role: null, requestBody: null, responseBody: null });
    });

    for (const cap of [500, 2048, 4096, 8192, 30000]) {
      test(`embeddings: dimensions, and maxInputTokens within 5% of a cap of ${cap}, in ≤ 16 requests`, async () => {
        const m = mock({ embedCap: cap, dimensions: 768 });
        const e = await create({ baseUrl: m.url });
        const res = await admin.post(`${API}/admin/llm/endpoints/${e.id}/probe`, { model: "e", kind: "embeddings" });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.dimensions).toBe(768);
        expect(Math.abs(body.maxInputTokens - cap)).toBeLessThanOrEqual(cap * 0.05);
        expect(body.requests).toBeLessThanOrEqual(16);
        expect(m.requests.filter((r) => r.path === "/v1/embeddings")).toHaveLength(body.requests);
      });
    }

    test("embeddings: no cap at all reports the search limit", async () => {
      const m = mock({ dimensions: 8 });
      const e = await create({ baseUrl: m.url });
      const body = (
        await admin.post(`${API}/admin/llm/endpoints/${e.id}/probe`, { model: "e", kind: "embeddings" })
      ).json();
      expect(body.maxInputTokens).toBeGreaterThanOrEqual(32_768);
      expect(body.requests).toBeLessThanOrEqual(16);
    });
  });

  describe("C23: roles", () => {
    test("GET lists all six", async () => {
      const roles = (await admin.get(`${API}/admin/llm/roles`)).json().roles as { role: string }[];
      expect(roles.map((r) => r.role)).toEqual([
        "authoring.objectives",
        "authoring.generate",
        "authoring.judge",
        "verify.solve",
        "analysis",
        "embeddings",
      ]);
    });

    test("PUT validates capabilities and embedding, and audits; DELETE audits", async () => {
      const e = await create();
      const embeddingBody = { embedding: { dimensions: 768 }, capabilities: { ...capabilities, maxInputTokens: 2048 } };
      expect((await put("authoring.judge", e.id, { capabilities: { contextWindow: 1 } })).statusCode).toBe(400);
      expect((await put("embeddings", e.id)).statusCode).toBe(400);
      expect((await put("embeddings", e.id, { embedding: { dimensions: 768 } })).json().params.field).toBe(
        "capabilities.maxInputTokens",
      );
      expect((await put("authoring.judge", e.id, embeddingBody)).statusCode).toBe(400);
      expect((await admin.put(`${API}/admin/llm/roles/nope`, {})).statusCode).toBe(400);

      const ok = await put("embeddings", e.id, { ...embeddingBody, params: { keep_alive: 0 } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().role.assignment).toMatchObject({
        endpointId: e.id,
        endpointLabel: "Local",
        location: "local",
        embedding: { dimensions: 768, queryPrefix: "", documentPrefix: "" },
        params: { keep_alive: 0 },
      });
      const [assign] = await audits("embeddings");
      expect(assign?.action).toBe("llm.role.assign");
      expect(assign?.after).toMatchObject({ capabilities: { maxInputTokens: 2048 } });

      const again = await put("embeddings", e.id, { ...embeddingBody, model: "other" });
      expect(again.json().role.assignment.model).toBe("other");
      const row2 = (await audits("embeddings")).find((r) => (r.after as { model?: string } | null)?.model === "other");
      expect(row2?.before).toMatchObject({ model: "m" });

      expect((await admin.delete(`${API}/admin/llm/roles/embeddings`)).statusCode).toBe(200);
      expect((await audits("embeddings")).map((r) => r.action)).toContain("llm.role.unassign");
      const after = (await admin.get(`${API}/admin/llm/roles`)).json().roles as { role: string; assignment: unknown }[];
      expect(after.find((r) => r.role === "embeddings")?.assignment).toBeNull();
      // Deleting what isn't assigned changes nothing.
      const count = (await audits("embeddings")).length;
      expect((await admin.delete(`${API}/admin/llm/roles/embeddings`)).statusCode).toBe(200);
      expect((await audits("embeddings")).length).toBe(count);
    });

    test("a provider without embeddings can't take the embeddings role", async () => {
      const e = await create({ provider: "anthropic", baseUrl: undefined, location: "cloud" });
      const res = await put("embeddings", e.id, {
        embedding: { dimensions: 8 },
        capabilities: { ...capabilities, maxInputTokens: 10 },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("C24: local endpoints only", () => {
    test("assigning cloud while on, turning on with a cloud role, and the audit", async () => {
      const cloud = await create({ label: "Cloud X", location: "cloud" });
      const local = await create();
      expect((await put("analysis", cloud.id)).statusCode).toBe(200);
      expect((await put("verify.solve", cloud.id)).statusCode).toBe(200);

      const on = () => admin.put(`${API}/admin/settings`, { selfRegistration: true, localEndpointsOnly: true });
      const refused = await on();
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toEqual({
        code: "llm_cloud_roles_assigned",
        params: { roles: "analysis, verify.solve" },
      });

      await admin.delete(`${API}/admin/llm/roles/analysis`);
      await admin.delete(`${API}/admin/llm/roles/verify.solve`);
      expect((await on()).statusCode).toBe(200);
      const [audit] = await t.db
        .select()
        .from(AuditLog)
        .where(eq(AuditLog.action, "settings.update"))
        .orderBy(desc(AuditLog.at))
        .limit(1);
      expect(audit?.before).toMatchObject({ localEndpointsOnly: false });
      expect(audit?.after).toMatchObject({ localEndpointsOnly: true });

      const blocked = await put("analysis", cloud.id);
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().code).toBe("llm_cloud_blocked");
      expect((await put("analysis", local.id)).statusCode).toBe(200);
      // Moving an assigned endpoint to cloud would get around the setting.
      const moved = await admin.patch(`${API}/admin/llm/endpoints/${local.id}`, { location: "cloud" });
      expect(moved.statusCode).toBe(409);
      expect(moved.json().code).toBe("llm_cloud_blocked");

      await admin.delete(`${API}/admin/llm/roles/analysis`);
      await admin.put(`${API}/admin/settings`, { selfRegistration: true, localEndpointsOnly: false });
      expect((await put("analysis", cloud.id)).statusCode).toBe(200);
    });
  });

  test("C25: a student sees assigned state and a cloud endpoint's label only", async () => {
    await t.db.delete(RoleAssignment).where(inArray(RoleAssignment.role, ["analysis", "authoring.generate"]));
    const cloud = await create({ label: "Cloud Y", location: "cloud", baseUrl: "http://secret-host.example/v1" });
    const local = await create({ label: "Quiet Box", baseUrl: "http://other-host.example/v1" });
    await put("analysis", cloud.id, { model: "secret-model" });
    await put("authoring.generate", local.id, { model: "secret-model" });
    const res = await student.get(`${API}/llm/roles`);
    expect(res.statusCode).toBe(200);
    const roles = res.json().roles as { role: string }[];
    expect(roles).toHaveLength(6);
    expect(roles.find((r) => r.role === "analysis")).toEqual({
      role: "analysis",
      assigned: true,
      location: "cloud",
      endpointLabel: "Cloud Y",
    } as never);
    expect(roles.find((r) => r.role === "authoring.generate")).toEqual({
      role: "authoring.generate",
      assigned: true,
      location: "local",
    } as never);
    expect(roles.find((r) => r.role === "embeddings")).toEqual({ role: "embeddings", assigned: false } as never);
    for (const hidden of ["secret-host", "other-host", "secret-model", "Quiet Box", cloud.id, local.id]) {
      expect(res.body).not.toContain(hidden);
    }
  });

  test("stats: per role × endpoint × model, failures by code, repair and salvage rates, tokens", async () => {
    const e = await create();
    const base = {
      endpointId: e.id,
      model: "stat-model",
      role: "analysis",
      kind: "call" as const,
      mode: "native_schema",
      normalizationFixes: [],
      usage: { inputTokens: 100, outputTokens: 10 },
    };
    await t.db.insert(LlmCallLog).values([
      { ...base, id: crypto.randomUUID(), outcome: "ok", latencyMs: 100, queuedMs: 0 },
      { ...base, id: crypto.randomUUID(), outcome: "ok", latencyMs: 300, queuedMs: 10, repairAttempts: 1 },
      { ...base, id: crypto.randomUUID(), outcome: "salvaged", latencyMs: 500, queuedMs: 20, repairAttempts: 2 },
      {
        ...base,
        id: crypto.randomUUID(),
        outcome: "failed",
        errorCode: "llm_output_invalid",
        latencyMs: 700,
        queuedMs: 0,
      },
      { ...base, id: crypto.randomUUID(), kind: "probe", outcome: "ok", latencyMs: 9999 },
    ]);
    const rows = (await admin.get(`${API}/admin/llm/stats`)).json().rows as Record<string, unknown>[];
    const row3 = rows.find((r) => r.model === "stat-model");
    expect(row3).toMatchObject({
      role: "analysis",
      endpointId: e.id,
      calls: 4,
      failures: { llm_output_invalid: 1 },
      repairRate: 0.5,
      salvageRate: 0.25,
      latencyP50Ms: 400,
      tokensIn: 400,
      tokensOut: 40,
    });
    expect(row3?.latencyP95Ms).toBeGreaterThan(600);
    const future = new Date(Date.now() + 60_000).toISOString();
    const none = await admin.get(`${API}/admin/llm/stats?since=${encodeURIComponent(future)}`);
    expect(none.json().rows).toEqual([]);
  });

  test("startup check: an endpoint whose key can't be read is listed", async () => {
    const e = await create({ apiKey: KEY });
    expect(await t.ctx.llm.unreadableEndpoints()).toEqual([]);
    await t.db.update(Endpoint).set({ apiKeyCiphertext: "AAAA" }).where(eq(Endpoint.id, e.id));
    expect(await t.ctx.llm.unreadableEndpoints()).toEqual([e.id]);
    await admin.patch(`${API}/admin/llm/endpoints/${e.id}`, { apiKey: null });
  });
});

describe.skipIf(!hasDb)("C26: rate limits", () => {
  test("probe and discovery answer 429, per admin", async () => {
    const t = await createTestApp({ env: { LLM_RATE_LIMIT_MAX: "2" } });
    const m = new MockLlmServer();
    try {
      const { client, user } = await registerUser(t.app, "admin@example.com");
      const e = (
        await client.post(`${API}/admin/llm/endpoints`, { label: "L", baseUrl: m.url, location: "local" })
      ).json().endpoint;
      const models = `${API}/admin/llm/endpoints/${e.id}/models`;
      const probe = `${API}/admin/llm/endpoints/${e.id}/probe`;
      for (const send of [() => client.get(models), () => client.post(probe, { model: "m", kind: "chat" })]) {
        expect((await send()).statusCode).toBe(200);
        expect((await send()).statusCode).toBe(200);
        const limited = await send();
        expect(limited.statusCode).toBe(429);
        expect(limited.json().code).toBe("rate_limited");
      }
      // Per admin: a second admin has their own budget.
      const second = await registerUser(t.app, "second@example.com");
      await client.put(`${API}/admin/users/${second.user.id}/roles`, { role: "admin" });
      const { client: other } = await signIn(t.app, "second@example.com");
      expect((await other.get(models)).statusCode).toBe(200);
      expect(user.role).toBe("admin");
    } finally {
      m.stop();
      await t.close();
    }
  });
});

describe.skipIf(!hasDb)("C27: llm:seed", () => {
  const dev = (database: TestApp["database"], env: Record<string, string> = {}): Config =>
    testConfig(database, {
      ENDPOINT_SECRET_KEY: SECRET,
      LLM_DEV_LABEL: "Dev",
      LLM_DEV_BASE_URL: "http://10.0.0.20:11434/v1",
      LLM_DEV_MODEL: "qwen",
      LLM_DEV_API_KEY: "dev-key",
      LLM_DEV_SERVER: "llama.cpp",
      LLM_DEV_CONTEXT: "32768",
      LLM_DEV_ROLES: "authoring.generate,analysis",
      LLM_DEV_PARAMS: '{"temperature":0.7,"reasoning_effort":"none"}',
      ...env,
    });
  const EMBED = {
    LLM_DEV_EMBED_BASE_URL: "http://10.0.0.21:11434/v1",
    LLM_DEV_EMBED_MODEL: "gemma",
    LLM_DEV_EMBED_DIM: "768",
    LLM_DEV_EMBED_MAX_INPUT_TOKENS: "4096",
    LLM_DEV_EMBED_QUERY_PREFIX: "q: ",
    LLM_DEV_EMBED_DOCUMENT_PREFIX: "d: ",
  };

  test("creates endpoints and assignments once; a second run changes nothing; nothing is overwritten", async () => {
    const t = await createTestApp();
    try {
      const config = dev(t.database, EMBED);
      await seedDevLlm({ config, db: t.db });
      const endpoints = await t.db.select().from(Endpoint);
      expect(endpoints.map((e) => e.label).sort()).toEqual(["Dev", "Dev embeddings"]);
      expect(endpoints.find((e) => e.label === "Dev")).toMatchObject({ server: "llamacpp", location: "local" });
      const dec = endpoints.find((e) => e.label === "Dev");
      expect(decryptSecret(dec?.apiKeyCiphertext as string, SECRET, dec?.id as string)).toBe("dev-key");
      const roles = await t.db.select().from(RoleAssignment);
      expect(roles.map((r) => r.role).sort()).toEqual(["analysis", "authoring.generate", "embeddings"]);
      expect(roles.find((r) => r.role === "analysis")).toMatchObject({
        model: "qwen",
        params: { temperature: 0.7, reasoning_effort: "none" },
        capabilities: { contextWindow: 32768, structuredOutput: "native_schema" },
      });
      expect(roles.find((r) => r.role === "embeddings")).toMatchObject({
        endpointId: endpoints.find((e) => e.label === "Dev embeddings")?.id as string,
        capabilities: { maxInputTokens: 4096 },
        embedding: { dimensions: 768, queryPrefix: "q: ", documentPrefix: "d: " },
      });
      const audit = await t.db.select().from(AuditLog);
      expect(audit.every((a) => a.actorId === null)).toBe(true);
      expect(audit.map((a) => a.action)).toContain("llm.role.assign");
      expect(JSON.stringify(audit)).not.toContain("dev-key");

      await seedDevLlm({ config, db: t.db });
      expect(await t.db.select().from(Endpoint)).toHaveLength(2);
      expect((await t.db.select().from(AuditLog)).length).toBe(audit.length);

      await t.db.update(RoleAssignment).set({ model: "chosen" }).where(eq(RoleAssignment.role, "analysis"));
      await seedDevLlm({ config, db: t.db });
      const [kept] = await t.db.select().from(RoleAssignment).where(eq(RoleAssignment.role, "analysis"));
      expect(kept?.model).toBe("chosen");
    } finally {
      await t.close();
    }
  });

  test("no embedding URL: the same endpoint; nothing configured: nothing happens", async () => {
    const t = await createTestApp();
    try {
      const { LLM_DEV_EMBED_BASE_URL: _u, ...sameUrl } = EMBED;
      await seedDevLlm({ config: dev(t.database, sameUrl), db: t.db });
      expect(await t.db.select().from(Endpoint)).toHaveLength(1);
      expect(await t.db.select().from(RoleAssignment)).toHaveLength(3);
      const other = await createTestApp();
      try {
        await seedDevLlm({ config: testConfig(other.database), db: other.db });
        expect(await other.db.select().from(Endpoint)).toHaveLength(0);
      } finally {
        await other.close();
      }
    } finally {
      await t.close();
    }
  });

  test("LLM_DEV_PARAMS must be a JSON object", () => {
    const base = {
      DATABASE_URL: "postgres://a:b@c/d",
      DATABASE_URL_OWNER: "postgres://a:b@c/d",
      SESSION_SECRET: Buffer.alloc(32, 7).toString("base64"),
    };
    expect(() => loadConfig({ ...base, LLM_DEV_PARAMS: "[1]" })).toThrow("LLM_DEV_PARAMS");
    expect(() => loadConfig({ ...base, LLM_DEV_PARAMS: '{"a":1}' })).not.toThrow();
  });
});
