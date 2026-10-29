import {
  type AnsweredQuestion,
  effectiveType,
  parseNumericAnswer,
  type Question,
  type Quiz,
  type QuizIssue,
  type Result,
} from "./quiz.ts";

/** One response to one question, keyed by the question's `id` (SPEC §2.3). */
export interface QuestionResponse {
  questionId: number;
  /** A single answer, or the selected options for `multi_choice`. */
  answer: string | string[];
  /** A stored grade (practice export, P1.md §5): used as is instead of grading again. */
  grade?: Pick<Grade, "outcome" | "pointsAwarded">;
  /** "I was right" on a short answer: counts as correct with full points (SPEC §7.2). */
  selfGraded?: boolean;
}

const UNIFY: [RegExp, string][] = [
  [/[\u2212\u2012\u2013\u2014\u2010\u2011]/g, "-"],
  [/[\u201C\u201D\u201E\u201F\u00AB\u00BB]/g, '"'],
  [/[\u2018\u2019\u201A\u201B\u2032]/g, "'"],
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** NFKC, minus signs and quotes unified, whitespace collapsed and stripped around operators. */
function canonicalText(s: string): string {
  let t = s.normalize("NFKC");
  for (const [re, to] of UNIFY) t = t.replace(re, to);
  return t
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*([[\](),^_+\-*/])\s*/g, "$1");
}

/**
 * Short-answer normalization (SPEC §7.2): NFKC; minus signs and quotes unified; whitespace trimmed, collapsed
 * and removed around `[ ] , ( ) ^ _ + - * /`; case folded unless `caseSensitive`; then trailing words from
 * `ignoreWords` (each separated from the answer by whitespace, normalized the same way) stripped.
 */
export function normalizeShortAnswer(s: string, caseSensitive = false, ignoreWords: readonly string[] = []): string {
  const fold = (x: string) => (caseSensitive ? x : x.toLowerCase());
  let t = fold(canonicalText(s));
  const words = ignoreWords.map((w) => fold(canonicalText(w))).filter((w) => w !== "");
  if (words.length === 0) return t;
  const re = new RegExp(`\\s(?:${words.map(escapeRegExp).join("|")})$`, "u");
  // Strip repeatedly, so "3 m s" with ["m", "s"] loses both.
  for (let prev = ""; prev !== t; ) {
    prev = t;
    t = t.replace(re, "").trimEnd();
  }
  return t;
}

export const GRADE_OUTCOMES = ["correct", "partial", "incorrect"] as const;
export type GradeOutcome = (typeof GRADE_OUTCOMES)[number];

export interface Grade {
  outcome: GradeOutcome;
  /** Rounded to two decimals, like `score` (SPEC §2.2). */
  pointsAwarded: number;
  maxPoints: number;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function numericMatch(given: number, expected: number, tolerance: number): boolean {
  const diff = Math.abs(given - expected);
  if (tolerance <= 0) return diff === 0;
  // |Δ| = tolerance is correct; allow for the binary representation of decimals (0.4 − 0.3 > 0.1).
  return diff - tolerance <= 4 * Number.EPSILON * Math.max(Math.abs(given), Math.abs(expected), tolerance);
}

/** The fraction of the points an answer earns, 0–1. Only `multi_choice` with proportional credit has values in between. */
function fraction(q: Question, answers: readonly string[]): number {
  switch (effectiveType(q)) {
    case "single_choice":
    case "true_false":
      return answers.length === 1 && answers[0] === q.correctAnswer ? 1 : 0;
    case "multi_choice": {
      const expected = new Set(q.correctAnswers ?? [q.correctAnswer]);
      const given = new Set(answers);
      const correctSelected = [...given].filter((a) => expected.has(a)).length;
      const wrongSelected = given.size - correctSelected;
      if (correctSelected === expected.size && wrongSelected === 0) return 1;
      if ((q.partialCredit ?? "all_or_nothing") === "all_or_nothing") return 0;
      return Math.max(0, (correctSelected - wrongSelected) / expected.size);
    }
    case "numeric": {
      const given = parseNumericAnswer(answers[0] ?? "");
      const expected = parseNumericAnswer(q.correctAnswer);
      if (answers.length !== 1 || given === null || expected === null) return 0;
      return numericMatch(given, expected, q.numericTolerance ?? 0) ? 1 : 0;
    }
    case "short_answer": {
      if (answers.length !== 1) return 0;
      const cs = q.caseSensitive ?? false;
      const ignore = q.ignoreWords ?? [];
      const given = normalizeShortAnswer(answers[0] ?? "", cs, ignore);
      if (given === "") return 0;
      return [q.correctAnswer, ...(q.acceptedAnswers ?? [])].some((a) => normalizeShortAnswer(a, cs, ignore) === given)
        ? 1
        : 0;
    }
  }
}

/**
 * Auto-grade one response (SPEC §7.1, P1 §5). Exact comparison per type: an answer is never snapped to a
 * nearby option. `multi_choice` with `partialCredit: "proportional"` earns
 * `points × max(0, (correctSelected − wrongSelected) / |correctAnswers|)`. No answer scores 0.
 */
export function gradeResponse(q: Question, answer: string | readonly string[] | null | undefined): Grade {
  const maxPoints = q.points ?? 1;
  const answers = answer === null || answer === undefined ? [] : typeof answer === "string" ? [answer] : answer;
  const f = answers.length === 0 ? 0 : fraction(q, answers);
  const pointsAwarded = f >= 1 ? maxPoints : round2(maxPoints * f);
  const outcome: GradeOutcome = pointsAwarded >= maxPoints ? "correct" : pointsAwarded > 0 ? "partial" : "incorrect";
  return { outcome, pointsAwarded, maxPoints };
}

/** Auto-grade one question (SPEC §7.1). Returns whether the answer is fully correct. */
export function gradeQuestion(q: Question, answer: string | readonly string[]): boolean {
  return gradeResponse(q, answer).outcome === "correct";
}

/**
 * Build a `Result` (SPEC §2.2): the same quiz plus one attempt. `score` and `percentage` are always
 * recomputed here. Questions without a response get an empty answer and are marked incorrect. Responses
 * are graded with `gradeResponse` unless they carry a stored `grade`.
 */
export function toResult(
  quiz: Quiz,
  responses: readonly QuestionResponse[],
  meta: Pick<Result, "attemptId" | "mode" | "startedAt" | "submittedAt"> = {},
): Result {
  const byId = new Map(responses.map((r) => [r.questionId, r]));
  let score = 0;
  let maxScore = 0;
  const weighted = quiz.questions.some((q) => (q.points ?? 1) !== 1);
  const questions: AnsweredQuestion[] = quiz.questions.map((q) => {
    const points = q.points ?? 1;
    maxScore += points;
    const response = byId.get(q.id);
    const answer = response?.answer;
    const grade = response?.selfGraded
      ? { outcome: "correct" as const, pointsAwarded: points }
      : (response?.grade ?? gradeResponse(q, answer));
    const correct = grade.outcome === "correct";
    const awarded = grade.pointsAwarded;
    score += awarded;
    const out: AnsweredQuestion = {
      ...q,
      userAnswer: Array.isArray(answer) ? answer.join(", ") : (answer ?? ""),
      userIsCorrect: correct,
    };
    if (Array.isArray(answer)) out.userAnswers = [...answer];
    if (response?.selfGraded) out.selfGraded = true;
    // Partial credit can't be read from `userIsCorrect`, so it's always written out.
    if (weighted || grade.outcome === "partial") out.pointsAwarded = awarded;
    return out;
  });
  const result: Result = {
    ...quiz,
    total_questions: questions.length,
    questions,
    score: round2(score),
    percentage: maxScore === 0 ? 0 : round2((score / maxScore) * 100),
    ...meta,
  };
  if (weighted) result.maxScore = round2(maxScore);
  return result;
}

/** Recomputed `score` / `percentage` for a result; a mismatch is a warning and the recomputed values win (SPEC §2.3). */
export function recomputeScore(result: Pick<Result, "questions">): {
  score: number;
  percentage: number;
  maxScore: number;
} {
  let score = 0;
  let maxScore = 0;
  for (const q of result.questions) {
    const points = q.points ?? 1;
    maxScore += points;
    score += q.pointsAwarded ?? (q.userIsCorrect ? points : 0);
  }
  return { score: round2(score), percentage: maxScore === 0 ? 0 : round2((score / maxScore) * 100), maxScore };
}

export function resultWarnings(result: Pick<Result, "questions" | "score" | "percentage">): QuizIssue[] {
  const r = recomputeScore(result);
  const issues: QuizIssue[] = [];
  if (r.score !== result.score) {
    issues.push({
      severity: "warning",
      code: "score_mismatch",
      path: ["score"],
      params: { stated: result.score, actual: r.score },
    });
  }
  if (r.percentage !== result.percentage) {
    issues.push({
      severity: "warning",
      code: "percentage_mismatch",
      path: ["percentage"],
      params: { stated: result.percentage, actual: r.percentage },
    });
  }
  return issues;
}
