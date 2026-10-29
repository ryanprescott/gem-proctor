import { type AnsweredQuestion, effectiveType, type Question, type Quiz, type QuizIssue, type Result } from "./quiz.ts";

/** One response to one question, keyed by the question's `id` (SPEC §2.3). */
export interface QuestionResponse {
  questionId: number;
  /** A single answer, or the selected options for `multi_choice`. */
  answer: string | string[];
}

/** Short-answer normalization (SPEC §7.2). */
export function normalizeShortAnswer(s: string, caseSensitive = false, ignoreWords: readonly string[] = []): string {
  let t = s
    .normalize("NFKC")
    .replace(/[−‒–—]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*([[\](),^_+\-*/])\s*/g, "$1");
  if (!caseSensitive) t = t.toLowerCase();
  for (const w of ignoreWords) {
    const re = new RegExp(`\\s*\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, caseSensitive ? "" : "i");
    t = t.replace(re, "");
  }
  return t;
}

/** Auto-grade one question (SPEC §7.1). Returns whether the answer is correct. */
export function gradeQuestion(q: Question, answer: string | string[]): boolean {
  const type = effectiveType(q);
  const answers = Array.isArray(answer) ? answer : [answer];
  switch (type) {
    case "single_choice":
    case "true_false":
      return answers.length === 1 && answers[0] === q.correctAnswer;
    case "multi_choice": {
      const expected = new Set(q.correctAnswers ?? [q.correctAnswer]);
      const given = new Set(answers);
      return expected.size === given.size && [...expected].every((a) => given.has(a));
    }
    case "numeric": {
      const given = Number(answers[0]?.trim());
      const expected = Number(q.correctAnswer.trim());
      if (!Number.isFinite(given) || !Number.isFinite(expected)) return false;
      return Math.abs(given - expected) <= (q.numericTolerance ?? 0);
    }
    case "short_answer": {
      const cs = q.caseSensitive ?? false;
      const given = normalizeShortAnswer(answers[0] ?? "", cs);
      return [q.correctAnswer, ...(q.acceptedAnswers ?? [])].some((a) => normalizeShortAnswer(a, cs) === given);
    }
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Build a `Result` (SPEC §2.2): the same quiz plus one attempt. `score` and `percentage` are always
 * recomputed here. Questions without a response get an empty answer and are marked incorrect.
 */
export function toResult(
  quiz: Quiz,
  responses: readonly QuestionResponse[],
  meta: Pick<Result, "attemptId" | "mode" | "startedAt" | "submittedAt"> = {},
): Result {
  const byId = new Map(responses.map((r) => [r.questionId, r.answer]));
  let score = 0;
  let maxScore = 0;
  const weighted = quiz.questions.some((q) => (q.points ?? 1) !== 1);
  const questions: AnsweredQuestion[] = quiz.questions.map((q) => {
    const points = q.points ?? 1;
    maxScore += points;
    const answer = byId.get(q.id);
    const correct = answer !== undefined && gradeQuestion(q, answer);
    const awarded = correct ? points : 0;
    score += awarded;
    const out: AnsweredQuestion = {
      ...q,
      userAnswer: Array.isArray(answer) ? answer.join(", ") : (answer ?? ""),
      userIsCorrect: correct,
    };
    if (Array.isArray(answer)) out.userAnswers = [...answer];
    if (weighted) out.pointsAwarded = awarded;
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
