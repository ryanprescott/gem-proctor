import { describe, expect, test } from "bun:test";
import {
  BaseQuiz,
  crossFieldErrors,
  derivedValueWarnings,
  Quiz,
  type QuizIssueCode,
  Result,
  zodIssuesToQuizIssues,
} from "../src/index.ts";
import { fixedFixture, fixture } from "./fixture.ts";

describe("A5: fixture vs base and extended schemas", () => {
  test("parses as BaseQuiz unchanged", () => {
    const raw = fixture();
    const parsed = BaseQuiz.parse(raw);
    expect(parsed).toEqual(raw as never);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(raw));
  });

  test("fails Quiz with exactly one error: Q7 correctAnswer not in options", () => {
    const r = Quiz.safeParse(fixture());
    expect(r.success).toBe(false);
    if (r.success) return;
    const issues = zodIssuesToQuizIssues(r.error);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "answer_not_in_options",
      path: ["questions", 6, "correctAnswer"],
      params: { id: 7, answer: "1" },
    });
  });

  test("the fixed fixture passes Quiz", () => {
    expect(Quiz.safeParse(fixedFixture()).success).toBe(true);
  });
});

type Q = Record<string, unknown>;
const quiz = (questions: Q[], extra: Q = {}) => ({
  quiz_title: "T",
  total_questions: questions.length,
  questions,
  ...extra,
});
const choice = (over: Q = {}): Q => ({
  id: 1,
  topic: "t",
  question: "q",
  options: ["a", "b"],
  correctAnswer: "a",
  ...over,
});
const codes = (v: unknown) => {
  const r = Quiz.safeParse(v);
  return r.success ? [] : zodIssuesToQuizIssues(r.error).map((i) => i.code);
};

// A6: every cross-field check in SPEC §4 has a passing and a failing case.
describe("A6: cross-field checks", () => {
  const cases: { name: string; code: QuizIssueCode; pass: unknown; fail: unknown }[] = [
    {
      name: "question ids are unique",
      code: "duplicate_question_id",
      pass: quiz([choice({ id: 1 }), choice({ id: 2 })]),
      fail: quiz([choice({ id: 1 }), choice({ id: 1 })]),
    },
    {
      name: "correctAnswer is exactly one of options",
      code: "answer_not_in_options",
      pass: quiz([choice({ correctAnswer: "b" })]),
      fail: quiz([choice({ correctAnswer: "B" })]),
    },
    {
      name: "every correctAnswers entry is one of options",
      code: "correct_answers_not_in_options",
      pass: quiz([choice({ type: "multi_choice", options: ["a", "b", "c"], correctAnswers: ["a", "c"] })]),
      fail: quiz([choice({ type: "multi_choice", options: ["a", "b", "c"], correctAnswers: ["a", "d"] })]),
    },
    {
      name: "options are unique",
      code: "duplicate_options",
      pass: quiz([choice({ options: ["a", "b"] })]),
      fail: quiz([choice({ options: ["a", "a"] })]),
    },
    {
      name: "choice types require options",
      code: "options_required",
      pass: quiz([choice({ type: "single_choice" })]),
      fail: quiz([{ id: 1, topic: "t", question: "q", correctAnswer: "a", type: "single_choice" }]),
    },
    {
      name: "short_answer / numeric must not have options",
      code: "options_not_allowed",
      pass: quiz([{ id: 1, topic: "t", question: "q", correctAnswer: "4", type: "numeric" }]),
      fail: quiz([choice({ type: "short_answer" })]),
    },
    {
      name: 'true_false options are exactly ["True", "False"]',
      code: "true_false_options",
      pass: quiz([choice({ type: "true_false", options: ["True", "False"], correctAnswer: "True" })]),
      fail: quiz([choice({ type: "true_false", options: ["Yes", "No"], correctAnswer: "Yes" })]),
    },
    {
      name: "chapters must be [chapter] when both are present",
      code: "chapters_mismatch",
      pass: quiz([choice()], { chapter: 2, chapters: [2] }),
      fail: quiz([choice()], { chapter: 2, chapters: [2, 3] }),
    },
    {
      name: "single_choice has exactly one correct answer",
      code: "single_choice_one_answer",
      pass: quiz([choice({ type: "single_choice", correctAnswers: ["a"] })]),
      fail: quiz([choice({ type: "single_choice", correctAnswers: ["a", "b"] })]),
    },
    {
      name: "multi_choice has at least one correct answer (correctAnswer = first)",
      code: "multi_choice_needs_answer",
      pass: quiz([choice({ type: "multi_choice", correctAnswers: ["a", "b"] })]),
      fail: quiz([choice({ type: "multi_choice", correctAnswers: [] })]),
    },
    {
      name: "numeric needs a correctAnswer that parses as a number",
      code: "numeric_not_a_number",
      pass: quiz([{ id: 1, topic: "t", question: "q", correctAnswer: "-2.5", type: "numeric" }]),
      fail: quiz([{ id: 1, topic: "t", question: "q", correctAnswer: "about 3", type: "numeric" }]),
    },
  ];

  for (const c of cases) {
    test(`${c.name}: passes`, () => expect(codes(c.pass)).toEqual([]));
    test(`${c.name}: fails with ${c.code}`, () => expect(codes(c.fail)).toContain(c.code));
  }

  test("total_questions mismatch is a warning, not an error", () => {
    const v = quiz([choice()], { total_questions: 5 });
    expect(codes(v)).toEqual([]);
    expect(derivedValueWarnings(v).map((w) => w.code)).toEqual(["total_questions_mismatch"]);
    expect(derivedValueWarnings(quiz([choice()]))).toEqual([]);
  });

  test("Result runs the same cross-field checks", () => {
    const r = {
      ...quiz([{ ...choice({ correctAnswer: "z" }), userAnswer: "a", userIsCorrect: false }]),
      score: 0,
      percentage: 0,
    };
    expect(Result.safeParse(r).success).toBe(false);
    expect(crossFieldErrors(r as never).map((i) => i.code)).toEqual(["answer_not_in_options"]);
  });
});
