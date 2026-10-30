import { describe, expect, test } from "bun:test";
import { z } from "zod";
import * as contracts from "../src/contracts/index.ts";
import { CONTRACTS } from "../src/contracts/index.ts";
import {
  Capabilities,
  EmbeddingConfig,
  EndpointBaseUrl,
  EndpointCreate,
  EndpointPatch,
  MODEL_ROLES,
  ModelRole,
  RoleAssignment,
} from "../src/llm.ts";

const capabilities = { structuredOutput: "native_schema", contextWindow: 32768, maxOutputTokens: 4096 };
const endpointId = "01890000-0000-7000-8000-000000000000";

/** Every property name anywhere in a JSON Schema. */
function propertyNames(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const v of node) propertyNames(v, out);
  } else if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (o.properties && typeof o.properties === "object") {
      for (const k of Object.keys(o.properties)) out.add(k);
    }
    for (const v of Object.values(o)) propertyNames(v, out);
  }
  return out;
}

describe("C4: LLM shapes (SPEC §3B.2)", () => {
  test("ModelRole is the six roles", () => {
    expect(ModelRole.options).toEqual([...MODEL_ROLES]);
    expect(MODEL_ROLES).toHaveLength(6);
  });

  test("capabilities and embedding parse with SPEC's defaults", () => {
    expect(Capabilities.parse(capabilities)).toEqual(capabilities as never);
    expect(EmbeddingConfig.parse({ dimensions: 768 })).toEqual({
      dimensions: 768,
      queryPrefix: "",
      documentPrefix: "",
    });
  });

  test("EndpointCreate applies concurrency 1, timeout 300 s, and requires baseUrl for openai-compatible", () => {
    const parsed = EndpointCreate.parse({ label: "L", baseUrl: "http://10.0.0.20:8000/v1", location: "local" });
    expect(parsed).toMatchObject({ provider: "openai-compatible", concurrency: 1, timeoutMs: 300_000 });
    expect(EndpointCreate.safeParse({ label: "L", location: "local" }).success).toBe(false);
    expect(EndpointCreate.safeParse({ label: "L", provider: "anthropic", location: "cloud" }).success).toBe(true);
  });

  test("baseUrl: http(s) only, no credentials", () => {
    expect(EndpointBaseUrl.safeParse("https://example.com/v1").success).toBe(true);
    expect(EndpointBaseUrl.safeParse("ftp://example.com/v1").success).toBe(false);
    expect(EndpointBaseUrl.safeParse("file:///etc/passwd").success).toBe(false);
    expect(EndpointBaseUrl.safeParse("http://user:pw@example.com/v1").success).toBe(false);
  });

  test("EndpointPatch: apiKey string sets, null clears, absent keeps; an empty patch is refused", () => {
    expect(EndpointPatch.parse({ apiKey: "k" }).apiKey).toBe("k");
    expect(EndpointPatch.parse({ apiKey: null }).apiKey).toBeNull();
    expect("apiKey" in EndpointPatch.parse({ label: "L" })).toBe(false);
    expect(EndpointPatch.safeParse({}).success).toBe(false);
  });

  test("embedding is required for the embeddings role and rejected for the others", () => {
    const embeddingRole = {
      role: "embeddings",
      endpointId,
      model: "m",
      capabilities: { ...capabilities, maxInputTokens: 2048 },
    };
    expect(RoleAssignment.safeParse(embeddingRole).success).toBe(false);
    expect(RoleAssignment.safeParse({ ...embeddingRole, embedding: { dimensions: 768 } }).success).toBe(true);
    expect(RoleAssignment.safeParse({ ...embeddingRole, capabilities, embedding: { dimensions: 768 } }).success).toBe(
      false,
    );
    const analysis = { role: "analysis", endpointId, model: "m", capabilities };
    expect(RoleAssignment.safeParse(analysis).success).toBe(true);
    expect(RoleAssignment.safeParse({ ...analysis, embedding: { dimensions: 768 } }).success).toBe(false);
  });

  test("no LLM response contract includes a key or the ciphertext", () => {
    const llm = CONTRACTS.filter((c) => c.id.startsWith("admin.llm.") || c.id === "llm.roles");
    expect(llm).toHaveLength(15);
    for (const c of llm) {
      const names = [...propertyNames(z.toJSONSchema(c.response, { io: "output", unrepresentable: "any" }))];
      expect(names.filter((n) => /api_?key|ciphertext|secret/i.test(n))).toEqual([]);
    }
    // The walk does see nested properties.
    const list = z.toJSONSchema(contracts.adminLlmEndpointsList.response, { io: "output" });
    expect(propertyNames(list).has("hasKey")).toBe(true);
  });
});

describe("C5: every §6 route has a contract", () => {
  test("paths and methods", () => {
    const routes = CONTRACTS.map((c) => `${c.method} ${c.path}`);
    for (const r of [
      "GET /admin/llm/endpoints",
      "POST /admin/llm/endpoints",
      "GET /admin/llm/endpoints/:id",
      "PATCH /admin/llm/endpoints/:id",
      "DELETE /admin/llm/endpoints/:id",
      "GET /admin/llm/endpoints/:id/models",
      "POST /admin/llm/endpoints/:id/probe",
      "GET /admin/llm/roles",
      "PUT /admin/llm/roles/:role",
      "DELETE /admin/llm/roles/:role",
      "GET /admin/llm/stats",
      "POST /admin/llm/evals/run",
      "GET /admin/llm/evals",
      "GET /admin/llm/evals/:id",
      "GET /llm/roles",
    ]) {
      expect(routes).toContain(r);
    }
  });
});
