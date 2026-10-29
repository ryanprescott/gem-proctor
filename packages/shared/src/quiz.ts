import { z } from "zod";

// ── Base (exactly SPEC §2.1) ─────────────────────────────────────────
// Base field names are fixed; everything added later is optional and camelCase (§2.3).

export const baseQuestionShape = {
  id: z.number().int().positive().describe("1-based, unique within the quiz"),
  topic: z.string().describe("Per-question topic"),
  question: z.string().describe("Markdown with $...$ LaTeX"),
  options: z.array(z.string()).min(2).optional().describe("Answer options; present on choice questions"),
  correctAnswer: z.string().describe("Choice questions: exactly one of `options`"),
};

export const BaseQuestion = z.object(baseQuestionShape);
export type BaseQuestion = z.infer<typeof BaseQuestion>;

export const baseQuizShape = {
  quiz_title: z.string(),
  course: z.string().optional(),
  chapter: z.number().int().optional(),
  total_questions: z.number().int(),
  topics_covered: z.array(z.string()).optional(),
  questions: z.array(BaseQuestion).min(1),
};

export const BaseQuiz = z.object(baseQuizShape);
export type BaseQuiz = z.infer<typeof BaseQuiz>;

// ── Extensions (SPEC §4) ─────────────────────────────────────────────

export const QUESTION_TYPES = ["short_answer", "single_choice", "multi_choice", "numeric", "true_false"] as const;
export const QuestionType = z.enum(QUESTION_TYPES);
export type QuestionType = z.infer<typeof QuestionType>;

export const TEST_TYPES = ["chapter_quiz", "homework", "unit_test", "midterm", "final", "custom"] as const;
export const TestType = z.enum(TEST_TYPES);
export type TestType = z.infer<typeof TestType>;

export const Evidence = z.object({ sourceId: z.string(), chunkId: z.string(), quote: z.string() });
export type Evidence = z.infer<typeof Evidence>;

export const Verification = z.object({
  status: z.enum(["computed", "model_agreed", "unverified", "failed"]),
  answerSource: z.enum(["computed", "stated"]).optional(),
  program: z.string().optional(),
  authorProgram: z.string().optional(),
  modelClaim: z.string().optional(),
  inputs: z.record(z.string(), z.string()).optional(),
  seed: z.string().optional(),
  distractors: z
    .array(
      z.object({
        text: z.string(),
        source: z.enum(["common", "near", "random"]),
        reason: z.string(),
        program: z.string().optional(),
      }),
    )
    .optional(),
  result: z.string().optional(),
  matchedOption: z.string().optional(),
  checkedAt: z.iso.datetime().optional(),
});
export type Verification = z.infer<typeof Verification>;

export const questionShape = {
  ...baseQuestionShape,
  type: QuestionType.optional().describe("Inferred if absent: options → single_choice, else short_answer"),
  correctAnswers: z.array(z.string()).optional().describe("multi_choice only; correctAnswer = first"),
  acceptedAnswers: z.array(z.string()).optional(),
  caseSensitive: z.boolean().optional(),
  numericTolerance: z.number().optional(),
  explanation: z.string().optional(),
  points: z.number().positive().optional(),
  objectiveIds: z.array(z.string()).optional(),
  evidence: z.array(Evidence).optional(),
  provenance: z.enum(["llm", "human", "imported", "llm_edited"]).optional(),
  computable: z.boolean().optional(),
  verification: Verification.optional(),
};

export const QuestionShape = z.object(questionShape);
export type Question = z.infer<typeof QuestionShape>;

export const quizShape = {
  ...baseQuizShape,
  questions: z.array(QuestionShape).min(1),
  chapters: z.array(z.number().int()).optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  testType: TestType.optional(),
  formatVersion: z.literal(1).optional(),
};

export const QuizShape = z.object(quizShape);

export const answeredQuestionShape = {
  ...questionShape,
  userAnswer: z.string(),
  userAnswers: z.array(z.string()).optional(),
  userIsCorrect: z.boolean(),
  pointsAwarded: z.number().optional(),
  needsReview: z.boolean().optional(),
  graderComment: z.string().optional(),
};

export const AnsweredQuestionShape = z.object(answeredQuestionShape);
export type AnsweredQuestion = z.infer<typeof AnsweredQuestionShape>;

export const resultShape = {
  ...quizShape,
  questions: z.array(AnsweredQuestionShape).min(1),
  score: z.number(),
  percentage: z.number(),
  maxScore: z.number().optional(),
  attemptId: z.string().optional(),
  mode: z.enum(["practice", "proctored"]).optional(),
  startedAt: z.iso.datetime().optional(),
  submittedAt: z.iso.datetime().optional(),
};

export const ResultShape = z.object(resultShape);

// ── Cross-field checks (SPEC §4, superRefine) ────────────────────────

export const QUIZ_ISSUE_CODES = [
  // errors
  "duplicate_question_id",
  "answer_not_in_options",
  "correct_answers_not_in_options",
  "duplicate_options",
  "options_required",
  "options_not_allowed",
  "true_false_options",
  "chapters_mismatch",
  "single_choice_one_answer",
  "multi_choice_needs_answer",
  "numeric_not_a_number",
  // warnings (recomputed values win)
  "total_questions_mismatch",
  "score_mismatch",
  "percentage_mismatch",
  // structural (from Zod's own issues)
  "schema_invalid_type",
  "schema_too_small",
  "schema_too_big",
  "schema_invalid_value",
  "schema_invalid_format",
  "schema_unrecognized_keys",
  "schema_other",
  // input
  "parse_failed",
] as const;
export const QuizIssueCode = z.enum(QUIZ_ISSUE_CODES);
export type QuizIssueCode = z.infer<typeof QuizIssueCode>;

export const IssueParams = z.record(z.string(), z.union([z.string(), z.number()]));
export type IssueParams = z.infer<typeof IssueParams>;

export const QuizIssue = z.object({
  severity: z.enum(["error", "warning"]),
  code: QuizIssueCode,
  path: z.array(z.union([z.string(), z.number()])),
  params: IssueParams,
});
export type QuizIssue = z.infer<typeof QuizIssue>;

export const TRUE_FALSE_OPTIONS = ["True", "False"] as const;

export function effectiveType(q: Pick<Question, "type" | "options">): QuestionType {
  return q.type ?? (q.options ? "single_choice" : "short_answer");
}

const CHOICE_TYPES: ReadonlySet<QuestionType> = new Set(["single_choice", "multi_choice", "true_false"]);

export function isChoiceType(t: QuestionType): boolean {
  return CHOICE_TYPES.has(t);
}

export function parsesAsNumber(s: string): boolean {
  const t = s.trim();
  return t !== "" && Number.isFinite(Number(t));
}

type CheckableQuestion = Pick<Question, "id" | "type" | "options" | "correctAnswer" | "correctAnswers">;
type CheckableQuiz = {
  chapter?: number | undefined;
  chapters?: number[] | undefined;
  questions: CheckableQuestion[];
};

/** Error-level cross-field checks. Used by `Quiz`/`Result` superRefine and the import report. */
export function crossFieldErrors(quiz: CheckableQuiz): QuizIssue[] {
  const issues: QuizIssue[] = [];
  const err = (code: QuizIssueCode, path: QuizIssue["path"], params: IssueParams = {}) =>
    issues.push({ severity: "error", code, path, params });

  const seen = new Set<number>();
  quiz.questions.forEach((q, i) => {
    if (seen.has(q.id)) err("duplicate_question_id", ["questions", i, "id"], { id: q.id });
    seen.add(q.id);

    const type = effectiveType(q);
    const base = ["questions", i] as const;

    if (q.options) {
      if (!isChoiceType(type)) {
        err("options_not_allowed", [...base, "options"], { id: q.id, type });
      }
      const optionSet = new Set<string>();
      for (const o of q.options) {
        if (optionSet.has(o)) err("duplicate_options", [...base, "options"], { id: q.id, option: o });
        optionSet.add(o);
      }
      if (!optionSet.has(q.correctAnswer)) {
        err("answer_not_in_options", [...base, "correctAnswer"], { id: q.id, answer: q.correctAnswer });
      }
      for (const [j, a] of (q.correctAnswers ?? []).entries()) {
        if (!optionSet.has(a)) {
          err("correct_answers_not_in_options", [...base, "correctAnswers", j], { id: q.id, answer: a });
        }
      }
    } else if (isChoiceType(type)) {
      err("options_required", [...base, "options"], { id: q.id, type });
    }

    if (type === "true_false" && q.options) {
      const ok = q.options.length === 2 && q.options[0] === "True" && q.options[1] === "False";
      if (!ok) err("true_false_options", [...base, "options"], { id: q.id });
    }

    if (type === "single_choice" && q.correctAnswers) {
      const ok = q.correctAnswers.length === 1 && q.correctAnswers[0] === q.correctAnswer;
      if (!ok) err("single_choice_one_answer", [...base, "correctAnswers"], { id: q.id });
    }

    if (type === "multi_choice") {
      const answers = q.correctAnswers ?? [q.correctAnswer];
      if (answers.length < 1 || answers[0] !== q.correctAnswer) {
        err("multi_choice_needs_answer", [...base, "correctAnswers"], { id: q.id });
      }
    }

    if (type === "numeric" && !parsesAsNumber(q.correctAnswer)) {
      err("numeric_not_a_number", [...base, "correctAnswer"], { id: q.id, answer: q.correctAnswer });
    }
  });

  if (quiz.chapter !== undefined && quiz.chapters !== undefined) {
    const ok = quiz.chapters.length === 1 && quiz.chapters[0] === quiz.chapter;
    if (!ok) err("chapters_mismatch", ["chapters"], { chapter: quiz.chapter });
  }
  return issues;
}

/** Warning-level checks: derived values that the server recomputes (SPEC §2.3). */
export function derivedValueWarnings(quiz: { total_questions?: unknown; questions: unknown[] }): QuizIssue[] {
  const issues: QuizIssue[] = [];
  if (quiz.total_questions !== quiz.questions.length) {
    issues.push({
      severity: "warning",
      code: "total_questions_mismatch",
      path: ["total_questions"],
      params: {
        stated: typeof quiz.total_questions === "number" ? quiz.total_questions : String(quiz.total_questions),
        actual: quiz.questions.length,
      },
    });
  }
  return issues;
}

function refineWith(issues: QuizIssue[], ctx: z.RefinementCtx) {
  for (const issue of issues) {
    ctx.addIssue({
      code: "custom",
      message: issue.code,
      path: issue.path,
      params: { issue: issue.code, ...issue.params },
    });
  }
}

export const Question = QuestionShape;

/** The extended quiz with every cross-field error check. */
export const Quiz = QuizShape.superRefine((quiz, ctx) => refineWith(crossFieldErrors(quiz), ctx));
export type Quiz = z.infer<typeof QuizShape>;

export const AnsweredQuestion = AnsweredQuestionShape;

export const Result = ResultShape.superRefine((r, ctx) => refineWith(crossFieldErrors(r), ctx));
export type Result = z.infer<typeof ResultShape>;

/** Map Zod issues (structural or ours) to report issues with stable codes. */
export function zodIssuesToQuizIssues(error: z.ZodError): QuizIssue[] {
  return error.issues.map((i): QuizIssue => {
    const path = i.path.filter((p): p is string | number => typeof p !== "symbol");
    if (i.code === "custom") {
      const params = { ...(i.params ?? {}) } as Record<string, unknown>;
      const parsed = QuizIssueCode.safeParse(params.issue);
      delete params.issue;
      const clean: IssueParams = {};
      for (const [k, v] of Object.entries(params)) {
        if (typeof v === "string" || typeof v === "number") clean[k] = v;
      }
      return { severity: "error", code: parsed.success ? parsed.data : "schema_other", path, params: clean };
    }
    const params: IssueParams = {};
    switch (i.code) {
      case "invalid_type":
        params.expected = String(i.expected);
        return { severity: "error", code: "schema_invalid_type", path, params };
      case "too_small":
        params.minimum = Number(i.minimum);
        return { severity: "error", code: "schema_too_small", path, params };
      case "too_big":
        params.maximum = Number(i.maximum);
        return { severity: "error", code: "schema_too_big", path, params };
      case "invalid_value":
        params.expected = i.values.map(String).join(", ");
        return { severity: "error", code: "schema_invalid_value", path, params };
      case "invalid_format":
        params.format = i.format;
        return { severity: "error", code: "schema_invalid_format", path, params };
      case "unrecognized_keys":
        params.keys = i.keys.join(", ");
        return { severity: "error", code: "schema_unrecognized_keys", path, params };
      default:
        return { severity: "error", code: "schema_other", path, params };
    }
  });
}
