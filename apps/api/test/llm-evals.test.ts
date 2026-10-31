import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmCallLog, LlmEvalRun } from "@gem/db";
import { ACTIVE_PROMPTS, listEvalSets, loadEvalSet, loadPrompt, PROMPTS_DIR, renderPrompt } from "@gem/llm";
import { MockLlmServer } from "@gem/llm/mock";
import { EVAL_METRICS } from "@gem/shared";
import { eq } from "drizzle-orm";
import { evalRuns, processEvalRun, startEvalWorker } from "../src/llm-evals.ts";
import { Queue } from "../src/queue.ts";
import { API, type Client, createTestApp, hasDb, registerUser, type TestApp } from "./helpers.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const set = loadEvalSet("generate-smoke");
const chunk = set.kind === "generate" ? (set.fixtures.chunks[0] as { id: string; text: string }) : undefined;
const QUOTE = chunk?.text.slice(0, 40) as string;

function question(quote: string) {
  return {
    tempId: "q1",
    type: "single_choice",
    topic: "Inner product",
    computable: false,
    evidence: [{ chunkId: chunk?.id, quote }],
    inputs: [],
    question: "Which is the definition of orthogonal?",
    constraint: "",
    answerProgram: "",
    options: [
      { whyWrong: "no", text: "a", isCorrect: false },
      { whyWrong: "no", text: "b", isCorrect: false },
      { text: "c", isCorrect: true },
    ],
    mistakes: [],
    explanation: "From the definition.",
  };
}
const batch = (quote = QUOTE) =>
  JSON.stringify({ questions: [question(quote), question(quote), question(quote), question("not in the chunk")] });

describe("C28: prompts", () => {
  test("every prompt has its version id, in its file, and renders", () => {
    expect(ACTIVE_PROMPTS).toMatchObject({
      "authoring.generate": "gen-v8",
      "verify.solve.blind": "blind-v2",
      "verify.solve.classify": "classify-v1",
      "program-repair": "repair-v1",
      "output-repair": "output-repair-v1",
    });
    for (const [id, version] of Object.entries(ACTIVE_PROMPTS)) {
      expect(existsSync(join(PROMPTS_DIR, id, `${version}.md`))).toBe(true);
      expect(loadPrompt(id, "any-model").version).toBe(version);
    }
    const vars = { allowedImports: "a", resultTypeRules: "b" };
    const blind = loadPrompt("verify.solve.blind", "m");
    const r = renderPrompt(blind, { ...vars, passage: "p", question: "q" });
    expect(r.system).toBe("");
    expect(r.user).toStartWith("Write a short Python program");
    const repair = loadPrompt("program-repair", "m");
    expect(renderPrompt(repair, { ...vars, question: "q", program: "p", error: "e" }).user).toContain("failed");
    const gen = loadPrompt("authoring.generate", "m");
    const g = renderPrompt(gen, { ...vars, styleGuidance: "s" });
    expect(g.system).toContain("YOU NEVER WRITE A NUMBER");
    expect(g.system).toContain("{x}"); // single braces are the question's own placeholders
    expect(g.user).toBe("");
  });

  test("the docs point at the new home", () => {
    const doc = readFileSync(join(ROOT, "docs", "prompts", "authoring-generate.md"), "utf8");
    expect(doc).toContain("packages/llm/prompts/");
    expect(readFileSync(join(ROOT, "tools", "probes", "l7", "README.md"), "utf8")).toContain("packages/llm/prompts/");
    expect(existsSync(join(ROOT, "tools", "probes", "l7", "prompts", "gen-v8.txt"))).toBe(false);
  });

  test("the eval sets parse, with the sizes §5 asks for", () => {
    expect(listEvalSets()).toEqual(["generate-smoke", "l7-smoke", "retrieval-mini"]);
    const r = loadEvalSet("retrieval-mini");
    if (r.kind !== "retrieval") throw new Error("kind");
    expect(r.fixtures.chunks.length).toBeGreaterThanOrEqual(14);
    expect(r.fixtures.queries.length).toBeGreaterThanOrEqual(15);
    const ids = new Set(r.fixtures.chunks.map((c) => c.id));
    for (const q of r.fixtures.queries) expect(ids.has(q.expected)).toBe(true);
  });
});

describe.skipIf(!hasDb)("C30–C32: eval runs", () => {
  let t: TestApp;
  let admin: Client;
  let mock: MockLlmServer;
  let embed: MockLlmServer;
  let queue: Queue;
  const capabilities = { structuredOutput: "native_schema", contextWindow: 65536, maxOutputTokens: 2048 };

  beforeAll(async () => {
    t = await createTestApp({ env: { LLM_RATE_LIMIT_MAX: "1000" } });
    admin = (await registerUser(t.app, "admin@example.com")).client;
    mock = new MockLlmServer({ reply: () => batch() });
    embed = new MockLlmServer({ dimensions: 16 });
    queue = await Queue.start(t.database.appUrl, () => {});
    t.ctx.queue = queue;
    await startEvalWorker(t.ctx);
    const chat = await admin.post(`${API}/admin/llm/endpoints`, {
      label: "Chat",
      baseUrl: mock.url,
      location: "local",
    });
    const emb = await admin.post(`${API}/admin/llm/endpoints`, { label: "Emb", baseUrl: embed.url, location: "local" });
    const put = await admin.put(`${API}/admin/llm/roles/authoring.generate`, {
      endpointId: chat.json().endpoint.id,
      model: "m",
      capabilities,
    });
    expect(put.statusCode).toBe(200);
    const putEmb = await admin.put(`${API}/admin/llm/roles/embeddings`, {
      endpointId: emb.json().endpoint.id,
      model: "e",
      capabilities: { ...capabilities, maxInputTokens: 4096 },
      embedding: { dimensions: 16, queryPrefix: "q: ", documentPrefix: "d: " },
    });
    expect(putEmb.statusCode).toBe(200);
  });
  afterAll(async () => {
    await queue?.stop();
    mock?.stop();
    embed?.stop();
    await t?.close();
  });

  async function finished(id: string) {
    for (let i = 0; i < 200; i++) {
      const res = await admin.get(`${API}/admin/llm/evals/${id}`);
      const { run } = res.json();
      if (run.status === "done" || run.status === "failed") return run;
      await Bun.sleep(50);
    }
    throw new Error("the run didn't finish");
  }
  const start = (body: object) => admin.post(`${API}/admin/llm/evals/run`, body);

  test("C30 + C31: generate-smoke through the job: every metric, stored, calls carry evalRunId", async () => {
    const res = await start({ evalSet: "generate-smoke", trials: 2 });
    expect(res.statusCode).toBe(200);
    const queued = res.json().run;
    expect(queued).toMatchObject({ status: "queued", role: "authoring.generate", model: "m", promptVersion: "gen-v8" });
    const run = await finished(queued.id);
    expect(run.status).toBe("done");
    expect(run.summary).toMatchObject({
      trials: 2,
      validFirstTry: 1,
      repairsPerCall: 0,
      validAfterRepairs: 1,
      evidenceVerbatim: 0.75,
    });
    expect(run.summary.secondsPerQuestion).toBeGreaterThanOrEqual(0);
    expect(EVAL_METRICS).toEqual(expect.arrayContaining(Object.keys(run.summary)));
    expect(run.items).toHaveLength(2);
    const calls = await t.db.select().from(LlmCallLog).where(eq(LlmCallLog.evalRunId, queued.id));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ kind: "eval", promptVersion: "gen-v8", role: "authoring.generate" });
    expect(calls[0]?.requestBody).not.toBeNull();
  });

  test("C30: generate-smoke with repairs and an invalid trial", async () => {
    mock.replies.push("nope", batch(), "nope", "nope", "nope");
    const run = await finished((await start({ evalSet: "generate-smoke", trials: 2 })).json().run.id);
    expect(run.status).toBe("done");
    expect(run.summary).toMatchObject({ validFirstTry: 0, validAfterRepairs: 0.5, repairsPerCall: 1.5 });
  });

  test("C30: a cut-off reply counts as an invalid trial, with no repair", async () => {
    mock.replies.push({ text: "", finishReason: "length" }, batch());
    const run = await finished((await start({ evalSet: "generate-smoke", trials: 2 })).json().run.id);
    expect(run.status).toBe("done");
    expect(run.summary).toMatchObject({ validFirstTry: 0.5, validAfterRepairs: 0.5, repairsPerCall: 0 });
  });

  test("C30: retrieval-mini: top-1 and MRR, with and without prefixes", async () => {
    const run = await finished((await start({ evalSet: "retrieval-mini" })).json().run.id);
    expect(run.status).toBe("done");
    expect(run.promptVersion).toBe("none");
    for (const k of ["top1", "mrr", "top1NoPrefix", "mrrNoPrefix"]) expect(run.summary[k]).toBeNumber();
    expect(run.summary.queries).toBe(16);
    expect(EVAL_METRICS).toEqual(expect.arrayContaining(Object.keys(run.summary)));
    expect(run.items).toHaveLength(16);
    const sent = embed.requests.map((r) => (r.body.input as string[])[0] as string);
    expect(sent.some((s) => s.startsWith("d: "))).toBe(true);
    expect(sent.some((s) => s.startsWith("q: "))).toBe(true);
    expect(sent.some((s) => !s.startsWith("d: ") && !s.startsWith("q: "))).toBe(true);
    const calls = await t.db.select().from(LlmCallLog).where(eq(LlmCallLog.evalRunId, run.id));
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.kind === "eval" && c.requestBody === null)).toBe(true);
  });

  test("C31: a second run for the same role is 409 llm_eval_running", async () => {
    mock.replies.push({ text: batch(), delayMs: 300 });
    const first = await start({ evalSet: "generate-smoke", trials: 1 });
    const second = await start({ evalSet: "generate-smoke", trials: 1 });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("llm_eval_running");
    await finished(first.json().run.id);
  });

  test("C31: a model failure ends the run failed with a code", async () => {
    mock.replies.push({ status: 500 });
    const run = await finished((await start({ evalSet: "generate-smoke", trials: 1 })).json().run.id);
    expect(run).toMatchObject({ status: "failed", errorCode: "llm_endpoint_error" });
    expect(run.summary).toBeNull();
  });

  test("an unknown set is 404; the list is newest first and filters by role", async () => {
    expect((await start({ evalSet: "nope" })).statusCode).toBe(404);
    const body = (await admin.get(`${API}/admin/llm/evals`)).json();
    expect(body.evalSets).toEqual(["generate-smoke", "l7-smoke", "retrieval-mini"]);
    const stamps = body.runs.map((r: { createdAt: string }) => r.createdAt);
    expect([...stamps].sort().reverse()).toEqual(stamps);
    const only = (await admin.get(`${API}/admin/llm/evals?role=embeddings`)).json().runs;
    expect(only.every((r: { role: string }) => r.role === "embeddings")).toBe(true);
    expect(only.length).toBeGreaterThan(0);
    expect(await evalRuns(t.ctx)).toHaveLength(body.runs.length);
    expect((await admin.get(`${API}/admin/llm/evals/01890000-0000-7000-8000-000000000000`)).statusCode).toBe(404);
  });

  test("an unassigned role is 409 llm_role_unassigned", async () => {
    await admin.delete(`${API}/admin/llm/roles/embeddings`);
    const res = await start({ evalSet: "retrieval-mini" });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("llm_role_unassigned");
  });

  test("C32: bun run llm:eval prints the same report as the job, for the same replies", async () => {
    const run = await finished((await start({ evalSet: "generate-smoke", trials: 2 })).json().run.id);
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      DATABASE_URL: t.database.appUrl,
      DATABASE_URL_OWNER: t.database.ownerUrl,
      SESSION_SECRET: Buffer.alloc(32, 7).toString("base64"),
      ENV_FILE: "/nonexistent",
    };
    const proc = Bun.spawn(
      ["bun", join(ROOT, "apps", "api", "src", "llm-eval-cli.ts"), "generate-smoke", "--trials", "2"],
      {
        cwd: tmpdir(),
        env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toContain("eval generate-smoke (authoring.generate)");
    expect(out).toContain("prompt gen-v8");
    for (const [k, v] of Object.entries(run.summary)) {
      if (k !== "secondsPerQuestion") expect(out).toContain(`  ${k}: ${v}`);
    }
    // The CLI's run is stored like the job's.
    const rows = await t.db.select().from(LlmEvalRun).where(eq(LlmEvalRun.status, "done"));
    const summaries = rows.filter((r) => r.evalSet === "generate-smoke").map((r) => r.summary);
    expect(summaries.at(-1)).toMatchObject({ evidenceVerbatim: 0.75 });
  });

  test("C32: --dev uses LLM_DEV_* and stores nothing", async () => {
    const before = (await t.db.select().from(LlmEvalRun)).length;
    const proc = Bun.spawn(
      ["bun", join(ROOT, "apps", "api", "src", "llm-eval-cli.ts"), "generate-smoke", "--trials", "1", "--dev"],
      {
        cwd: tmpdir(),
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          DATABASE_URL: "postgres://nobody:x@127.0.0.1:9/none",
          DATABASE_URL_OWNER: "postgres://nobody:x@127.0.0.1:9/none",
          SESSION_SECRET: Buffer.alloc(32, 7).toString("base64"),
          ENV_FILE: "/nonexistent",
          LLM_DEV_BASE_URL: mock.url,
          LLM_DEV_MODEL: "m",
          LLM_DEV_CONTEXT: "65536",
          LLM_DEV_ROLES: "authoring.generate",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out).toContain("validFirstTry: 1");
    expect((await t.db.select().from(LlmEvalRun)).length).toBe(before);
  });

  test("llm:live reports discovery, probes and evals from LLM_DEV_*, and exits non-zero on a failed check", async () => {
    const live = async (baseUrl: string) => {
      const proc = Bun.spawn(["bun", join(ROOT, "apps", "api", "src", "llm-live-cli.ts"), "--trials", "1"], {
        cwd: tmpdir(),
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          DATABASE_URL: "postgres://nobody:x@127.0.0.1:9/none",
          DATABASE_URL_OWNER: "postgres://nobody:x@127.0.0.1:9/none",
          SESSION_SECRET: Buffer.alloc(32, 7).toString("base64"),
          ENV_FILE: "/nonexistent",
          LLM_DEV_BASE_URL: baseUrl,
          LLM_DEV_MODEL: "m",
          LLM_DEV_CONTEXT: "65536",
          LLM_DEV_ROLES: "authoring.generate",
          LLM_DEV_EMBED_MODEL: "e",
          LLM_DEV_EMBED_DIM: "8",
          LLM_DEV_EMBED_MAX_INPUT_TOKENS: "4096",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      return { out: await new Response(proc.stdout).text(), code: await proc.exited };
    };
    mock.options.embedCap = 512;
    mock.options.dimensions = 8;
    mock.options.reply = (body) => (JSON.stringify(body.messages).includes("2 + 2") ? '{"answer": 4}' : batch());
    const ok = await live(mock.url);
    expect(ok.out).toContain("== discovery");
    expect(ok.out).toContain('"schemaRespected": true');
    expect(ok.out).toContain('"dimensions": 8');
    expect(ok.out).toContain("eval generate-smoke");
    expect(ok.out).toContain("eval retrieval-mini");
    expect(ok.code).toBe(0);
    const down = await live("http://127.0.0.1:9/v1");
    expect(down.out).toContain("llm_endpoint_unreachable");
    expect(down.code).toBe(1);
  });

  test("processEvalRun ignores an unknown id", async () => {
    expect(await processEvalRun(t.ctx, "01890000-0000-7000-8000-000000000000")).toBeNull();
  });
});
