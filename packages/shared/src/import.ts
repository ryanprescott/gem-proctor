import { z } from "zod";
import { NormalizationFix, normalizeQuiz } from "./normalize.ts";
import { derivedValueWarnings, Quiz, QuizIssue, type QuizIssue as QuizIssueT, zodIssuesToQuizIssues } from "./quiz.ts";

/** The import report (SPEC §3D.1 step 5). No L7 in P0. */
export const ImportReport = z.object({
  fixes: z.array(NormalizationFix),
  errors: z.array(QuizIssue),
  warnings: z.array(QuizIssue),
  canSave: z.boolean(),
  questionCount: z.number().int(),
  /** Set on save, when a verification job's results went on the questions (SPEC §3D.1 step 5). */
  verification: z
    .object({
      jobId: z.string(),
      acceptedFixes: z.array(z.object({ questionId: z.number().int(), from: z.string(), to: z.string() })),
    })
    .optional(),
});
export type ImportReport = z.infer<typeof ImportReport>;

export interface ImportAnalysis {
  /** The normalized value, if any JSON could be recovered (shown in the editor). */
  value: unknown;
  /** The validated quiz, when there are no errors. */
  quiz: Quiz | null;
  report: ImportReport;
}

/** normalize → validate → report; nothing is saved (SPEC §3D.1 steps 2–5). */
export function analyzeImport(
  text: string,
  opts: { title?: string; transform?: (value: unknown) => unknown } = {},
): ImportAnalysis {
  const normalized = normalizeQuiz(text, opts);
  const { fixes } = normalized;
  // After normalization and before validation: a fix the creator confirmed is what makes a question valid.
  const value = normalized.value !== undefined && opts.transform ? opts.transform(normalized.value) : normalized.value;
  if (value === undefined) {
    return {
      value,
      quiz: null,
      report: {
        fixes,
        errors: [{ severity: "error", code: "parse_failed", path: [], params: {} }],
        warnings: [],
        canSave: false,
        questionCount: 0,
      },
    };
  }
  // Fix-level warnings (truncation, renumbering, recomputed totals) are fixes with severity "warning".
  const warnings: QuizIssueT[] = [];
  const parsed = Quiz.safeParse(value);
  const questionCount =
    typeof value === "object" && value !== null && Array.isArray((value as { questions?: unknown }).questions)
      ? (value as { questions: unknown[] }).questions.length
      : 0;
  if (!parsed.success) {
    return {
      value,
      quiz: null,
      report: { fixes, errors: zodIssuesToQuizIssues(parsed.error), warnings, canSave: false, questionCount },
    };
  }
  warnings.push(...derivedValueWarnings(parsed.data));
  return { value, quiz: parsed.data, report: { fixes, errors: [], warnings, canSave: true, questionCount } };
}
