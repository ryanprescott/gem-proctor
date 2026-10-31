import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Endpoint, LlmCallLog } from "@gem/db";
import type { ModelRole } from "@gem/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { MockLlmServer } from "../mock/server.ts";
import { LlmError, type LlmResult, type Runtime } from "../src/index.ts";
import { assign, createEnv, hasDb, lastLog, setLocalOnly, type TestEnv } from "./helpers.ts";

const Answer = z.object({ title: z.string().describe("The title"), count: z.number(), done: z.boolean() });
const GOOD = '{"title": "t", "count": 3, "done": true}';
const BAD = '{"title": "t"}';
const input = { promptId: "greet", vars: { tone: "dry", name: "Ada" } };
const ROLE: ModelRole = "authoring.generate";

/** Calls waiting in an endpoint's queue; only tests need to know. */
function waitingCalls(runtime: Runtime, endpointId: string): number {
  const { queues } = runtime as unknown as { queues: { for(id: string, concurrency: number): unknown } };
  const queue = queues.for(endpointId, 1) as { waiting: Map<string, unknown[]> };
  return [...queue.waiting.values()].reduce((n, list) => n + list.length, 0);
}

async function failure(p: Promise<unknown>): Promise<LlmError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(LlmError);
    return e as LlmError;
  }
  throw new Error("expected a failure");
}

const messagesOf = (body: Record<string, unknown>) => body.messages as { role: string; content: string }[];
const systemOf = (body: Record<string, unknown>) => messagesOf(body).find((m) => m.role === "system")?.content ?? "";

describe.skipIf(!hasDb)("runtime, against the mock server", () => {
  let env: TestEnv;
  let rt: Runtime;
  let mock: MockLlmServer;

  beforeAll(async () => {
    env = await createEnv();
    rt = env.runtime;
    mock = new MockLlmServer();
  });
  afterAll(async () => {
    mock?.stop();
    await env?.close();
  });

  const fresh = (o: object = {}, role: ModelRole = ROLE) => {
    mock.requests.length = 0;
    mock.replies.length = 0;
    return assign(env.db, role, { url: mock.url, ...o });
  };

  describe("C7: native_schema", () => {
    test("sends the JSON Schema as response_format, in schema order, and returns every LlmResult field", async () => {
      const endpointId = await fresh();
      mock.replies.push(GOOD);
      const r = await rt.generateObject(ROLE, Answer, input);
      const body = mock.chatRequests()[0]?.body as Record<string, unknown>;
      const format = body.response_format as { type: string; json_schema: { schema: { properties: object } } };
      expect(format.type).toBe("json_schema");
      expect(Object.keys(format.json_schema.schema.properties)).toEqual(["title", "count", "done"]);
      expect(JSON.stringify(format)).toContain("The title");
      expect(systemOf(body)).toBe("You greet people in the dry style.");
      expect(messagesOf(body).at(-1)).toMatchObject({ role: "user" });
      expect(r.value).toEqual({ title: "t", count: 3, done: true });
      expect(r).toMatchObject({
        endpointId,
        model: "mock-model",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 20 },
        repairAttempts: 0,
        promptVersion: "greet-v1",
        mode: "native_schema",
        normalizationFixes: [],
      });
      for (const k of ["latencyMs", "queuedMs"] as const) expect(r[k]).toBeGreaterThanOrEqual(0);
      expect(r.callLogId).toBeString();
    });

    test("`messages` follow the template's", async () => {
      await fresh();
      mock.replies.push(GOOD);
      await rt.generateObject(ROLE, Answer, { ...input, messages: [{ role: "user", content: "And Bob." }] });
      const ms = messagesOf(mock.chatRequests()[0]?.body as Record<string, unknown>);
      expect(ms.map((m) => m.role)).toEqual(["system", "user", "user"]);
      expect(ms.at(-1)?.content).toBe("And Bob.");
    });
  });

  describe("C8: prompt_only", () => {
    test("the schema and example are in the system message, with no response_format", async () => {
      await fresh({ capabilities: { structuredOutput: "prompt_only" } });
      mock.replies.push(GOOD);
      const r = await rt.generateObject(ROLE, Answer, input);
      const body = mock.chatRequests()[0]?.body as Record<string, unknown>;
      expect(body.response_format).toBeUndefined();
      expect(systemOf(body)).toContain("You greet people");
      expect(systemOf(body)).toContain("JSON Schema");
      expect(systemOf(body)).toContain('"count": 0');
      expect(r.mode).toBe("prompt_only");
    });

    test("an example passed in is used", async () => {
      await fresh({ capabilities: { structuredOutput: "prompt_only" } });
      mock.replies.push(GOOD);
      await rt.generateObject(ROLE, Answer, input, { example: { title: "my example", count: 1, done: false } });
      expect(systemOf(mock.chatRequests()[0]?.body as Record<string, unknown>)).toContain("my example");
    });

    test("prose, a fence and a <think> block are extracted, recorded, and aren't repairs", async () => {
      await fresh({ capabilities: { structuredOutput: "prompt_only" } });
      mock.replies.push(`<think>let me see</think>Here you go:\n\`\`\`json\n${GOOD}\n\`\`\`\nDone.`);
      const r = await rt.generateObject(ROLE, Answer, input);
      expect(r.repairAttempts).toBe(0);
      expect(r.normalizationFixes.map((f) => f.code)).toEqual(["think_stripped", "extracted_json"]);
      expect((await lastLog(env.db))?.normalizationFixes).toEqual(r.normalizationFixes);
    });
  });

  describe("C9: repair loop", () => {
    test("valid on the 1st repair; the request has the Zod issues and the invalid output", async () => {
      await fresh();
      mock.replies.push(BAD, GOOD);
      const r = await rt.generateObject(ROLE, Answer, input);
      expect(r.repairAttempts).toBe(1);
      const repair = mock.chatRequests()[1]?.body as Record<string, unknown>;
      const text = JSON.stringify(messagesOf(repair));
      expect(text).toContain("count");
      expect(text).toContain("expected number");
      expect(messagesOf(repair).at(-1)?.content).toContain(BAD);
      expect(messagesOf(repair).at(-1)?.content).toContain('"properties"');
      expect(repair.response_format).toBeDefined();
    });

    test("valid on the 2nd repair", async () => {
      await fresh();
      mock.replies.push("not json at all", BAD, GOOD);
      expect((await rt.generateObject(ROLE, Answer, input)).repairAttempts).toBe(2);
    });

    test("still invalid after maxRepairs: llm_output_invalid", async () => {
      await fresh();
      mock.replies.push(BAD, BAD, BAD);
      const e = await failure(rt.generateObject(ROLE, Answer, input));
      expect(e.code).toBe("llm_output_invalid");
      expect(mock.chatRequests()).toHaveLength(3);
      const log = await lastLog(env.db);
      expect(log).toMatchObject({ outcome: "failed", errorCode: "llm_output_invalid", repairAttempts: 2 });
    });

    test("maxRepairs is a per-call option", async () => {
      await fresh();
      mock.replies.push(BAD, GOOD);
      expect((await failure(rt.generateObject(ROLE, Answer, input, { maxRepairs: 0 }))).code).toBe(
        "llm_output_invalid",
      );
      expect(mock.chatRequests()).toHaveLength(1);
    });

    test.each([
      ["an empty reply cut off by the budget", { text: "", finishReason: "length" }],
      ["partial JSON cut off by the budget", { text: '{"title":"a","cou', finishReason: "length" }],
      ["an empty reply that finished normally", { text: "   " }],
    ])("%s: llm_output_incomplete, not repaired", async (_name, reply) => {
      await fresh();
      mock.replies.push(reply, GOOD);
      const e = await failure(rt.generateObject(ROLE, Answer, input));
      expect(e.code).toBe("llm_output_incomplete");
      expect(mock.chatRequests()).toHaveLength(1);
      const log = await lastLog(env.db);
      expect(log).toMatchObject({ outcome: "failed", errorCode: "llm_output_incomplete", repairAttempts: 0 });
    });

    test("a repair that is cut off isn't repaired again", async () => {
      await fresh();
      mock.replies.push(BAD, { text: "", finishReason: "length" }, GOOD);
      const e = await failure(rt.generateObject(ROLE, Answer, input));
      expect(e.code).toBe("llm_output_incomplete");
      expect(mock.chatRequests()).toHaveLength(2);
    });
  });

  describe("C10: salvage", () => {
    const Q = z.object({ text: z.string() });
    const Batch = z.object({ questions: z.array(Q).length(4) });
    const batch = (items: unknown[]) => JSON.stringify({ questions: items });
    const mixed = batch([{ text: "a" }, { text: "b" }, { text: "c" }, { bad: 1 }]);

    test("3 valid + 1 invalid: 3 values and 1 failedItems entry", async () => {
      await fresh();
      mock.replies.push(mixed, mixed, mixed);
      const r = await rt.generateObject(ROLE, Batch, input, { salvage: { path: "questions" } });
      expect(r.value.questions).toHaveLength(3);
      expect(r.failedItems).toHaveLength(1);
      expect(r.failedItems?.[0]?.index).toBe(3);
      expect((await lastLog(env.db))?.outcome).toBe("salvaged");
    });

    test("all invalid: llm_output_invalid", async () => {
      await fresh();
      const none = batch([{ bad: 1 }]);
      mock.replies.push(none, none, none);
      const e = await failure(rt.generateObject(ROLE, Batch, input, { salvage: { path: "questions" } }));
      expect(e.code).toBe("llm_output_invalid");
    });

    test("not opted in: no salvage", async () => {
      await fresh();
      mock.replies.push(mixed, mixed, mixed);
      expect((await failure(rt.generateObject(ROLE, Batch, input))).code).toBe("llm_output_invalid");
    });
  });

  describe("C11: streamObject", () => {
    test("yields partial objects in order; final is validated", async () => {
      await fresh();
      mock.replies.push({ text: GOOD, chunks: ['{"title": "t"', ', "count": 3', ', "done": true}'] });
      const stream = rt.streamObject(ROLE, Answer, input);
      const seen: unknown[] = [];
      for await (const p of stream) seen.push(p);
      expect(seen).toEqual([{ title: "t" }, { title: "t", count: 3 }, { title: "t", count: 3, done: true }]);
      const final = await stream.final;
      expect(final.value).toEqual({ title: "t", count: 3, done: true });
      expect(final.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
      expect(final.finishReason).toBe("stop");
      expect(mock.chatRequests()[0]?.body.stream).toBe(true);
    });

    test("invalid output: final goes through a non-streamed repair", async () => {
      await fresh();
      mock.replies.push({ text: BAD, chunks: [BAD] }, GOOD);
      const stream = rt.streamObject(ROLE, Answer, input);
      const final = await stream.final;
      expect(final.repairAttempts).toBe(1);
      expect(final.value.count).toBe(3);
      expect(mock.chatRequests()[1]?.body.stream).toBeUndefined();
    });

    test("a <think> block isn't yielded; final fails like generateObject", async () => {
      await fresh();
      mock.replies.push({ text: "", chunks: ['<think>{"x":1}', "</think>nope"] }, "nope", "nope");
      const stream = rt.streamObject(ROLE, Answer, input);
      const seen: unknown[] = [];
      for await (const p of stream) seen.push(p);
      expect(seen).toEqual([]);
      expect((await failure(stream.final)).code).toBe("llm_output_invalid");
    });

    test("a server error reaches final as an LlmError", async () => {
      await fresh();
      mock.replies.push({ status: 500 });
      const stream = rt.streamObject(ROLE, Answer, input);
      expect((await failure(stream.final)).code).toBe("llm_endpoint_error");
    });
  });

  test("C12: params reach the request body unchanged", async () => {
    const params = {
      temperature: 0.7,
      top_p: 0.8,
      top_k: 20,
      presence_penalty: 0,
      reasoning_effort: "none",
      custom: { nested: [1, 2] },
    };
    await fresh({ params });
    mock.replies.push(GOOD);
    await rt.generateObject(ROLE, Answer, input);
    expect(mock.chatRequests()[0]?.body).toMatchObject(params);
    expect(mock.chatRequests()[0]?.body.max_tokens).toBe(1024);
  });

  describe("C13: queue, against the server", () => {
    test("concurrency 1: one in flight; two callers alternate", async () => {
      await fresh({ concurrency: 1 });
      const order: string[] = [];
      const { promise: released, resolve: release } = Promise.withResolvers<void>();
      const server = new MockLlmServer({
        reply: (body) => {
          const content = messagesOf(body).at(-1)?.content as string;
          order.push(content);
          return content === "blocker" ? { text: GOOD, holdUntil: released } : { text: GOOD, delayMs: 5 };
        },
      });
      try {
        const endpointId = await assign(env.db, ROLE, { url: server.url, concurrency: 1, timeoutMs: 30_000 });
        const call = (content: string, userId?: string) =>
          rt.generateObject(ROLE, Answer, { ...input, messages: [{ role: "user", content }] }, { userId });
        // Each call reads the database before it queues. The blocker holds the slot until all six are waiting,
        // so what's measured is the queue's order, not their arrival.
        const blocker = call("blocker");
        while (order.length === 0) await Bun.sleep(1);
        const users = { a: "01890000-0000-7000-8000-00000000000a", b: "01890000-0000-7000-8000-00000000000b" };
        const calls = (["a", "b"] as const).flatMap((w) => [1, 2, 3].map((n) => call(`${w}${n}`, users[w])));
        while (waitingCalls(rt, endpointId) < calls.length) await Bun.sleep(1);
        release();
        await blocker;
        const results = await Promise.all(calls);
        // Which caller goes first depends on arrival; after that they take turns.
        const callers = order.slice(1).map((c) => c[0] as string);
        const first = callers[0] as string;
        const second = first === "a" ? "b" : "a";
        expect(callers).toEqual([first, second, first, second, first, second]);
        expect(server.maxInFlight).toBe(1);
        expect(Math.max(...results.map((r) => r.queuedMs))).toBeGreaterThan(0);
        const logged = await env.db
          .select()
          .from(LlmCallLog)
          .where(eq(LlmCallLog.id, results.at(-1)?.callLogId as string));
        expect(logged[0]?.queuedMs).toBe(results.at(-1)?.queuedMs as number);
      } finally {
        release();
        server.stop();
      }
    }, 30_000);

    test("concurrency 2 allows two", async () => {
      const server = new MockLlmServer({ reply: () => ({ text: GOOD, delayMs: 20 }) });
      try {
        await assign(env.db, ROLE, { url: server.url, concurrency: 2 });
        await Promise.all([1, 2, 3, 4].map(() => rt.generateObject(ROLE, Answer, input)));
        expect(server.maxInFlight).toBe(2);
      } finally {
        server.stop();
      }
    });

    test("an aborted queued call never reaches the server", async () => {
      const server = new MockLlmServer({ reply: () => ({ text: GOOD, delayMs: 30 }) });
      try {
        await assign(env.db, ROLE, { url: server.url, concurrency: 1 });
        const first = rt.generateObject(ROLE, Answer, input);
        await Bun.sleep(10);
        const abort = new AbortController();
        const second = rt.generateObject(ROLE, Answer, input, { signal: abort.signal });
        await Bun.sleep(5);
        abort.abort(new DOMException("stopped", "AbortError"));
        await expect(second).rejects.toThrow("stopped");
        await first;
        expect(server.chatRequests()).toHaveLength(1);
        expect((await lastLog(env.db))?.outcome).toBeDefined();
      } finally {
        server.stop();
      }
    });
  });

  describe("C14: every error is an LlmError from its scenario", () => {
    test("connection refused: llm_endpoint_unreachable", async () => {
      await fresh({ url: "http://127.0.0.1:9/v1" });
      expect((await failure(rt.generateObject(ROLE, Answer, input))).code).toBe("llm_endpoint_unreachable");
    });

    test("401: llm_endpoint_auth", async () => {
      await fresh();
      mock.replies.push({ status: 401 });
      expect((await failure(rt.generateObject(ROLE, Answer, input))).code).toBe("llm_endpoint_auth");
    });

    test("slow reply: llm_endpoint_timeout", async () => {
      await fresh({ timeoutMs: 20 });
      mock.replies.push({ text: GOOD, delayMs: 200 });
      const e = await failure(rt.generateObject(ROLE, Answer, input));
      expect(e.code).toBe("llm_endpoint_timeout");
      expect((await lastLog(env.db))?.errorCode).toBe("llm_endpoint_timeout");
    });

    test("500: llm_endpoint_error, with the status", async () => {
      await fresh();
      mock.replies.push({ status: 500 });
      const e = await failure(rt.generateObject(ROLE, Answer, input));
      expect(e.code).toBe("llm_endpoint_error");
      expect(e.params.status).toBe(500);
    });

    test("oversized prompt: llm_context_exceeded, before sending", async () => {
      await fresh({ capabilities: { contextWindow: 1100, maxOutputTokens: 1024 } });
      const long = { promptId: "greet", vars: { tone: "dry", name: "x".repeat(400) } };
      expect((await failure(rt.generateObject(ROLE, Answer, long))).code).toBe("llm_context_exceeded");
      expect(mock.chatRequests()).toHaveLength(0);
    });

    test("unassigned role: llm_role_unassigned", async () => {
      expect((await failure(rt.generateObject("analysis", Answer, input))).code).toBe("llm_role_unassigned");
    });

    test("a stored key that can't be read: llm_endpoint_auth, nothing sent", async () => {
      const id = await fresh({ apiKey: "sk-x" });
      await env.db.update(Endpoint).set({ apiKeyCiphertext: "AAAA" }).where(eq(Endpoint.id, id));
      expect((await failure(rt.generateObject(ROLE, Answer, input))).code).toBe("llm_endpoint_auth");
      expect(mock.chatRequests()).toHaveLength(0);
    });
  });

  describe("C16: call log", () => {
    const KEY = "sk-mock-secret-key";

    async function callAs(role: ModelRole): Promise<LlmResult<unknown>> {
      const keyed = new MockLlmServer({ apiKey: KEY });
      try {
        await assign(env.db, role, { url: keyed.url, apiKey: KEY });
        keyed.replies.push(BAD, GOOD);
        const r = await rt.generateObject(role, Answer, input);
        expect(keyed.chatRequests()[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
        return r;
      } finally {
        keyed.stop();
      }
    }

    test("one row per call, repairs counted; bodies for authoring.* and verify.solve", async () => {
      for (const role of ["authoring.generate", "verify.solve"] as const) {
        const before = (await env.db.select().from(LlmCallLog)).length;
        const r = await callAs(role);
        const rows = await env.db.select().from(LlmCallLog);
        expect(rows.length).toBe(before + 1);
        const row = rows.find((x) => x.id === r.callLogId);
        expect(row).toMatchObject({
          role,
          kind: "call",
          outcome: "ok",
          repairAttempts: 1,
          promptId: "greet",
          promptVersion: "greet-v1",
          promptFile: "greet-v1.md",
          mode: "native_schema",
          usage: { inputTokens: 20, outputTokens: 40 },
        });
        expect(JSON.stringify(row?.requestBody)).toContain("You greet people");
        expect(JSON.stringify(row?.responseBody)).toContain("count");
      }
    });

    test("bodies are null for analysis and embeddings", async () => {
      const r = await callAs("analysis");
      const [row] = await env.db.select().from(LlmCallLog).where(eq(LlmCallLog.id, r.callLogId));
      expect(row?.requestBody).toBeNull();
      expect(row?.responseBody).toBeNull();
      await fresh(
        { embedding: { dimensions: 8, queryPrefix: "", documentPrefix: "" }, capabilities: { maxInputTokens: 64 } },
        "embeddings",
      );
      await rt.embed(["one"], { kind: "query" });
      const log = await lastLog(env.db);
      expect(log).toMatchObject({ role: "embeddings", mode: "embeddings", requestBody: null, responseBody: null });
    });

    test("no row or body contains the API key", async () => {
      await callAs("authoring.generate");
      const rows = await env.db.select().from(LlmCallLog);
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toContain(KEY);
    });

    test("the variant file is recorded", async () => {
      await fresh({ model: "fancy-7b" });
      mock.replies.push(GOOD);
      const r = await rt.generateObject(ROLE, Answer, input);
      expect(systemOf(mock.chatRequests()[0]?.body as Record<string, unknown>)).toStartWith("Variant:");
      const [row] = await env.db.select().from(LlmCallLog).where(eq(LlmCallLog.id, r.callLogId));
      expect(row?.promptFile).toBe("greet-v1.fancy-*.md");
      expect(row?.promptVersion).toBe("greet-v1");
    });
  });

  describe("C17: local endpoints only", () => {
    test("a cloud-assigned role fails without any request, and is logged", async () => {
      await fresh({ location: "cloud" });
      await setLocalOnly(env.db, true);
      try {
        const e = await failure(rt.generateObject(ROLE, Answer, input));
        expect(e.code).toBe("llm_cloud_blocked");
        expect(mock.chatRequests()).toHaveLength(0);
        expect(await lastLog(env.db)).toMatchObject({ outcome: "failed", errorCode: "llm_cloud_blocked" });
        await fresh(
          {
            location: "cloud",
            embedding: { dimensions: 8, queryPrefix: "", documentPrefix: "" },
            capabilities: { maxInputTokens: 64 },
          },
          "embeddings",
        );
        expect((await failure(rt.embed(["x"], { kind: "query" }))).code).toBe("llm_cloud_blocked");
        expect(mock.requests).toHaveLength(0);
        // A local endpoint still works.
        await fresh({ location: "local" });
        mock.replies.push(GOOD);
        await rt.generateObject(ROLE, Answer, input);
      } finally {
        await setLocalOnly(env.db, false);
      }
    });
  });

  describe("C18: anthropic adapter", () => {
    const KEY = "sk-ant-mock";

    test("requests go to the base URL with the key header; structured output works; params pass through", async () => {
      const server = new MockLlmServer({ apiKey: KEY });
      try {
        await assign(env.db, ROLE, {
          url: server.url,
          provider: "anthropic",
          apiKey: KEY,
          location: "cloud",
          model: "claude-test",
          params: { top_k: 20, temperature: 0.5 },
        });
        server.replies.push(GOOD);
        const r = await rt.generateObject(ROLE, Answer, input);
        expect(r.value.count).toBe(3);
        const req = server.chatRequests()[0];
        expect(req?.path).toBe("/v1/messages");
        expect(req?.headers["x-api-key"]).toBe(KEY);
        expect(req?.body).toMatchObject({ top_k: 20, temperature: 0.5, model: "claude-test" });
        expect(JSON.stringify(req?.body)).toContain("count");
      } finally {
        server.stop();
      }
    });
  });
});

describe.skipIf(!hasDb)("C15: embeddings", () => {
  let env: TestEnv;
  let mock: MockLlmServer;
  const embedding = { dimensions: 8, queryPrefix: "q: ", documentPrefix: "d: " };

  beforeAll(async () => {
    env = await createEnv();
    mock = new MockLlmServer({ embedCap: 100 });
  });
  afterAll(async () => {
    mock?.stop();
    await env?.close();
  });

  const setup = async (maxInputTokens = 100) => {
    mock.requests.length = 0;
    mock.wrongDimensions = undefined;
    await assign(env.db, "embeddings", { url: mock.url, embedding, capabilities: { maxInputTokens } });
  };
  const inputs = () => mock.requests.filter((r) => r.path === "/v1/embeddings").map((r) => r.body.input as string[]);
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

  test("prefixes are sent, by kind, and aren't in the result", async () => {
    await setup();
    const q = await env.runtime.embed(["hello"], { kind: "query" });
    await env.runtime.embed(["hello"], { kind: "document" });
    expect(inputs()).toEqual([["q: hello"], ["d: hello"]]);
    expect(q.vectors).toHaveLength(1);
    expect(q.vectors[0]).toHaveLength(8);
    expect(JSON.stringify(q)).not.toContain("q: ");
    expect(q.tokens).toEqual([2]);
  });

  test("batches ≤ 32; order is kept", async () => {
    await setup();
    const texts = Array.from({ length: 70 }, (_, i) => `text ${i}`);
    const r = await env.runtime.embed(texts, { kind: "document" });
    expect(
      inputs()
        .map((b) => b.length)
        .sort((a, b) => b - a),
    ).toEqual([32, 32, 6]);
    expect(r.vectors).toHaveLength(70);
    const one = await env.runtime.embed(["text 69"], { kind: "document" });
    expect(r.vectors[69]).toEqual(one.vectors[0] as number[]);
    expect(r.tokens.every((t) => t === 3)).toBe(true);
  });

  test("a long text is sent alone, so its count is exact", async () => {
    await setup();
    const long = words(45); // estimate over half of 100
    expect(long.length / 3).toBeGreaterThan(50);
    const r = await env.runtime.embed(["short", long, "also short"], { kind: "query" });
    const sizes = inputs()
      .map((b) => b.length)
      .sort();
    expect(sizes).toEqual([1, 2]);
    expect(r.tokens[1]).toBe(46);
  });

  test("a text at the cap fails llm_embedding_truncated, with its index; nothing is returned", async () => {
    await setup();
    const e = await failure(env.runtime.embed(["short", words(500)], { kind: "document" }));
    expect(e.code).toBe("llm_embedding_truncated");
    expect(e.params.index).toBe(1);
    expect(await lastLog(env.db)).toMatchObject({ outcome: "failed", errorCode: "llm_embedding_truncated" });
  });

  test("just under the cap passes", async () => {
    await setup();
    const r = await env.runtime.embed([words(98)], { kind: "query" });
    expect(r.tokens).toEqual([99]);
  });

  test("a long text with no token count back fails: truncation couldn't be seen", async () => {
    await setup();
    mock.options.noEmbedUsage = true;
    try {
      const error = await env.runtime.embed([words(60)], { kind: "document" }).catch((e) => e);
      expect(error).toBeInstanceOf(LlmError);
      expect(error).toMatchObject({ code: "llm_endpoint_error", params: { index: 0, reason: "no_token_count" } });
    } finally {
      mock.options.noEmbedUsage = false;
    }
  });

  test("a wrong vector length fails", async () => {
    await setup();
    mock.wrongDimensions = 5;
    const e = await failure(env.runtime.embed(["x"], { kind: "query" }));
    expect(e.code).toBe("llm_endpoint_error");
  });
});
