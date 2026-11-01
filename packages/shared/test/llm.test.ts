import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import * as contracts from "../src/contracts/index.ts";
import { CONTRACTS } from "../src/contracts/index.ts";
import {
  GeneratedQuestionStrict7 as GeneratedQuestion,
  GenerationBatchStrict7 as GenerationBatch,
  GenerationBatch as GenerationBatchStrict8,
} from "../src/generation.ts";
import { jsonSchemaOf } from "../src/json-schema.ts";
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
    const atWindow = { ...capabilities, maxOutputTokens: capabilities.contextWindow };
    expect(Capabilities.safeParse(atWindow).success).toBe(false);
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

describe("C28: the strict7 schema", () => {
  /** What differs in form only: Zod's `type` next to `const`, `items` on an empty array, `$schema`, key order of `required`. */
  function canon(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(canon);
    if (typeof node !== "object" || node === null) return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$schema") continue;
      out[k] = k === "required" ? [...(v as string[])].sort() : canon(v);
    }
    if ("const" in out) delete out.type;
    if (out.enum) delete out.type;
    if (out.maxItems === 0) delete out.items;
    return out;
  }

  /** Paths where two values differ, property order included (it's part of the contract on llama.cpp). */
  function diff(a: unknown, b: unknown, path = "$"): string[] {
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return [`${path}: length ${a.length} vs ${b.length}`];
      return a.flatMap((x, i) => diff(x, b[i], `${path}[${i}]`));
    }
    if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
      const [ka, kb] = [Object.keys(a), Object.keys(b)];
      const all = [...new Set([...ka, ...kb])];
      return all.flatMap((k) =>
        diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`),
      );
    }
    return a === b ? [] : [`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`];
  }

  test("matches the probe's SCHEMAS['strict7']", async () => {
    const probe = await Bun.file(join(import.meta.dir, "fixtures", "strict7.json")).json();
    const differences = diff(canon(jsonSchemaOf(GenerationBatch)), canon(probe));
    expect(differences).toEqual([]);
  });

  test("property order is the probe's", async () => {
    const probe = await Bun.file(join(import.meta.dir, "fixtures", "strict7.json")).json();
    const keys = (s: { properties: { questions: { items: { anyOf: { properties: object }[] } } } }) =>
      s.properties.questions.items.anyOf.map((b) => Object.keys(b.properties));
    expect(keys(jsonSchemaOf(GenerationBatch) as never)).toEqual(keys(probe));
  });

  test("a computable question can't carry options, and a concept question can't carry inputs", () => {
    const base = {
      tempId: "q1",
      topic: "t",
      evidence: [{ chunkId: "c", quote: "q" }],
      question: "What is {x}?",
      explanation: "e",
    };
    const input = { name: "x", kind: "integer", size: [], from: "sample", sourceText: "" };
    const numeric = {
      ...base,
      type: "numeric",
      computable: true,
      inputs: [input],
      constraint: "",
      answerProgram: "result = x",
      options: [],
      mistakes: [],
    };
    expect(GeneratedQuestion.safeParse(numeric).success).toBe(true);
    expect(GeneratedQuestion.safeParse({ ...numeric, options: ["1"] }).success).toBe(false);
    const option = { whyWrong: "", text: "a", isCorrect: true };
    const concept = {
      ...base,
      type: "single_choice",
      computable: false,
      inputs: [],
      constraint: "",
      answerProgram: "",
      options: [option, option, option],
      mistakes: [],
    };
    expect(GeneratedQuestion.safeParse(concept).success).toBe(true);
    expect(GeneratedQuestion.safeParse({ ...concept, inputs: [input] }).success).toBe(false);
    expect(GeneratedQuestion.safeParse({ ...concept, answerProgram: "x" }).success).toBe(false);
  });
});

describe("P2: the strict8 schema", () => {
  const branches = (s: unknown) =>
    (s as { properties: { questions: { items: { anyOf: { properties: Record<string, unknown> }[] } } } }).properties
      .questions.items.anyOf;

  test("it's strict7 with objectiveIds after tempId, then the other types' branches", () => {
    const strict7 = branches(jsonSchemaOf(GenerationBatch));
    const strict8 = branches(jsonSchemaOf(GenerationBatchStrict8));
    expect(strict7).toHaveLength(4);
    expect(strict8).toHaveLength(8);
    for (const [i, before] of strict7.entries()) {
      const { objectiveIds, ...rest } = (strict8[i] as { properties: Record<string, unknown> }).properties;
      expect(objectiveIds).toBeDefined();
      expect(rest).toEqual(before.properties);
      expect(Object.keys((strict8[i] as { properties: object }).properties).slice(0, 2)).toEqual([
        "tempId",
        "objectiveIds",
      ]);
    }
  });
});
