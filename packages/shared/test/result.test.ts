import { describe, expect, test } from "bun:test";
import {
  analyzeImport,
  gradeQuestion,
  normalizeShortAnswer,
  type Quiz,
  Quiz as QuizSchema,
  Result,
  recomputeScore,
  resultWarnings,
  serializeResult,
  toResult,
} from "../src/index.ts";
import { fixedFixture } from "./fixture.ts";

describe("A11: toResult", () => {
  const quiz = QuizSchema.parse(fixedFixture());

  test("produces a valid Result with recomputed score and percentage", () => {
    const responses = quiz.questions.map((q, i) => ({
      questionId: q.id,
      answer: i < 15 ? q.correctAnswer : "definitely wrong",
    }));
    const result = toResult(quiz, responses, { mode: "practice" });
    expect(Result.safeParse(result).success).toBe(true);
    expect(result.score).toBe(15);
    expect(result.percentage).toBe(75);
    expect(result.total_questions).toBe(20);
    expect(result.questions[0]).toMatchObject({ userAnswer: quiz.questions[0]?.correctAnswer, userIsCorrect: true });
    expect(result.questions[19]?.userIsCorrect).toBe(false);
    expect(resultWarnings(result)).toEqual([]);
  });

  test("ignores any stale score on the input and weights by points", () => {
    const weighted: Quiz = {
      ...quiz,
      questions: quiz.questions.slice(0, 2).map((q, i) => ({ ...q, points: i === 0 ? 3 : 1 })),
      total_questions: 2,
    };
    const result = toResult(weighted, [
      { questionId: weighted.questions[0]?.id ?? 0, answer: weighted.questions[0]?.correctAnswer ?? "" },
    ]);
    expect(result.score).toBe(3);
    expect(result.maxScore).toBe(4);
    expect(result.percentage).toBe(75);
    expect(result.questions[1]).toMatchObject({ userAnswer: "", userIsCorrect: false, pointsAwarded: 0 });
  });

  test("the result re-imports as a quiz (attempt data ignored)", () => {
    const result = toResult(quiz, [{ questionId: 1, answer: "6" }]);
    const analysis = analyzeImport(serializeResult(result));
    expect(analysis.report.errors).toEqual([]);
    expect(analysis.quiz).not.toBeNull();
    const reimported = analysis.quiz as Quiz;
    expect(reimported.questions).toHaveLength(20);
    expect(reimported.questions[0]).not.toHaveProperty("userAnswer");
    expect(reimported).not.toHaveProperty("score");
    expect(reimported.questions.map((q) => q.question)).toEqual(quiz.questions.map((q) => q.question));
  });

  test("score / percentage mismatches are warnings with recomputed values", () => {
    const result = toResult(quiz, [{ questionId: 1, answer: "6" }]);
    const stale = { ...result, score: 10, percentage: 50 };
    expect(resultWarnings(stale).map((w) => w.code)).toEqual(["score_mismatch", "percentage_mismatch"]);
    expect(recomputeScore(stale)).toEqual({ score: 1, percentage: 5, maxScore: 20 });
  });
});

describe("grading helpers", () => {
  const base = { id: 1, topic: "t", question: "q" };
  test("multi_choice compares sets", () => {
    const q = {
      ...base,
      type: "multi_choice" as const,
      options: ["a", "b", "c"],
      correctAnswer: "a",
      correctAnswers: ["a", "c"],
    };
    expect(gradeQuestion(q, ["c", "a"])).toBe(true);
    expect(gradeQuestion(q, ["a"])).toBe(false);
  });
  test("numeric uses the tolerance", () => {
    const q = { ...base, type: "numeric" as const, correctAnswer: "3.14", numericTolerance: 0.01 };
    expect(gradeQuestion(q, "3.145")).toBe(true);
    expect(gradeQuestion(q, "3.2")).toBe(false);
  });
  test("short answers are normalized (SPEC §7.2)", () => {
    expect(normalizeShortAnswer("  [4, 2, 3]^T ")).toBe(normalizeShortAnswer("[4,2,3] ^ T"));
    expect(normalizeShortAnswer("2n − 1 flops", false, ["flops"])).toBe("2n-1");
    const q = { ...base, correctAnswer: "2n - 1", acceptedAnswers: ["2n-1 flops"] };
    expect(gradeQuestion(q, "2N-1")).toBe(true);
  });
});
