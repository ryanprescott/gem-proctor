import { type EvalReport, type EvalRunOptions, type GroundingEvalSet, LlmError, type LlmRuntime } from "@gem/llm";
import { type GeneratedQuestion, GenerationBatch } from "@gem/shared";
import { checkGrounding } from "./validate/grounding.ts";
import { checkForm } from "./validate/leakage.ts";
import { checkStructure } from "./validate/structure.ts";

/**
 * `grounding-smoke` (P2.md E51): the generation prompt on chunks laid out as authoring lays them out, and L1 to L3 on
 * what comes back. No sandbox: L7 has its own set. A rate is the share of questions without a `fail` in that layer.
 */

const round = (x: number, digits = 4) => Number(x.toFixed(digits));
const THRESHOLD = 0.9;

/** The same layout `generate.ts` sends: each chunk tagged with its key, then the objectives and the request. */
export function groundingPrompt(set: GroundingEvalSet): string {
  const chunks = set.fixtures.chunks.map((c) => `Source chunk [${c.id}]:\n${c.text}`);
  const objectives = set.fixtures.objectives.map((o) => `${o.id}: ${o.label}`).join("\n");
  return [...chunks, `Objectives:\n${objectives}`, `Write ${set.request.count} questions: ${set.request.counts}.`].join(
    "\n\n",
  );
}

function check(q: GeneratedQuestion, set: GroundingEvalSet) {
  const texts = new Map(set.fixtures.chunks.map((c) => [c.id, c.text]));
  const evidence = q.evidence.map((e) => ({ chunkId: e.chunkId, quote: e.quote }));
  const options = q.computable ? [] : (q.options as { text: string; isCorrect: boolean }[]);
  const l1 = checkStructure(
    {
      type: q.type,
      computable: q.computable,
      question: q.question,
      objectiveIds: q.objectiveIds,
      evidence,
      inputs: q.inputs as { name: string; from: string; sourceText: string }[],
      answerProgram: q.answerProgram,
      options,
      mistakes: q.mistakes as unknown[],
    },
    {
      objectiveIds: new Set(set.fixtures.objectives.map((o) => o.id)),
      chunkIds: new Set(set.fixtures.chunks.map((c) => c.id)),
    },
  );
  const l2 = checkGrounding(evidence, texts, THRESHOLD);
  const correct = options.find((o) => o.isCorrect)?.text ?? null;
  const l3 = checkForm({
    question: q.question,
    options: q.computable ? null : options,
    correctAnswer: correct,
    explanation: q.explanation,
    passages: [...evidence.map((e) => e.quote), ...evidence.flatMap((e) => texts.get(e.chunkId) ?? [])],
    computable: q.computable,
  });
  return { l1: l1.outcome !== "fail", l2: l2.outcome !== "fail", l3: l3.outcome !== "fail" };
}

export async function runGroundingEval(
  deps: { llm: LlmRuntime },
  set: GroundingEvalSet,
  opts: EvalRunOptions,
): Promise<EvalReport> {
  const trials = opts.trials ?? set.defaultTrials;
  const user = groundingPrompt(set);
  const items: Record<string, unknown>[] = [];
  for (let trial = 1; trial <= trials; trial++) {
    try {
      const r = await deps.llm.generateObject(
        set.role,
        GenerationBatch,
        { promptId: set.prompt, vars: { ...set.request.vars }, messages: [{ role: "user", content: user }] },
        opts,
      );
      const checked = r.value.questions.map((q) => check(q, set));
      items.push({
        trial,
        valid: true,
        repairs: r.repairAttempts,
        questions: checked.length,
        l1: checked.filter((c) => c.l1).length,
        l2: checked.filter((c) => c.l2).length,
        l3: checked.filter((c) => c.l3).length,
        seconds: round(r.latencyMs / 1000, 3),
      });
    } catch (err) {
      // Invalid output is what's being measured; anything else ends the run.
      if (!(err instanceof LlmError) || !(err.code === "llm_output_invalid" || err.code === "llm_output_incomplete")) {
        throw err;
      }
      items.push({ trial, valid: false, error: err.code, repairs: err.params.repairAttempts, questions: 0 });
    }
  }
  const valid = items.filter((i) => i.valid);
  const sum = (key: string, list = items) => list.reduce((n, i) => n + ((i[key] as number | undefined) ?? 0), 0);
  const questions = sum("questions");
  const share = (key: string) => (questions === 0 ? null : round(sum(key) / questions));
  return {
    summary: {
      trials,
      validFirstTry: round(valid.filter((i) => i.repairs === 0).length / trials),
      validAfterRepairs: round(valid.length / trials),
      l1Pass: share("l1"),
      l2Pass: share("l2"),
      l3Pass: share("l3"),
      secondsPerQuestion: questions === 0 ? null : round(sum("seconds", valid) / questions, 2),
    },
    items,
  };
}
