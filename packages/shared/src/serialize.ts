import { answeredQuestionShape, type Quiz, QuizShape, type Result, ResultShape, resultShape } from "./quiz.ts";

// Base fields first, in the order of the base format (SPEC §2.1); extensions after; `questions` last.
const QUIZ_KEY_ORDER = [
  "quiz_title",
  "course",
  "chapter",
  "chapters",
  "total_questions",
  "topics_covered",
  "description",
  "tags",
  "testType",
  "formatVersion",
  "score",
  "percentage",
  "maxScore",
  "attemptId",
  "mode",
  "startedAt",
  "submittedAt",
  "questions",
] as const;

const QUESTION_KEY_ORDER = Object.keys(answeredQuestionShape);

function ordered(obj: Record<string, unknown>, order: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of order) if (obj[k] !== undefined) out[k] = obj[k];
  for (const k of Object.keys(obj)) if (!(k in out) && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function canonical(value: Record<string, unknown>): Record<string, unknown> {
  const top = ordered(value, QUIZ_KEY_ORDER);
  if (Array.isArray(top.questions)) {
    top.questions = top.questions.map((q: unknown) =>
      typeof q === "object" && q !== null && !Array.isArray(q)
        ? ordered(q as Record<string, unknown>, QUESTION_KEY_ORDER)
        : q,
    );
  }
  return top;
}

/** Pretty-print any (possibly invalid) quiz-like value with the canonical key order, for the import editor. */
export function formatQuizLike(value: unknown): string {
  const v =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? canonical(value as Record<string, unknown>)
      : value;
  return `${JSON.stringify(v, null, 2)}\n`;
}

/** Deterministic Quiz JSON export (SPEC §3D, §4): unknown keys dropped, fixed key order, base names kept. */
export function serializeQuiz(quiz: Quiz): string {
  const clean = QuizShape.parse(quiz);
  return `${JSON.stringify(canonical(clean as Record<string, unknown>), null, 2)}\n`;
}

/** Deterministic Result JSON export (SPEC §2.2). */
export function serializeResult(result: Result): string {
  const clean = ResultShape.parse(result);
  return `${JSON.stringify(canonical(clean as Record<string, unknown>), null, 2)}\n`;
}

// Keep the key lists honest: every schema key must have a place in the order.
for (const k of Object.keys(resultShape)) {
  if (!(QUIZ_KEY_ORDER as readonly string[]).includes(k)) throw new Error(`serialize: key ${k} missing from order`);
}
