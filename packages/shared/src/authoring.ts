import { z } from "zod";
import { QuestionType, TEST_TYPES, TestType } from "./quiz.ts";

/** Authoring sessions, objectives and blueprints (SPEC §3A.1, §3A.1.1, P2.md §5). */

export const AUTHORING_STATUSES = ["draft", "generating", "review", "published"] as const;
export const AuthoringStatus = z.enum(AUTHORING_STATUSES);
export type AuthoringStatus = z.infer<typeof AuthoringStatus>;

export const OBJECTIVE_ORIGINS = ["llm", "human", "heading"] as const;
export const ObjectiveOrigin = z.enum(OBJECTIVE_ORIGINS);
export type ObjectiveOrigin = z.infer<typeof ObjectiveOrigin>;

export const SPREADS = ["even", "proportional"] as const;
export const Spread = z.enum(SPREADS);
export type Spread = z.infer<typeof Spread>;

export type QuestionMix = Partial<Record<QuestionType, number>>;

export interface TestTypePreset {
  /** The default length (SPEC §3A.1.1 gives ranges; this is the middle). */
  length: number;
  /** Shares of the length, by type. */
  mix: QuestionMix;
  spread: Spread;
}

const MIXED: QuestionMix = {
  single_choice: 0.5,
  numeric: 0.2,
  short_answer: 0.15,
  true_false: 0.1,
  multi_choice: 0.05,
};

/** Presets are defaults: every value can change (SPEC §3A.1.1). `custom` starts from a plain single-choice quiz. */
export const TEST_TYPE_PRESETS: Record<TestType, TestTypePreset> = {
  chapter_quiz: { length: 10, mix: { single_choice: 0.8, true_false: 0.1, numeric: 0.1 }, spread: "even" },
  homework: { length: 12, mix: { numeric: 0.4, short_answer: 0.4, single_choice: 0.2 }, spread: "even" },
  unit_test: { length: 22, mix: MIXED, spread: "proportional" },
  midterm: { length: 35, mix: MIXED, spread: "proportional" },
  final: { length: 45, mix: MIXED, spread: "proportional" },
  custom: { length: 10, mix: { single_choice: 1 }, spread: "even" },
};

/**
 * Whole numbers that add up to `total`, in proportion to `weights`, by largest remainder. With `minimum`, each entry
 * gets that first, when `total` allows it. Deterministic: ties go to the earlier entry.
 */
export function spreadCounts(total: number, weights: readonly number[], minimum = 0): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const floor = minimum * n <= total ? minimum : 0;
  const rest = total - floor * n;
  const sum = weights.reduce((a, b) => a + Math.max(b, 0), 0);
  const shares = weights.map((w) => (sum > 0 ? (Math.max(w, 0) / sum) * rest : rest / n));
  const counts = shares.map(Math.floor);
  const order = shares
    .map((s, i) => ({ i, left: s - Math.floor(s) }))
    .sort((a, b) => b.left - a.left || a.i - b.i)
    .map((e) => e.i);
  let missing = rest - counts.reduce((a, b) => a + b, 0);
  for (const i of order) {
    if (missing <= 0) break;
    counts[i] = (counts[i] as number) + 1;
    missing -= 1;
  }
  return counts.map((c) => c + floor);
}

/** The preset's shares as counts that add up to `total`. Order is the fixed type order, so it's deterministic. */
export function mixCounts(total: number, mix: QuestionMix): QuestionMix {
  const types = QuestionType.options.filter((t) => (mix[t] ?? 0) > 0);
  const counts = spreadCounts(
    total,
    types.map((t) => mix[t] as number),
  );
  return Object.fromEntries(types.map((t, i) => [t, counts[i] as number]).filter(([, c]) => (c as number) > 0));
}

export const ObjectiveTarget = z.object({ objectiveId: z.string(), count: z.number().int().min(0).max(500) });

export const Blueprint = z.object({
  testType: TestType,
  questionCount: z.number().int().min(1).max(500),
  mix: z.partialRecord(QuestionType, z.number().int().min(0).max(500)),
  spread: Spread,
  perObjective: z.array(ObjectiveTarget),
  /** The test type's style line, editable. Empty for `custom`. */
  style: z.string().max(600),
  /** What the creator adds: "no questions on §1.4", "include 3 applied word problems". */
  constraints: z.string().max(2000),
  /** The style lines' prompt version (SPEC §3A.1.1). */
  styleVersion: z.string(),
});
export type Blueprint = z.infer<typeof Blueprint>;

/** The blueprint's own sums, so a bad one is refused before anything is generated. */
export function blueprintProblems(b: Blueprint): ("mix_sum" | "objective_sum")[] {
  const problems: ("mix_sum" | "objective_sum")[] = [];
  const mix = Object.values(b.mix).reduce((n, c) => n + (c ?? 0), 0);
  if (mix !== b.questionCount) problems.push("mix_sum");
  const per = b.perObjective.reduce((n, o) => n + o.count, 0);
  if (per !== b.questionCount) problems.push("objective_sum");
  return problems;
}

export interface ObjectiveWeight {
  id: string;
  /** Tokens of the selected text behind it. */
  tokens: number;
}

/**
 * A test type's defaults for these objectives (SPEC §3A.1.1). `even` gives each the same share; `proportional` goes by
 * token count, with at least one question each.
 */
export function defaultBlueprint(
  testType: TestType,
  objectives: readonly ObjectiveWeight[],
  style: { line: string; version: string },
): Blueprint {
  const preset = TEST_TYPE_PRESETS[testType];
  const weights = objectives.map((o) => (preset.spread === "even" ? 1 : o.tokens));
  const counts = spreadCounts(preset.length, weights, 1);
  return {
    testType,
    questionCount: preset.length,
    mix: mixCounts(preset.length, preset.mix),
    spread: preset.spread,
    perObjective: objectives.map((o, i) => ({ objectiveId: o.id, count: counts[i] as number })),
    style: style.line,
    constraints: "",
    styleVersion: style.version,
  };
}

export const AUTHORING_TEST_TYPES = TEST_TYPES;

/** What `authoring.objectives` returns for one section (`objectives-v1`). Chunks are cited by key, as they were sent. */
export const ObjectiveProposal = z.object({
  objectives: z
    .array(
      z.object({
        label: z.string().max(120),
        description: z.string().max(300),
        chunkIds: z.array(z.string()).min(1).max(12),
      }),
    )
    .max(8),
});
export type ObjectiveProposal = z.infer<typeof ObjectiveProposal>;
