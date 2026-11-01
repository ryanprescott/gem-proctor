import type { Blueprint, QuestionType } from "@gem/shared";

/** How a blueprint becomes calls (SPEC §3A.2, P2.md §5): split by objective, a few questions per call. */

export interface BatchPlan {
  objectiveIds: string[];
  /** Questions of each type this call should write. */
  counts: Partial<Record<QuestionType, number>>;
  size: number;
}

/** What one question costs in output tokens, measured on the reference model at 330–375 (P1.5 live run), with room. */
const OUTPUT_TOKENS_PER_QUESTION = 2000;
const MIN_PER_CALL = 1;
const MAX_PER_CALL = 12;

/** 4 on the reference model's 8,192-token output budget. */
export const questionsPerCall = (maxOutputTokens: number) =>
  Math.min(MAX_PER_CALL, Math.max(MIN_PER_CALL, Math.floor(maxOutputTokens / OUTPUT_TOKENS_PER_QUESTION)));

/** The mix, one question at a time, taking turns between types, so each objective gets a share of each. */
function typeOrder(mix: Blueprint["mix"]): QuestionType[] {
  const left = new Map(Object.entries(mix).filter(([, n]) => (n ?? 0) > 0)) as Map<QuestionType, number>;
  const out: QuestionType[] = [];
  while (left.size > 0) {
    for (const [type, n] of left) {
      out.push(type);
      if (n <= 1) left.delete(type);
      else left.set(type, n - 1);
    }
  }
  return out;
}

export function planBatches(blueprint: Blueprint, perCall: number): BatchPlan[] {
  const types = typeOrder(blueprint.mix);
  let next = 0;
  const plans: BatchPlan[] = [];
  for (const { objectiveId, count } of blueprint.perObjective) {
    let left = count;
    while (left > 0) {
      const size = Math.min(left, perCall);
      const counts: BatchPlan["counts"] = {};
      for (let i = 0; i < size; i++) {
        const type = types[next++] ?? "single_choice";
        counts[type] = (counts[type] ?? 0) + 1;
      }
      plans.push({ objectiveIds: [objectiveId], counts, size });
      left -= size;
    }
  }
  return plans;
}

const NAMES: Record<QuestionType, string> = {
  single_choice: "single_choice",
  multi_choice: "multi_choice",
  numeric: "numeric",
  short_answer: "short_answer",
  true_false: "true_false",
};

/** "3 single_choice, 1 true_false": the request in the prompt, which the model reads literally. */
export const describeCounts = (counts: BatchPlan["counts"]) =>
  Object.entries(counts)
    .map(([type, n]) => `${n} ${NAMES[type as QuestionType]}`)
    .join(", ");
