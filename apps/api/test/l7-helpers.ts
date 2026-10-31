// The L7 engine against everything real but the model: Postgres, the verify parent (local mode), the LLM runtime
// and its call log, with the mock server replaying recorded or scripted replies.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { L7Deps } from "@gem/authoring";
import { type ChatReply, MockLlmServer } from "@gem/llm/mock";
import { DEFAULT_VERIFY_SETTINGS, type VerifySettings } from "@gem/shared";
import { assign } from "../../../packages/llm/test/helpers.ts";
import { findVerifyPython, type LocalVerify, superviseVerify } from "../../../scripts/verify-local.ts";
import { dbRecorder } from "../src/verification.ts";
import { SocketVerifyClient } from "../src/verify-client.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

export const verifyPython = findVerifyPython();

export const RECORDED = JSON.parse(
  readFileSync(join(import.meta.dir, "../../../packages/authoring/test/fixtures/l7-recorded.json"), "utf8"),
) as {
  model: string;
  batchSeed: string;
  chunk: { id: string; text: string };
  batch: { questions: Record<string, unknown>[] };
  quiz: { outcomes: { id: number; outcome: string; reason: string; fix: string | null }[]; replies: RecordedReply[] };
  flowA: { outcomes: { tempId: string; outcome: string }[]; replies: RecordedReply[] };
};

export const QUIZ_PATH = join(import.meta.dir, "../../../tests/engr108_chapter1_new_20q_quiz.json");

export interface RecordedReply {
  promptId: string;
  question: string;
  value: unknown;
}

export type PromptKind = "blind" | "classify" | "pick" | "repair";

/** Which prompt a chat request is, and the question in it. */
export function promptOf(body: Record<string, unknown>): { kind: PromptKind; question: string; content: string } {
  const messages = body.messages as { content: string }[];
  const content = messages.map((m) => m.content).join("\n");
  if (content.includes("Write a short Python program")) {
    return { kind: "blind", question: content.split("Question:\n")[1]?.trim() ?? "", content };
  }
  if (content.includes("Decide whether answering")) {
    return {
      kind: "classify",
      question: content.split("Question:\n")[1]?.split("\n\nOptions:")[0]?.trim() ?? "",
      content,
    };
  }
  if (content.includes("by choosing one of its options")) {
    return { kind: "pick", question: content.split("Question:\n")[1]?.split("\n\nOptions:")[0]?.trim() ?? "", content };
  }
  return { kind: "repair", question: content.split("Question:\n")[1]?.split("\n\nProgram:")[0]?.trim() ?? "", content };
}

const KINDS: Record<string, PromptKind> = {
  "verify.solve.blind": "blind",
  "verify.solve.classify": "classify",
  "verify.solve.pick": "pick",
  "program-repair": "repair",
};

/** Replays recorded replies by prompt and question. A request nothing was recorded for is a test failure. */
export function replay(replies: RecordedReply[]) {
  const left = replies.map((r) => ({ ...r, kind: KINDS[r.promptId] }));
  return (body: Record<string, unknown>): ChatReply => {
    const { kind, question } = promptOf(body);
    const at = left.findIndex((r) => r.kind === kind && r.question.trim() === question);
    if (at === -1) return { status: 500, body: { error: { message: `nothing recorded: ${kind} ${question}` } } };
    const [reply] = left.splice(at, 1);
    return JSON.stringify(reply?.value);
  };
}

export interface L7Env {
  t: TestApp;
  mock: MockLlmServer;
  deps: L7Deps;
  socket: string;
  client: SocketVerifyClient;
  /** What the mock answers next time; replaced per test. */
  setReply(fn: (body: Record<string, unknown>) => ChatReply): void;
  /** Sets `verify.solve` on the mock (it's unassigned in tests that need that). */
  assignSolve(): Promise<void>;
  close(): Promise<void>;
}

export async function createL7Env(settings: Partial<VerifySettings> = {}): Promise<L7Env> {
  const dir = mkdtempSync(join(tmpdir(), "gem-l7-"));
  const socket = join(dir, "verify", "verify.sock");
  const verify: LocalVerify = superviseVerify(verifyPython as string, socket);
  const client = new SocketVerifyClient(socket, { timeoutMs: 1000 });
  for (let i = 0; i < 200 && !(await client.health()); i++) await Bun.sleep(100);
  let reply: (body: Record<string, unknown>) => ChatReply = () => "{}";
  const mock = new MockLlmServer({ reply: (body) => reply(body) });
  const t = await createTestApp();
  t.ctx.verify = client;
  const assignSolve = async () => {
    await assign(t.db, "verify.solve", { url: mock.url, timeoutMs: 20_000 });
  };
  await assignSolve();
  return {
    t,
    mock,
    socket,
    client,
    assignSolve,
    setReply: (fn) => {
      reply = fn;
    },
    deps: {
      llm: t.ctx.llm,
      verify: client,
      recorder: dbRecorder(t.db),
      settings: { ...DEFAULT_VERIFY_SETTINGS, ...settings },
    },
    async close() {
      await t.close();
      mock.stop();
      await verify.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
