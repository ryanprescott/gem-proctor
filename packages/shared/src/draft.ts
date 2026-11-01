import { z } from "zod";
import { QuestionType, Verification } from "./quiz.ts";
import { L7Reason, VerificationProgram } from "./verification.ts";

/** A question in review (SPEC §3A.1, §10 `DraftQuestion.content`), and what the layers say about it. */

export const DRAFT_STATUSES = ["proposed", "accepted", "rejected", "locked"] as const;
export const DraftStatus = z.enum(DRAFT_STATUSES);
export type DraftStatus = z.infer<typeof DraftStatus>;

export const QUESTION_EVENT_KINDS = [
  "generated",
  "regenerated",
  "edited",
  "accepted",
  "rejected",
  "locked",
  "fix_accepted",
  "answer_computed",
  "reclassified",
] as const;
export const QuestionEventKind = z.enum(QUESTION_EVENT_KINDS);
export type QuestionEventKind = z.infer<typeof QuestionEventKind>;

export const VALIDATION_LAYERS = ["L1", "L2", "L3", "L7"] as const;
export const ValidationLayer = z.enum(VALIDATION_LAYERS);
export type ValidationLayer = z.infer<typeof ValidationLayer>;

export const VALIDATION_OUTCOMES = ["pass", "warn", "fail"] as const;
export const ValidationOutcome = z.enum(VALIDATION_OUTCOMES);
export type ValidationOutcome = z.infer<typeof ValidationOutcome>;

export const VALIDATION_ISSUES = [
  // L1
  "multiple_correct",
  "no_correct",
  "too_few_correct",
  "options_not_unique",
  "objective_unknown",
  "chunk_unknown",
  "program_missing",
  "not_computable_type",
  "options_from_model",
  "mistakes_count",
  "placeholder_undeclared",
  "input_unused",
  "no_placeholders",
  "number_outside_placeholder",
  "source_not_in_quote",
  "true_false_options",
  "not_one_true",
  "answer_missing",
  // L2
  "quote_empty",
  "quote_not_found",
  // L3
  "answer_in_question",
  "longest_always_correct",
  "all_or_none_of_above",
  "text_too_long",
  "number_in_explanation",
] as const;
export const ValidationIssueCode = z.enum(VALIDATION_ISSUES);
export type ValidationIssueCode = z.infer<typeof ValidationIssueCode>;

export const ValidationIssue = z.object({
  code: ValidationIssueCode,
  severity: z.enum(["warn", "fail"]),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
});
export type ValidationIssue = z.infer<typeof ValidationIssue>;

export const LayerResult = z.object({
  layer: ValidationLayer,
  outcome: ValidationOutcome,
  issues: z.array(ValidationIssue),
  /** L7 says why in one code: the outcome tables' reason (SPEC §3A.3.1). */
  reason: L7Reason.optional(),
});
export type LayerResult = z.infer<typeof LayerResult>;

/** A check's one outcome: the worst of its issues. */
export function layerResult(layer: ValidationLayer, issues: ValidationIssue[]): LayerResult {
  const outcome = issues.some((i) => i.severity === "fail") ? "fail" : issues.length > 0 ? "warn" : "pass";
  return { layer, outcome, issues };
}

export const DraftEvidence = z.object({
  sourceId: z.string(),
  chunkId: z.string(),
  chunkKey: z.string(),
  quote: z.string(),
});
export type DraftEvidence = z.infer<typeof DraftEvidence>;

export const DraftOption = z.object({
  text: z.string(),
  isCorrect: z.boolean(),
  /** Shown to the creator. Never sent to students by itself (P2.md §5). */
  whyWrong: z.string().optional(),
});
export type DraftOption = z.infer<typeof DraftOption>;

export const DraftInput = z.object({
  name: z.string(),
  kind: z.enum(["integer", "rational", "vector", "matrix"]),
  size: z.array(z.number().int()),
  from: z.enum(["source", "sample"]),
  sourceText: z.string(),
});

export const DraftMistake = z.object({ whyWrong: z.string(), program: z.string() });

/** L7's state for a question: what the creator needs to read both programs, and to act on the result. */
export const DraftL7 = z.object({
  flow: z.enum(["a", "b", "notation"]),
  outcome: z.string(),
  reason: z.string(),
  author: VerificationProgram.nullable(),
  blind: VerificationProgram.nullable(),
  /** Flow B: a suggestion only, applied when the creator confirms it. */
  suggestedFix: z.string().nullable(),
});
export type DraftL7 = z.infer<typeof DraftL7>;

export const DraftContent = z.object({
  type: QuestionType,
  topic: z.string(),
  computable: z.boolean(),
  objectiveIds: z.array(z.string()),
  /** As written: a computable question keeps its `{placeholders}`. */
  template: z.string(),
  /** With values filled in, once L7 has them. Students see this. */
  question: z.string().nullable(),
  options: z.array(DraftOption).nullable(),
  correctAnswer: z.string().nullable(),
  correctAnswers: z.array(z.string()).optional(),
  acceptedAnswers: z.array(z.string()).optional(),
  numericTolerance: z.number().nullable(),
  explanation: z.string(),
  evidence: z.array(DraftEvidence),
  inputs: z.array(DraftInput),
  constraint: z.string(),
  answerProgram: z.string(),
  mistakes: z.array(DraftMistake),
  verification: Verification.nullable(),
  l7: DraftL7.nullable(),
  /** An L7 job is queued or running: it can't be accepted yet. */
  l7Pending: z.boolean(),
  provenance: z.enum(["llm", "llm_edited", "human"]),
  /** Provenance of the call that wrote it. */
  callLogId: z.string().nullable(),
  promptVersion: z.string().nullable(),
  model: z.string().nullable(),
});
export type DraftContent = z.infer<typeof DraftContent>;
