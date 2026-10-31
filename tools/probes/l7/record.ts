// Records real replies from the reference model for the L7 tests (P2.1.md C15, C25): `generate-smoke` output and
// the blind programs, classifications and picks for it and for the 20-question fixture. Run from the repo root:
//   LLM_DEV_PARAMS='{...}' bun tools/probes/l7/record.ts packages/authoring/test/fixtures/l7-recorded.json
// The tests replay these through the mock server, so `bun run ci` needs no model.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkConceptNotation, checkQuestion, computeQuestion, importedQuestion, type L7Deps } from "../../../packages/authoring/src/index.ts";
import { loadEvalSet } from "../../../packages/llm/src/index.ts";
import { DEFAULT_VERIFY_SETTINGS, GenerationBatch } from "../../../packages/shared/src/index.ts";
import { loadConfig } from "../../../apps/api/src/config.ts";
import { devRuntime } from "../../../apps/api/src/llm-dev.ts";
import { SocketVerifyClient } from "../../../apps/api/src/verify-client.ts";
import { findVerifyPython, superviseVerify } from "../../../scripts/verify-local.ts";

const out = process.argv[2];
if (!out) throw new Error("usage: record.ts <fixture.json>");
const ROOT = join(import.meta.dir, "..", "..", "..");
const config = loadConfig(process.env, join(ROOT, ".env"));
const llm = devRuntime(config);
const socket = join(mkdtempSync(join(tmpdir(), "gem-record-")), "verify.sock");
const verify = superviseVerify(findVerifyPython() as string, socket);
const client = new SocketVerifyClient(socket);
for (let i = 0; i < 100 && !(await client.health()); i++) await Bun.sleep(100);

type Reply = { promptId: string; question: string; value: unknown };
const replies: Reply[] = [];
const recording: L7Deps["llm"] = {
  async generateObject(role, schema, input, opts) {
    const result = await llm.generateObject(role, schema, input, opts);
    replies.push({ promptId: input.promptId, question: input.vars.question ?? "", value: result.value });
    return result;
  },
  streamObject: llm.streamObject.bind(llm),
  embed: llm.embed.bind(llm),
};
const deps: L7Deps = {
  llm: recording,
  verify: client,
  settings: DEFAULT_VERIFY_SETTINGS,
  recorder: { run: async () => "dry", denial: async () => {} },
};

const quiz = JSON.parse(readFileSync(join(ROOT, "tests/engr108_chapter1_new_20q_quiz.json"), "utf8"));
const outcomes: unknown[] = [];
for (const [i, value] of quiz.questions.entries()) {
  const q = importedQuestion(value, i);
  const result = await checkQuestion(deps, q, { questionId: q.id });
  console.log(q.id, result.outcome, result.reason, result.suggestedFix ?? "", result.blind?.result?.text ?? "");
  outcomes.push({ id: q.id, outcome: result.outcome, reason: result.reason, fix: result.suggestedFix });
}
const quizReplies = replies.splice(0);

const set = loadEvalSet("generate-smoke");
if (set.kind !== "generate") throw new Error("generate-smoke isn't a generate set");
const [chunk] = set.fixtures.chunks;
if (!chunk) throw new Error("no chunk");
const user = set.request.user.replace("{{chunkId}}", chunk.id).replace("{{chunk}}", chunk.text);
const generated = await llm.generateObject("authoring.generate", GenerationBatch, {
  promptId: set.prompt,
  vars: set.request.vars,
  messages: [{ role: "user", content: user }],
});
const used = { keys: [] as string[], source: [] as string[] };
const flowA: unknown[] = [];
for (const [i, q] of generated.value.questions.entries()) {
  if (!q.computable) {
    const r = await checkConceptNotation(
      deps,
      q.question,
      q.options.map((o) => o.text),
    );
    console.log(q.tempId, "concept", r.outcome, r.classified);
    continue;
  }
  const r = await computeQuestion(deps, {
    question: q,
    chunks: [chunk.text],
    batchSeed: "recorded",
    used,
    ref: { questionId: i + 1 },
  });
  console.log(q.tempId, q.type, r.outcome, r.reason, r.correctAnswer, r.rendered?.slice(0, 80));
  if (r.usedKey) used.keys.push(r.usedKey);
  used.source.push(...r.usedSource);
  flowA.push({ tempId: q.tempId, outcome: r.outcome, reason: r.reason, correctAnswer: r.correctAnswer });
}
writeFileSync(
  out,
  `${JSON.stringify(
    {
      recorded: new Date().toISOString().slice(0, 10),
      model: config.LLM_DEV_MODEL,
      batchSeed: "recorded",
      chunk,
      batch: generated.value,
      quiz: { outcomes, replies: quizReplies },
      flowA: { outcomes: flowA, replies: replies.splice(0) },
    },
    null,
    2,
  )}\n`,
);
await verify.stop();
process.exit(0);
