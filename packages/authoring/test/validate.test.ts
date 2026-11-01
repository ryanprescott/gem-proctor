// L1, L2, L3, the mapper and the batch planner (P2.md E28–E31).
import { describe, expect, test } from "bun:test";
import { type Blueprint, type DraftContent, Quiz } from "@gem/shared";
import {
  bestWindowSimilarity,
  checkAfterL7,
  checkForm,
  checkGrounding,
  checkStructure,
  describeCounts,
  longestAlwaysCorrect,
  matchQuote,
  numbersIn,
  placeholdersIn,
  planBatches,
  questionsPerCall,
  type StructureInput,
  toQuiz,
} from "../src/index.ts";

const CHUNK =
  "The inner product of two vectors is x^T y. Two vectors are orthogonal when it is zero. It can be negative.";
const ctx = { objectiveIds: new Set(["o1"]), chunkIds: new Set(["c1"]) };
const concept = (over: Partial<StructureInput> = {}): StructureInput => ({
  type: "single_choice",
  computable: false,
  question: "Which statement is true?",
  objectiveIds: ["o1"],
  evidence: [{ chunkId: "c1", quote: "orthogonal when it is zero" }],
  inputs: [],
  answerProgram: "",
  options: [
    { text: "A", isCorrect: true },
    { text: "B", isCorrect: false },
    { text: "C", isCorrect: false },
  ],
  mistakes: [],
  ...over,
});
const calc = (over: Partial<StructureInput> = {}): StructureInput =>
  concept({
    computable: true,
    question: "What is the inner product of {x} and {y}?",
    inputs: [
      { name: "x", from: "sample", sourceText: "" },
      { name: "y", from: "sample", sourceText: "" },
    ],
    answerProgram: "result = x.dot(y)",
    options: [],
    mistakes: [{}, {}],
    ...over,
  });
const codes = (r: { issues: { code: string }[] }) => r.issues.map((i) => i.code);

describe("E29: L1", () => {
  test("a clean concept question and a clean calculation pass", () => {
    expect(checkStructure(concept(), ctx).outcome).toBe("pass");
    expect(checkStructure(calc(), ctx).outcome).toBe("pass");
  });

  test("concept rules: one correct, unique options", () => {
    expect(
      codes(
        checkStructure(
          concept({
            options: [
              { text: "A", isCorrect: true },
              { text: "B", isCorrect: true },
              { text: "C", isCorrect: false },
            ],
          }),
          ctx,
        ),
      ),
    ).toContain("multiple_correct");
    expect(
      codes(
        checkStructure(
          concept({
            options: [
              { text: "A", isCorrect: false },
              { text: "B", isCorrect: false },
              { text: "C", isCorrect: false },
            ],
          }),
          ctx,
        ),
      ),
    ).toContain("no_correct");
    expect(
      codes(
        checkStructure(
          concept({
            options: [
              { text: "A", isCorrect: true },
              { text: " a ", isCorrect: false },
              { text: "C", isCorrect: false },
            ],
          }),
          ctx,
        ),
      ),
    ).toContain("options_not_unique");
    expect(
      codes(
        checkStructure(
          concept({
            type: "multi_choice",
            options: [
              { text: "A", isCorrect: false },
              { text: "B", isCorrect: false },
              { text: "C", isCorrect: false },
            ],
          }),
          ctx,
        ),
      ),
    ).toContain("too_few_correct");
    expect(
      codes(
        checkStructure(
          concept({
            type: "true_false",
            options: [
              { text: "Yes", isCorrect: true },
              { text: "No", isCorrect: false },
            ],
          }),
          ctx,
        ),
      ),
    ).toContain("true_false_options");
  });

  test("ids: an unknown objective or chunk fails", () => {
    expect(codes(checkStructure(concept({ objectiveIds: ["nope"] }), ctx))).toContain("objective_unknown");
    expect(codes(checkStructure(concept({ evidence: [{ chunkId: "zzz", quote: "q" }] }), ctx))).toContain(
      "chunk_unknown",
    );
  });

  test("calculation rules: program, type, options, mistakes", () => {
    expect(codes(checkStructure(calc({ answerProgram: " " }), ctx))).toContain("program_missing");
    expect(codes(checkStructure(calc({ type: "multi_choice" }), ctx))).toContain("not_computable_type");
    expect(codes(checkStructure(calc({ options: [{ text: "1", isCorrect: true }] }), ctx))).toContain(
      "options_from_model",
    );
    expect(codes(checkStructure(calc({ mistakes: [{}] }), ctx))).toContain("mistakes_count");
    expect(codes(checkStructure(calc({ mistakes: [{}, {}, {}, {}] }), ctx))).toContain("mistakes_count");
    // Not single_choice: no mistakes are needed.
    expect(codes(checkStructure(calc({ type: "numeric", mistakes: [] }), ctx))).not.toContain("mistakes_count");
  });

  test("placeholders: undeclared, unused, and the batch with none at all", () => {
    expect(codes(checkStructure(calc({ question: "What is {x} dot {z}?" }), ctx))).toEqual(
      expect.arrayContaining(["placeholder_undeclared", "input_unused"]),
    );
    expect(codes(checkStructure(calc({ question: "What is the inner product of two vectors?" }), ctx))).toContain(
      "no_placeholders",
    );
    // A LaTeX group isn't a placeholder.
    expect(placeholdersIn("Let $x_{1}$ and $y^{T}$ and {x}")).toEqual(["x"]);
    expect(placeholdersIn("a \\frac{a}{b} c")).toEqual([]);
  });

  test("a number outside a placeholder is a warn, unless the quote has it; a source value must be in a quote", () => {
    const warned = checkStructure(calc({ question: "With {x}, {y} and the number 7, what is it?" }), ctx);
    expect(warned.outcome).toBe("warn");
    expect(codes(warned)).toContain("number_outside_placeholder");
    const quoted = checkStructure(
      calc({
        question: "With {x}, {y} and the number 7, what is it?",
        evidence: [{ chunkId: "c1", quote: "the number 7 appears" }],
      }),
      ctx,
    );
    expect(codes(quoted)).not.toContain("number_outside_placeholder");
    const source = (sourceText: string) =>
      checkStructure(
        calc({
          inputs: [
            { name: "x", from: "source", sourceText },
            { name: "y", from: "sample", sourceText: "" },
          ],
        }),
        ctx,
      );
    expect(codes(source("not in any quote"))).toContain("source_not_in_quote");
    expect(codes(source("zero"))).not.toContain("source_not_in_quote");
  });

  test("after L7 exactly one option is true, and there is an answer", () => {
    expect(
      checkAfterL7({ type: "single_choice", options: [{ isCorrect: true }, { isCorrect: false }], correctAnswer: "a" })
        .outcome,
    ).toBe("pass");
    expect(
      codes(
        checkAfterL7({
          type: "single_choice",
          options: [{ isCorrect: true }, { isCorrect: true }],
          correctAnswer: "a",
        }),
      ),
    ).toContain("not_one_true");
    expect(codes(checkAfterL7({ type: "numeric", options: null, correctAnswer: null }))).toContain("answer_missing");
    expect(
      checkAfterL7({ type: "multi_choice", options: [{ isCorrect: true }, { isCorrect: true }], correctAnswer: "a" })
        .outcome,
    ).toBe("pass");
  });
});

describe("E30: L2", () => {
  test("exact, normalized and fuzzy matches, above and below the threshold; an unknown chunk fails", () => {
    expect(matchQuote("orthogonal when it is zero", CHUNK, 0.9).match).toBe("exact");
    expect(matchQuote("Orthogonal  WHEN it is zero", CHUNK, 0.9).match).toBe("normalized");
    expect(matchQuote("orthogonal when it is **zero**", CHUNK, 0.9).match).toBe("normalized");
    const close = "Two vectors are orthogonal when it was zero.";
    expect(matchQuote(close, CHUNK, 0.8).match).toBe("fuzzy");
    expect(matchQuote(close, CHUNK, 0.99).match).toBe("missing");
    expect(matchQuote("Matrices multiply row by column.", CHUNK, 0.9).match).toBe("missing");
    const result = (evidence: { chunkId: string; quote: string }[]) =>
      checkGrounding(evidence, new Map([["c1", CHUNK]]), 0.9);
    expect(result([{ chunkId: "c1", quote: "orthogonal when it is zero" }]).outcome).toBe("pass");
    expect(codes(result([{ chunkId: "c2", quote: "x" }]))).toEqual(["chunk_unknown"]);
    expect(codes(result([{ chunkId: "c1", quote: "  " }]))).toEqual(["quote_empty"]);
    expect(result([{ chunkId: "c1", quote: "Nothing like it at all, no" }]).outcome).toBe("fail");
  });

  test("the similarity is 0 to 1 and order matters", () => {
    expect(bestWindowSimilarity("a b c", "a b c d e")).toBe(1);
    expect(bestWindowSimilarity("", "a b")).toBe(0);
    expect(bestWindowSimilarity("c b a", "a b c")).toBeLessThan(1);
  });
});

describe("E31: L3", () => {
  const form = (over: Partial<Parameters<typeof checkForm>[0]> = {}) =>
    checkForm({
      question: "Which statement about orthogonal vectors holds?",
      options: [
        { text: "Their inner product is zero", isCorrect: true },
        { text: "Their sum is zero", isCorrect: false },
      ],
      correctAnswer: "Their inner product is zero",
      explanation: "It follows from the definition.",
      passages: [CHUNK],
      computable: false,
      ...over,
    });
  test("a clean question passes", () => expect(form().outcome).toBe("pass"));
  test("the answer inside the question is a warn", () => {
    const r = form({ question: "Is it true that their inner product is zero, as stated?" });
    expect(codes(r)).toContain("answer_in_question");
    expect(r.outcome).toBe("warn");
    // A short answer turns up by chance and isn't flagged.
    expect(codes(form({ question: "Is it 2 or 3?", correctAnswer: "2" }))).not.toContain("answer_in_question");
  });
  test("all or none of the above fails", () => {
    expect(
      codes(
        form({
          options: [
            { text: "None of the above", isCorrect: false },
            { text: "x", isCorrect: true },
          ],
        }),
      ),
    ).toContain("all_or_none_of_above");
    expect(
      codes(
        form({
          options: [
            { text: "Both A and B", isCorrect: false },
            { text: "x", isCorrect: true },
          ],
        }),
      ),
    ).toContain("all_or_none_of_above");
  });
  test("long text is a warn", () => {
    expect(codes(form({ question: "x".repeat(700) }))).toContain("text_too_long");
    expect(codes(form({ options: [{ text: "y".repeat(400), isCorrect: true }] }))).toContain("text_too_long");
  });
  test("the longest option always being right is a warn over a set of four or more", () => {
    const q = (id: string, long: boolean) => ({
      id,
      computable: false,
      options: [
        { text: long ? "A much longer correct option" : "tiny right", isCorrect: true },
        { text: long ? "tiny" : "a much longer wrong one here", isCorrect: false },
        { text: "mid length", isCorrect: false },
      ],
    });
    const all = ["a", "b", "c", "d"].map((id) => q(id, true));
    expect(longestAlwaysCorrect(all)).toEqual(["a", "b", "c", "d"]);
    expect(longestAlwaysCorrect(all.slice(0, 3))).toEqual([]);
    expect(longestAlwaysCorrect([...all.slice(0, 3), q("e", false)])).toEqual([]);
  });
  test("P6: a number in the explanation that isn't in the question or the passage is a warn, one in the passage isn't", () => {
    const warn = form({ explanation: "Because 42 is the answer." });
    expect(codes(warn)).toContain("number_in_explanation");
    expect(codes(form({ explanation: "As in the passage with 3.", passages: ["Case 3 is shown."] }))).not.toContain(
      "number_in_explanation",
    );
    expect(codes(form({ explanation: "With 5 here.", question: "What is 5?" }))).not.toContain("number_in_explanation");
    expect(numbersIn("1,000 and 2.5 and $3$")).toEqual(["1000", "2.5"]);
  });
});

const draft = (over: Partial<DraftContent> = {}): DraftContent => ({
  type: "single_choice",
  topic: "Inner product",
  computable: false,
  objectiveIds: ["o1"],
  template: "Which is true?",
  question: "Which is true?",
  options: [
    { text: "A", isCorrect: true },
    { text: "B", isCorrect: false },
    { text: "C", isCorrect: false },
  ],
  correctAnswer: "A",
  numericTolerance: null,
  explanation: "Because.",
  evidence: [{ sourceId: "s", chunkId: "c1", chunkKey: "k", quote: "q" }],
  inputs: [],
  constraint: "",
  answerProgram: "",
  mistakes: [],
  verification: null,
  l7: null,
  l7Pending: false,
  provenance: "llm",
  callLogId: null,
  promptVersion: "gen-v9",
  model: "m",
  ...over,
});

describe("E28: the mapper", () => {
  const meta = { title: "T", testType: "chapter_quiz" as const, objectiveLabels: ["One", "Two"] };
  test("all five types become a valid quiz, ids 1..n, topics from the objectives", () => {
    const quiz = toQuiz(
      [
        { content: draft(), tempId: "a" },
        {
          content: draft({
            type: "multi_choice",
            correctAnswers: ["A", "B"],
            correctAnswer: "A",
            options: [
              { text: "A", isCorrect: true },
              { text: "B", isCorrect: true },
              { text: "C", isCorrect: false },
            ],
          }),
          tempId: "b",
        },
        {
          content: draft({
            type: "true_false",
            options: [
              { text: "True", isCorrect: true },
              { text: "False", isCorrect: false },
            ],
            correctAnswer: "True",
          }),
          tempId: "c",
        },
        {
          content: draft({
            type: "short_answer",
            options: null,
            correctAnswer: "orthogonal",
            acceptedAnswers: ["perpendicular"],
          }),
          tempId: "d",
        },
        {
          content: draft({
            type: "numeric",
            computable: true,
            options: null,
            correctAnswer: "-5",
            numericTolerance: 0,
            verification: { status: "computed", answerSource: "computed" },
          }),
          tempId: "e",
        },
      ],
      meta,
    );
    expect(Quiz.safeParse(quiz).success).toBe(true);
    expect(quiz.questions.map((q) => q.id)).toEqual([1, 2, 3, 4, 5]);
    expect(quiz.total_questions).toBe(5);
    expect(quiz.topics_covered).toEqual(["One", "Two"]);
    expect(quiz.testType).toBe("chapter_quiz");
    const [single, multi, tf, short, numeric] = quiz.questions;
    expect(single).toMatchObject({
      options: ["A", "B", "C"],
      correctAnswer: "A",
      provenance: "llm",
      objectiveIds: ["o1"],
    });
    expect(multi).toMatchObject({ correctAnswers: ["A", "B"], correctAnswer: "A" });
    expect(tf).toMatchObject({ options: ["True", "False"], correctAnswer: "True" });
    expect(short).toMatchObject({ correctAnswer: "orthogonal", acceptedAnswers: ["perpendicular"] });
    expect(short?.options).toBeUndefined();
    expect(numeric).toMatchObject({ correctAnswer: "-5", numericTolerance: 0, computable: true });
    expect(single?.evidence).toEqual([{ sourceId: "s", chunkId: "c1", quote: "q" }]);
  });
  test("the correct answer is the correct option's, or the computed value; a draft with none is a bug", () => {
    expect(() => toQuiz([{ content: draft({ correctAnswer: null }), tempId: "x" }], meta)).toThrow(/no answer/);
  });
  test("a student's question has its values filled in, not the template", () => {
    const quiz = toQuiz(
      [{ content: draft({ computable: true, template: "What is {x}?", question: "What is $2$?" }), tempId: "x" }],
      meta,
    );
    expect(quiz.questions[0]?.question).toBe("What is $2$?");
  });
});

describe("batches", () => {
  const blueprint = (counts: number[], mix: Blueprint["mix"]): Blueprint => ({
    testType: "custom",
    questionCount: counts.reduce((a, b) => a + b, 0),
    mix,
    spread: "even",
    perObjective: counts.map((count, i) => ({ objectiveId: `o${i}`, count })),
    style: "",
    constraints: "",
    styleVersion: "style-v1",
  });
  test("calls hold a few questions of one objective, and every question in the blueprint is planned once", () => {
    const plans = planBatches(blueprint([5, 1, 3], { single_choice: 6, numeric: 3 }), 4);
    expect(plans.map((p) => [p.objectiveIds[0], p.size])).toEqual([
      ["o0", 4],
      ["o0", 1],
      ["o1", 1],
      ["o2", 3],
    ]);
    expect(plans.reduce((n, p) => n + p.size, 0)).toBe(9);
    const total: Record<string, number> = {};
    for (const p of plans) for (const [t, n] of Object.entries(p.counts)) total[t] = (total[t] ?? 0) + (n as number);
    expect(total).toEqual({ single_choice: 6, numeric: 3 });
  });
  test("the size of a call comes from the output budget", () => {
    expect(questionsPerCall(8192)).toBe(4);
    expect(questionsPerCall(100)).toBe(1);
    expect(questionsPerCall(1_000_000)).toBe(12);
    expect(describeCounts({ single_choice: 3, true_false: 1 })).toBe("3 single_choice, 1 true_false");
  });
});
