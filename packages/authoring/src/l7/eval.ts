import type { EvalReport, EvalRunOptions, L7EvalSet, LlmRuntime } from "@gem/llm";
import { type GeneratedQuestion, type QuestionType, VERIFY_MAX_PROGRAM_BYTES } from "@gem/shared";
import { type ComputableQuestion, computeQuestion } from "./flow-a.ts";
import { checkQuestion } from "./flow-b.ts";
import { checkConceptNotation } from "./notation.ts";
import { classify, type L7Deps, RunTrail, runWithRepair, writeBlindProgram } from "./programs.ts";

/** The L7 metrics (P2.1.md S13, C33): `l7-smoke` on `verify.solve`, and the live flow A run (C34). */

const round = (x: number) => Number(x.toFixed(4));
const rate = (hits: number, total: number) => (total === 0 ? null : round(hits / total));

async function programTrial(deps: L7Deps, set: L7EvalSet) {
  const items: Record<string, unknown>[] = [];
  for (const q of set.fixtures.questions) {
    const trail = new RunTrail();
    const author = await deps.verify.run({ program: q.authorProgram });
    const program = await writeBlindProgram(deps, q.question, set.fixtures.passage);
    const blind =
      program === null ? null : await runWithRepair(deps, trail, { kind: "blind", program, question: q.question });
    const same =
      author.value && blind?.result
        ? await deps.verify.compare({
            a: author.value,
            candidates: [blind.result],
            tolerance: deps.settings.numericTolerance,
          })
        : null;
    items.push({
      id: q.id,
      ran: blind?.status === "ok",
      repaired: blind?.repaired ?? false,
      agreed: same?.results?.[0]?.equal ?? false,
    });
  }
  return items;
}

export async function runL7Eval(deps: L7Deps, set: L7EvalSet, opts: EvalRunOptions): Promise<EvalReport> {
  const run = { ...deps, ...(opts.userId ? { userId: opts.userId } : {}), llm: withEval(deps.llm, opts) };
  const trials = opts.trials ?? set.defaultTrials;
  const programs: Record<string, unknown>[] = [];
  let classified = 0;
  let q7Right = 0;
  const items: Record<string, unknown>[] = [];
  for (let trial = 1; trial <= trials; trial++) {
    programs.push(...(await programTrial(run, set)));
    for (const q of set.fixtures.classification) {
      const verdict = await classify(run, q.question, q.options);
      const right = verdict?.computable === q.computable;
      if (right) classified += 1;
      items.push({ trial, classify: q.id, expected: q.computable, got: verdict?.computable ?? null });
    }
    const { q7 } = set.fixtures;
    const r = await checkQuestion(
      run,
      {
        id: q7.id,
        question: q7.question,
        options: q7.options,
        correctAnswer: q7.correctAnswer,
        acceptedAnswers: [],
        type: "single_choice",
        passage: "",
      },
      { questionId: q7.id },
    );
    const caught = r.outcome === "wrong_answer" && r.suggestedFix === q7.suggestedFix;
    if (caught) q7Right += 1;
    items.push({ trial, q7: r.outcome, fix: r.suggestedFix });
  }
  const count = (key: string) => programs.filter((p) => p[key]).length;
  return {
    summary: {
      trials,
      blindValid: rate(count("ran"), programs.length),
      agreement: rate(count("agreed"), programs.length),
      repairRate: rate(count("repaired"), programs.length),
      classification: rate(classified, trials * set.fixtures.classification.length),
      q7Outcome: rate(q7Right, trials),
    },
    items: [...programs, ...items],
  };
}

/** The eval's calls are logged as eval calls (P1.5.md §5). */
function withEval(llm: LlmRuntime, opts: EvalRunOptions): LlmRuntime {
  if (!opts.evalRunId) return llm;
  const evalRunId = opts.evalRunId;
  return {
    generateObject: (role, schema, input, callOpts) =>
      llm.generateObject(role, schema, input, { ...callOpts, evalRunId }),
    streamObject: (role, schema, input, callOpts) => llm.streamObject(role, schema, input, { ...callOpts, evalRunId }),
    embed: (texts, callOpts) => llm.embed(texts, { ...callOpts, evalRunId }),
  };
}

export interface FlowASummary {
  questions: number;
  computable: number;
  computed: number;
  disagree: number;
  couldntCompute: number;
  failed: number;
  denied: number;
  singleChoice: number;
  fourOptions: number;
  distinctInputs: number;
  trueFalse: number;
  trueFalseTrue: number;
  /** A True target that sampling couldn't reach (SPEC §3A.3.1: a warn). */
  targetMissed: number;
  /** One line per true/false question, since a share of True on a handful says little without them. */
  trueFalseItems: { question: string; answer: string; inputs: Record<string, string> }[];
  concept: number;
  conceptNotation: number;
  classifiedCalculation: number;
  sources: Record<string, number>;
  failures: Record<string, number>;
}

/** One generated batch through flow A and the notation check, for `llm:live`. */
export async function flowABatch(
  deps: L7Deps,
  questions: GeneratedQuestion[],
  chunk: string,
  batchSeed: string,
  summary: FlowASummary,
  keys: Set<string>,
) {
  const used = { keys: [] as string[], source: [] as string[] };
  for (const [i, q] of questions.entries()) {
    summary.questions += 1;
    if (!q.computable) {
      summary.concept += 1;
      const notation = await checkConceptNotation(
        deps,
        q.question,
        q.options.map((o) => o.text),
      );
      if (notation.classified !== null) summary.conceptNotation += 1;
      if (notation.classified) summary.classifiedCalculation += 1;
      continue;
    }
    summary.computable += 1;
    const tooLarge = Buffer.byteLength(q.answerProgram, "utf8") > VERIFY_MAX_PROGRAM_BYTES;
    if (tooLarge) continue;
    const r = await computeQuestion(deps, {
      question: { ...q, type: q.type as QuestionType } as ComputableQuestion,
      chunks: [chunk],
      batchSeed,
      used,
      ref: { questionId: i + 1 },
    });
    if (r.usedKey) {
      used.keys.push(r.usedKey);
      keys.add(r.usedKey);
    }
    used.source.push(...r.usedSource);
    if (r.outcome === "computed") summary.computed += 1;
    if (r.outcome === "disagree") summary.disagree += 1;
    if (r.outcome === "couldnt_compute") summary.couldntCompute += 1;
    if (r.outcome === "failed") summary.failed += 1;
    if (r.outcome === "denied") summary.denied += 1;
    if (r.outcome !== "computed") summary.failures[r.reason] = (summary.failures[r.reason] ?? 0) + 1;
    if (q.type === "single_choice" && r.options) {
      summary.singleChoice += 1;
      if (r.options.length === 4) summary.fourOptions += 1;
      for (const d of r.verification.distractors ?? []) {
        summary.sources[d.source] = (summary.sources[d.source] ?? 0) + 1;
      }
    }
    if (q.type === "true_false" && r.correctAnswer) {
      summary.trueFalse += 1;
      if (r.correctAnswer === "True") summary.trueFalseTrue += 1;
      if (r.warnings.includes("target_unreachable")) summary.targetMissed += 1;
      summary.trueFalseItems.push({
        question: q.question,
        answer: r.correctAnswer,
        inputs: r.verification.inputs ?? {},
      });
    }
  }
}

export const emptyFlowASummary = (): FlowASummary => ({
  questions: 0,
  computable: 0,
  computed: 0,
  disagree: 0,
  couldntCompute: 0,
  failed: 0,
  denied: 0,
  singleChoice: 0,
  fourOptions: 0,
  distinctInputs: 0,
  trueFalse: 0,
  trueFalseTrue: 0,
  targetMissed: 0,
  trueFalseItems: [],
  concept: 0,
  conceptNotation: 0,
  classifiedCalculation: 0,
  sources: {},
  failures: {},
});
