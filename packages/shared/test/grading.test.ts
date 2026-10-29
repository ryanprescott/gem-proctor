import { describe, expect, test } from "bun:test";
import {
  gradeResponse,
  normalizeShortAnswer,
  parseNumericAnswer,
  type Question,
  Quiz,
  Result,
  recomputeScore,
  serializeResult,
  toResult,
} from "../src/index.ts";
import { fixedFixture, fixture } from "./fixture.ts";

const base = { id: 1, topic: "t", question: "q" };
const grade = (q: Question, a: string | string[] | null) => gradeResponse(q, a);
const outcome = (q: Question, a: string | string[] | null) => grade(q, a).outcome;

describe("B1: gradeResponse per question type", () => {
  test("single_choice: exact option match", () => {
    const q: Question = { ...base, options: ["5", "3", "7", "-1"], correctAnswer: "-1" };
    expect(grade(q, "-1")).toEqual({ outcome: "correct", pointsAwarded: 1, maxPoints: 1 });
    expect(grade(q, "5")).toEqual({ outcome: "incorrect", pointsAwarded: 0, maxPoints: 1 });
    expect(outcome(q, " -1")).toBe("incorrect");
    expect(outcome(q, ["-1"])).toBe("correct");
    expect(outcome(q, ["-1", "5"])).toBe("incorrect");
  });

  test("true_false: exact option match", () => {
    const q: Question = { ...base, type: "true_false", options: ["True", "False"], correctAnswer: "False" };
    expect(outcome(q, "False")).toBe("correct");
    expect(outcome(q, "True")).toBe("incorrect");
    expect(outcome(q, "false")).toBe("incorrect");
  });

  test("multi_choice: set equality, order-independent", () => {
    const q: Question = {
      ...base,
      type: "multi_choice",
      options: ["a", "b", "c", "d"],
      correctAnswer: "a",
      correctAnswers: ["a", "c"],
    };
    expect(outcome(q, ["a", "c"])).toBe("correct");
    expect(outcome(q, ["c", "a"])).toBe("correct");
    expect(outcome(q, ["a"])).toBe("incorrect");
    expect(outcome(q, ["a", "c", "d"])).toBe("incorrect");
    expect(outcome(q, [])).toBe("incorrect");
  });

  test("numeric: tolerance 0 is exact", () => {
    const q: Question = { ...base, type: "numeric", correctAnswer: "2.5" };
    expect(outcome(q, "2.5")).toBe("correct");
    expect(outcome(q, "2.50")).toBe("correct");
    expect(outcome(q, "25e-1")).toBe("correct");
    expect(outcome(q, "2.5000001")).toBe("incorrect");
  });

  test("numeric: tolerance > 0, boundary |Δ| = tolerance is correct", () => {
    const q: Question = { ...base, type: "numeric", correctAnswer: "0.3", numericTolerance: 0.1 };
    expect(outcome(q, "0.35")).toBe("correct");
    expect(outcome(q, "0.4")).toBe("correct"); // 0.4 − 0.3 is 0.10000000000000003 in binary
    expect(outcome(q, "0.2")).toBe("correct");
    expect(outcome(q, "0.41")).toBe("incorrect");
    expect(outcome(q, "0.19")).toBe("incorrect");
    const big: Question = { ...base, type: "numeric", correctAnswer: "1000.3", numericTolerance: 0.1 };
    expect(outcome(big, "1000.4")).toBe("correct");
    expect(outcome(big, "1000.40001")).toBe("incorrect");
  });

  test("short_answer: correctAnswer and each acceptedAnswers entry", () => {
    const q: Question = { ...base, correctAnswer: "linear", acceptedAnswers: ["affine", "first order"] };
    expect(outcome(q, "linear")).toBe("correct");
    expect(outcome(q, "affine")).toBe("correct");
    expect(outcome(q, "First  Order")).toBe("correct");
    expect(outcome(q, "quadratic")).toBe("incorrect");
    expect(outcome(q, "")).toBe("incorrect");
  });

  test("no answer scores 0 on every type", () => {
    const q: Question = { ...base, options: ["a", "b"], correctAnswer: "a", points: 2 };
    expect(grade(q, null)).toEqual({ outcome: "incorrect", pointsAwarded: 0, maxPoints: 2 });
  });
});

describe("B2: short-answer normalization (SPEC §7.2)", () => {
  const n = normalizeShortAnswer;
  test("trim and collapse whitespace", () => {
    expect(n("  two   words \t\n")).toBe("two words");
  });
  test("case folding, and caseSensitive: true keeps case", () => {
    expect(n("ABC")).toBe("abc");
    expect(n("ABC", true)).toBe("ABC");
    const q: Question = { ...base, correctAnswer: "Ax", caseSensitive: true };
    expect(outcome(q, "Ax")).toBe("correct");
    expect(outcome(q, "ax")).toBe("incorrect");
    expect(outcome({ ...q, caseSensitive: false }, "ax")).toBe("correct");
  });
  test.each([
    ["[", "[ 1"],
    ["]", "1 ]"],
    [",", "1 , 2"],
    ["(", "f ( x"],
    [")", "x ) y"],
    ["^", "x ^ 2"],
    ["_", "x _ i"],
    ["+", "a + b"],
    ["-", "a - b"],
    ["*", "a * b"],
    ["/", "a / b"],
  ])("whitespace around %s is removed", (op, input) => {
    expect(n(input)).toBe(input.replace(/\s/g, ""));
    expect(n(input)).toContain(op);
  });
  test("NFKC", () => {
    expect(n("ﬁve")).toBe("five"); // ligature
    expect(n("x²")).toBe("x2");
    expect(n("１２")).toBe("12"); // full-width digits
  });
  test("minus signs and quotes are unified", () => {
    expect(n("a − b")).toBe("a-b"); // U+2212
    expect(n("a – b")).toBe("a-b"); // en dash
    expect(n("a — b")).toBe("a-b"); // em dash
    expect(n("“x”")).toBe('"x"');
    expect(n("‘x’")).toBe("'x'");
  });
  test("ignoreWords strips trailing words / units", () => {
    expect(n("2n - 1 flops", false, ["flops"])).toBe("2n-1");
    expect(n("2n - 1 FLOPS", false, ["flops"])).toBe("2n-1");
    expect(n("2n - 1 FLOPS", true, ["flops"])).toBe("2n-1 FLOPS");
    expect(n("3 m s", false, ["m", "s"])).toBe("3");
    expect(n("flopsy", false, ["flops"])).toBe("flopsy");
    expect(n("2n-1flops", false, ["flops"])).toBe("2n-1flops"); // only whole, separated words
    expect(n("2 m/s", false, ["m / s"])).toBe("2");
  });
  test("[4, 2, 3]^T matches [4,2,3]^T", () => {
    const q: Question = { ...base, correctAnswer: "[4,2,3]^T" };
    expect(outcome(q, "[4, 2, 3]^T")).toBe("correct");
    expect(outcome(q, " [ 4 , 2 , 3 ] ^ T ")).toBe("correct");
  });
  test('"2n - 1 flops" matches 2n-1 with ignoreWords ["flops"]', () => {
    const q: Question = { ...base, correctAnswer: "2n-1", ignoreWords: ["flops"] };
    expect(outcome(q, "2n - 1 flops")).toBe("correct");
    expect(outcome({ ...q, ignoreWords: undefined }, "2n - 1 flops")).toBe("incorrect");
  });
});

describe("B3: numeric parsing", () => {
  test.each([
    ["-1", -1],
    ["+2.5", 2.5],
    ["1e-3", 0.001],
    [".5", 0.5],
    ["5.", 5],
    [" 42 ", 42],
    ["−3", -3], // U+2212
    ["$-1$", -1],
    ["$ 2.5 $", 2.5],
    ["１２", 12], // NFKC
    ["2E3", 2000],
  ])("accepts %p", (input, value) => {
    expect(parseNumericAnswer(input)).toBe(value);
  });

  test.each([
    "1,000",
    "1/2",
    "3 m",
    "",
    "   ",
    "$$1$$",
    "$1",
    "0x10",
    "Infinity",
    "NaN",
    "1e",
    "--1",
    "1 000",
    ".",
    "e5",
    "1e400",
  ])("rejects %p", (input) => {
    expect(parseNumericAnswer(input)).toBeNull();
  });

  test("anything unparseable is incorrect, not an error", () => {
    const q: Question = { ...base, type: "numeric", correctAnswer: "1000" };
    for (const a of ["1,000", "1/2", "3 m", "", "abc"]) {
      expect(() => gradeResponse(q, a)).not.toThrow();
      expect(outcome(q, a)).toBe("incorrect");
    }
  });
});

describe("B4: multi_choice partial credit", () => {
  const q = (partialCredit: "all_or_nothing" | "proportional" | undefined, points?: number): Question => ({
    ...base,
    type: "multi_choice",
    options: ["a", "b", "c", "d", "e"],
    correctAnswer: "a",
    correctAnswers: ["a", "b", "c"],
    ...(partialCredit ? { partialCredit } : {}),
    ...(points ? { points } : {}),
  });

  const cases: [string, Question, string[], number, string][] = [
    ["default is all_or_nothing: two of three", q(undefined), ["a", "b"], 0, "incorrect"],
    ["all_or_nothing: all right", q("all_or_nothing"), ["a", "b", "c"], 1, "correct"],
    ["all_or_nothing: one extra", q("all_or_nothing"), ["a", "b", "c", "d"], 0, "incorrect"],
    ["proportional: all right", q("proportional"), ["c", "b", "a"], 1, "correct"],
    ["proportional: two of three", q("proportional"), ["a", "b"], 0.67, "partial"],
    ["proportional: one of three", q("proportional"), ["a"], 0.33, "partial"],
    ["proportional: three right, one wrong", q("proportional"), ["a", "b", "c", "d"], 0.67, "partial"],
    ["proportional: one right, one wrong", q("proportional"), ["a", "d"], 0, "incorrect"],
    ["proportional: more wrong than right → 0", q("proportional"), ["a", "d", "e"], 0, "incorrect"],
    ["proportional: only wrong", q("proportional"), ["d"], 0, "incorrect"],
    ["proportional: nothing selected", q("proportional"), [], 0, "incorrect"],
    ["proportional, 2.5 points: two of three", q("proportional", 2.5), ["a", "b"], 1.67, "partial"],
    ["proportional, 1.5 points: one of three", q("proportional", 1.5), ["b"], 0.5, "partial"],
    ["proportional, 2.5 points: all right", q("proportional", 2.5), ["a", "b", "c"], 2.5, "correct"],
    ["all_or_nothing, 2.5 points: all right", q("all_or_nothing", 2.5), ["a", "b", "c"], 2.5, "correct"],
  ];
  for (const [name, question, answer, points, expected] of cases) {
    test(name, () => {
      const g = gradeResponse(question, answer);
      expect(g.pointsAwarded).toBe(points);
      expect(g.outcome).toBe(expected as never);
      expect(g.maxPoints).toBe(question.points ?? 1);
    });
  }

  test("duplicate selections count once", () => {
    expect(gradeResponse(q("proportional"), ["a", "a", "a"]).pointsAwarded).toBe(0.33);
  });

  test("toResult writes pointsAwarded for partial credit and recomputeScore agrees", () => {
    const quiz = Quiz.parse({
      quiz_title: "T",
      total_questions: 2,
      questions: [q("proportional"), { ...base, id: 2, options: ["x", "y"], correctAnswer: "x" }],
    });
    const result = toResult(quiz, [
      { questionId: 1, answer: ["a", "b"] },
      { questionId: 2, answer: "x" },
    ]);
    expect(result.questions[0]).toMatchObject({ userIsCorrect: false, pointsAwarded: 0.67 });
    expect(result.questions[1]).not.toHaveProperty("pointsAwarded");
    expect(result.score).toBe(1.67);
    expect(result.percentage).toBe(83.5);
    expect(recomputeScore(result)).toEqual({ score: 1.67, percentage: 83.5, maxScore: 2 });
  });
});

describe("B5: gradeQuestion and toResult use gradeResponse", () => {
  test("toResult's grades equal gradeResponse's for every fixture question", () => {
    const quiz = Quiz.parse(fixedFixture());
    const responses = quiz.questions.map((q, i) => ({
      questionId: q.id,
      answer: i % 3 === 0 ? q.correctAnswer : (q.options?.find((o) => o !== q.correctAnswer) ?? "x"),
    }));
    const result = toResult(quiz, responses);
    result.questions.forEach((aq, i) => {
      const g = gradeResponse(quiz.questions[i] as Question, responses[i]?.answer ?? null);
      expect(aq.userIsCorrect).toBe(g.outcome === "correct");
    });
  });
});

describe("B7: the fixture's Q7 (fixed) is graded exactly", () => {
  const q7 = Quiz.parse(fixedFixture()).questions.find((q) => q.id === 7) as Question;
  test('"-1" is correct, "1" is incorrect', () => {
    expect(q7.correctAnswer).toBe("-1");
    expect(outcome(q7, "-1")).toBe("correct");
    expect(outcome(q7, "1")).toBe("incorrect");
    expect(outcome(q7, "−1")).toBe("incorrect"); // a choice answer is the option text, nothing else
  });
  test("the unfixed Q7 never snaps: its stored answer only matches itself", () => {
    const raw = fixture().questions.find((q) => q.id === 7) as unknown as Question;
    expect(outcome(raw, "-1")).toBe("incorrect");
    expect(outcome(raw, "1")).toBe("correct");
  });
});

describe("B9: Result with selfGraded", () => {
  test("passes Result validation and recomputeScore counts its points", () => {
    const quiz = Quiz.parse({
      quiz_title: "T",
      total_questions: 2,
      questions: [
        { ...base, correctAnswer: "2n-1", points: 2 },
        { ...base, id: 2, options: ["x", "y"], correctAnswer: "x" },
      ],
    });
    const graded = toResult(quiz, [
      { questionId: 1, answer: "2n minus 1" },
      { questionId: 2, answer: "x" },
    ]);
    expect(graded.score).toBe(1);
    const q1 = graded.questions[0];
    if (!q1) throw new Error("no q1");
    const self = {
      ...graded,
      questions: [{ ...q1, selfGraded: true, userIsCorrect: true, pointsAwarded: 2 }, ...graded.questions.slice(1)],
    };
    const parsed = Result.safeParse(self);
    expect(parsed.success).toBe(true);
    expect(recomputeScore(self)).toEqual({ score: 3, percentage: 100, maxScore: 3 });
    expect(serializeResult(self)).toContain('"selfGraded": true');
  });
});

describe("toResult with stored grades (practice export, P1.md §5)", () => {
  test("a stored grade is used as is, and selfGraded counts as correct with full points", () => {
    const quiz = Quiz.parse({
      quiz_title: "T",
      total_questions: 2,
      questions: [
        { ...base, correctAnswer: "2n-1", points: 2 },
        { ...base, id: 2, options: ["x", "y"], correctAnswer: "x" },
      ],
    });
    const result = toResult(quiz, [
      { questionId: 1, answer: "two n minus one", grade: { outcome: "incorrect", pointsAwarded: 0 }, selfGraded: true },
      // Stored as incorrect even though re-grading would say correct: the stored grade wins.
      { questionId: 2, answer: "x", grade: { outcome: "incorrect", pointsAwarded: 0 } },
    ]);
    expect(result.questions[0]).toMatchObject({ userIsCorrect: true, selfGraded: true, pointsAwarded: 2 });
    expect(result.questions[1]).toMatchObject({ userIsCorrect: false, pointsAwarded: 0 });
    expect(result.questions[1]).not.toHaveProperty("selfGraded");
    expect(result.score).toBe(2);
    expect(Result.safeParse(result).success).toBe(true);
  });
});
