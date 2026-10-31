import { z } from "zod";
import { Verification } from "./quiz.ts";
import { DEFAULT_SAMPLING, VerifyRunStatus, VerifySampling, VerifyValue } from "./verify.ts";

/** L7 results (SPEC §3A.3.1, P2.1.md §4–§5), shared by the engine, the API and the web app. */

export const VerifySettings = z.object({
  /** Blocks publishing a proctored test while a computable question isn't `computed` (SPEC §3A.3.1). */
  proctoredGate: z.boolean(),
  /** The parent exits after this many runs. */
  recycleEvery: z.number().int().min(1).max(100_000),
  distractorCount: z.number().int().min(1).max(8),
  /** Relative, for float answers. */
  numericTolerance: z.number().min(0).max(1),
  sampling: VerifySampling,
});
export type VerifySettings = z.infer<typeof VerifySettings>;

export const DEFAULT_VERIFY_SETTINGS: VerifySettings = {
  proctoredGate: true,
  recycleEvery: 500,
  distractorCount: 3,
  numericTolerance: 1e-6,
  sampling: DEFAULT_SAMPLING,
};

/** The modules the prompts list (SPEC §3A.3.1, "Libraries"). */
export const ALLOWED_IMPORTS = "fractions, itertools, math, numpy, operator, statistics, sympy";

/** Flow B's six outcomes (SPEC §3A.3.1), plus a sandbox denial, which fails the question. */
export const FLOW_B_OUTCOMES = [
  "verified",
  "wrong_answer",
  "no_match",
  "ambiguous",
  "couldnt_check",
  "not_computable",
  "denied",
] as const;
export const FlowBOutcome = z.enum(FLOW_B_OUTCOMES);
export type FlowBOutcome = z.infer<typeof FlowBOutcome>;

export const L7_REASONS = [
  "ok",
  "wrong_answer",
  "no_match",
  "ambiguous",
  "program_failed",
  "program_timeout",
  "option_unparseable",
  "comparison_guard",
  "comparison_symbolic",
  "no_program",
  "not_computable",
  "model_agreed",
  "model_disagreed",
  "invalid_question",
  "programs_disagree",
  "constraint_unmet",
  "constraint_error",
  "source_not_in_quote",
  "source_unparseable",
  "target_unreachable",
  "not_computable_type",
  "sandbox_denial",
  "calculation_as_concept",
  "llm_failed",
] as const;
export const L7Reason = z.enum(L7_REASONS);
export type L7Reason = z.infer<typeof L7Reason>;

export const VerificationProgram = z.object({
  program: z.string(),
  status: VerifyRunStatus,
  result: VerifyValue.nullable(),
  error: z.string().nullable(),
  repaired: z.boolean(),
});
export type VerificationProgram = z.infer<typeof VerificationProgram>;

/** One question's result in a job. */
export const VerificationItem = z.object({
  questionId: z.number().int(),
  outcome: FlowBOutcome,
  reason: L7Reason,
  computable: z.boolean(),
  blind: VerificationProgram.nullable(),
  matchedOption: z.string().nullable(),
  /** A suggestion only: applied when the creator confirms it, never by itself (SPEC §3A.3.1). */
  suggestedFix: z.string().nullable(),
  verification: Verification,
});
export type VerificationItem = z.infer<typeof VerificationItem>;

export const VerificationSummary = z.object({
  total: z.number().int(),
  done: z.number().int(),
  counts: z.partialRecord(FlowBOutcome, z.number().int()),
});
export type VerificationSummary = z.infer<typeof VerificationSummary>;

export const PROCTOR_BLOCKERS = ["not_verified", "unverified", "failed", "model_agreed"] as const;
export const ProctorBlocker = z.object({ questionId: z.number().int(), reason: z.enum(PROCTOR_BLOCKERS) });
export type ProctorBlocker = z.infer<typeof ProctorBlocker>;
