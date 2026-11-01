// bun run e2e — Playwright + axe end-to-end tests (P0.md A1, A30–A32).
//   E2E_BASE_URL=http://localhost:3000 bun run e2e   run against a running stack (e.g. Compose)
//   bun run e2e                                      start a throwaway stack: fresh database on the local
//                                                    Postgres (TEST_PG_ADMIN_URL or .dev/pg), built web app,
//                                                    API on port 3100, and the real verify parent if Python is there
// Either way a mock model server runs here for the LLM page; its URL reaches the tests as E2E_LLM_URL.
// A stack in containers reaches it through E2E_MOCK_HOST (CI: host.docker.internal).
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapDatabase, withDatabase } from "@gem/db";
import pg from "pg";
import { type ChatReply, MockLlmServer } from "../packages/llm/mock/server.ts";
import { adminUrl, ROOT, startLocalPg } from "./pg-local.ts";
import { findVerifyPython, type LocalVerify, superviseVerify } from "./verify-local.ts";

const WEB = join(ROOT, "apps", "web");
const extraArgs = process.argv.slice(2);

async function runPlaywright(baseUrl: string, env: Record<string, string> = {}): Promise<number> {
  const proc = Bun.spawn([join(WEB, "node_modules", ".bin", "playwright"), "test", ...extraArgs], {
    cwd: WEB,
    env: { ...process.env, ...env, E2E_BASE_URL: baseUrl },
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error(`timed out waiting for ${url}`);
}

const RECORDED = JSON.parse(readFileSync(join(ROOT, "packages/authoring/test/fixtures/l7-recorded.json"), "utf8")) as {
  quiz: { replies: { promptId: string; question: string; value: unknown }[] };
};

/** The Verify answers flow: what the reference model wrote for the fixture, then a hostile result (C31). */
function verifyReply(content: string): ChatReply | null {
  const prompt = content.includes("Write a short Python program")
    ? "verify.solve.blind"
    : content.includes("Decide whether answering")
      ? "verify.solve.classify"
      : content.includes("by choosing one of its options")
        ? "verify.solve.pick"
        : null;
  if (!prompt) return null;
  const question = content.split("Question:\n")[1]?.split("\n\nOptions:")[0]?.trim() ?? "";
  if (question.includes("HOSTILE")) {
    if (prompt === "verify.solve.classify") return JSON.stringify({ reason: "a calculation", computable: true });
    const latex = String.raw`\\href{javascript:alert(1)}{x}`;
    return {
      text: JSON.stringify({
        program: `from sympy import Symbol\nresult = Symbol('<img src=x onerror=alert(1)> ${latex}')`,
      }),
      delayMs: 50,
    };
  }
  const recorded = RECORDED.quiz.replies.find((r) => r.promptId === prompt && r.question.trim() === question);
  // A little delay, so the UI shows progress.
  return recorded ? { text: JSON.stringify(recorded.value), delayMs: 50 } : null;
}

/** Enough for the probe and for `generate-smoke`; slow enough that the UI sees a run in progress. */
function startMockLlm(mockHost: string | undefined) {
  const quote = "For two n-vectors a and b, the inner product";
  const question = {
    tempId: "q1",
    objectiveIds: ["O1"],
    type: "single_choice",
    topic: "Inner product",
    computable: false,
    evidence: [{ chunkId: "evals:inner-products:c1", quote }],
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
  const mock = new MockLlmServer({
    hostname: mockHost ? "0.0.0.0" : "127.0.0.1",
    server: "ollama",
    contextLength: 32_768,
    models: ["mock-chat", "mock-embed"],
    dimensions: 768,
    embedCap: 2048,
    embedDelayMs: 250,
    reply: (body) =>
      JSON.stringify(body.messages).includes("2 + 2")
        ? '{"answer": 4}'
        : (verifyReply((body.messages as { content: string }[]).map((m) => m.content).join("\n")) ?? {
            text: JSON.stringify({ questions: [question, question, question, question] }),
            delayMs: 700,
          }),
  });
  return { mock, url: mockHost ? `http://${mockHost}:${mock.port}/v1` : mock.url };
}

const llm = startMockLlm(process.env.E2E_MOCK_HOST);

if (process.env.E2E_BASE_URL) {
  process.exit(await runPlaywright(process.env.E2E_BASE_URL, { E2E_LLM_URL: llm.url }));
}

// ── Throwaway stack ──────────────────────────────────────────────────
let admin = process.env.TEST_PG_ADMIN_URL;
if (!admin) {
  await startLocalPg();
  admin = adminUrl();
}
const ownerPw = process.env.GEM_OWNER_PASSWORD ?? "change-me";
const appPw = process.env.GEM_APP_PASSWORD ?? "change-me";
const dbname = `gem_e2e_${randomBytes(4).toString("hex")}`;
await bootstrapDatabase({ adminUrl: admin, dbname, ownerPassword: ownerPw, appPassword: appPw });
const roleUrl = (role: string, pw: string) => {
  const u = new URL(admin as string);
  u.username = role;
  u.password = pw;
  return withDatabase(u.toString(), dbname);
};

console.log("building the web app…");
if (Bun.spawnSync(["bun", "run", "build"], { cwd: WEB, stdout: "ignore", stderr: "inherit" }).exitCode !== 0) {
  throw new Error("web build failed");
}

const children: { kill(): void; exited: Promise<number> }[] = [];
const socket = join(mkdtempSync(join(tmpdir(), "gem-e2e-")), "verify", "verify.sock");
const python = findVerifyPython();
const verify: LocalVerify | undefined = python ? superviseVerify(python, socket) : undefined;

const port = process.env.E2E_PORT ?? "3100";
// --no-env-file: Bun would load the repo's .env, and the dev seed would put LLM_DEV_* in the throwaway database.
const api = Bun.spawn(["bun", "--no-env-file", join(ROOT, "apps", "api", "src", "main.ts")], {
  cwd: ROOT,
  env: {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: "development",
    API_HOST: "127.0.0.1",
    API_PORT: port,
    DATABASE_URL: roleUrl("gem_app", appPw),
    DATABASE_URL_OWNER: roleUrl("gem_owner", ownerPw),
    SESSION_SECRET: randomBytes(32).toString("base64"),
    ENDPOINT_SECRET_KEY: randomBytes(32).toString("base64"),
    ADMIN_EMAIL: "",
    ADMIN_PASSWORD: "",
    VERIFY_SOCKET: socket,
    WEB_DIST: join(WEB, "dist"),
    MIGRATE_ON_START: "true",
    ENV_FILE: "/dev/null",
  },
  stdout: process.env.E2E_API_LOG ? "inherit" : "ignore",
  stderr: "inherit",
});
children.push(api);

let code = 1;
try {
  await waitFor(`http://127.0.0.1:${port}/api/v1/health`, 60_000);
  code = await runPlaywright(`http://127.0.0.1:${port}`, { E2E_LLM_URL: llm.url });
} finally {
  llm.mock.stop();
  await verify?.stop();
  for (const c of children) c.kill();
  await Promise.all(children.map((c) => c.exited));
  const client = new pg.Client({ connectionString: admin });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS "${dbname}" WITH (FORCE)`);
  await client.end();
}
process.exit(code);
