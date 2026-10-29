import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { analyzeImport, type FixCode, normalizeJson, normalizeQuiz, Quiz, serializeQuiz } from "../src/index.ts";
import { fixedFixture, fixture, fixtureText } from "./fixture.ts";

type AnyQuiz = { questions: Record<string, unknown>[] } & Record<string, unknown>;
const codesOf = (text: string) => normalizeQuiz(text).fixes.map((f) => f.code);
const parsedValue = (text: string) => normalizeQuiz(text).value as AnyQuiz;
const one = (over: Record<string, unknown> = {}) => ({
  id: 1,
  topic: "t",
  question: "What is 1 + 1?",
  options: ["1", "2", "3"],
  correctAnswer: "2",
  type: "single_choice",
  ...over,
});
const quizText = (questions: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ quiz_title: "T", total_questions: questions.length, questions, ...extra });

const expectFix = (text: string, code: FixCode) => expect(codesOf(text)).toContain(code);

// A7: one test (or more) per row of the SPEC §3D.2 table; each asserts a recorded fix.
describe("A7: SPEC §3D.2 normalization table", () => {
  test("clean JSON records no fixes", () => {
    expect(codesOf(quizText([one()]))).toEqual([]);
  });

  test("row 1: JSON wrapped in prose / Markdown fences → extracted", () => {
    const text = `Sure! Here is the quiz:\n\`\`\`json\n${quizText([one()])}\n\`\`\`\nLet me know.`;
    expectFix(text, "extracted_json");
    expect(parsedValue(text).quiz_title).toBe("T");
    const prose = `Here you go: ${quizText([one()])} -- enjoy`;
    expectFix(prose, "extracted_json");
  });

  test("row 1: <think> blocks are stripped", () => {
    const text = `<think>The user wants {a quiz}. [Let me think]</think>\n${quizText([one()])}`;
    const r = normalizeQuiz(text);
    expect(r.fixes.map((f) => f.code)).toContain("think_stripped");
    expect((r.value as AnyQuiz).questions).toHaveLength(1);
  });

  test("row 2: trailing commas, single quotes, unquoted keys, comments → tolerant parse", () => {
    const text = `{
      // a comment
      quiz_title: 'T', total_questions: 1,
      questions: [{ id: 1, topic: 't', question: 'Q?', options: ['a', 'b',], correctAnswer: 'a', type: 'single_choice', },],
    }`;
    expectFix(text, "tolerant_parse");
    expect(parsedValue(text).questions[0]?.options).toEqual(["a", "b"]);
  });

  test("row 2: smart quotes", () => {
    let n = 0;
    const text = quizText([one()]).replace(/"/g, () => (n++ % 2 === 0 ? "\u201c" : "\u201d"));
    const r = normalizeQuiz(text);
    expect(r.fixes.map((f) => f.code)).toContain("smart_quotes");
    expect((r.value as AnyQuiz).quiz_title).toBe("T");
  });

  test("row 3: truncated output keeps complete questions, drops the partial last one, warns", () => {
    const full = quizText([one({ id: 1 }), one({ id: 2 }), one({ id: 3 })], { total_questions: 3 });
    const cut = full.slice(0, full.lastIndexOf('"question"'));
    const r = normalizeQuiz(cut);
    const fix = r.fixes.find((f) => f.code === "truncated");
    expect(fix?.severity).toBe("warning");
    expect((r.value as AnyQuiz).questions.map((q) => q.id)).toEqual([1, 2]);
  });

  test("row 3: truncation inside a nested array still drops the whole partial question", () => {
    const q = (id: number) =>
      one({
        id,
        evidence: [
          { sourceId: "s", chunkId: "c", quote: "x" },
          { sourceId: "s", chunkId: "c", quote: "y" },
        ],
      });
    const full = quizText([q(1), q(2)]);
    const cut = full.slice(0, full.lastIndexOf('"quote":"y"'));
    expect((normalizeQuiz(cut).value as AnyQuiz).questions.map((x) => x.id)).toEqual([1]);
  });

  test("row 4: a bare array of questions is wrapped in a quiz with the given title", () => {
    const r = normalizeQuiz(JSON.stringify([one()]), { title: "From file" });
    expect(r.fixes.map((f) => f.code)).toContain("wrapped_array");
    expect(r.value).toMatchObject({ quiz_title: "From file", total_questions: 1 });
  });

  test("row 5: key-name variants map to the base names", () => {
    const text = JSON.stringify({
      quizTitle: "T",
      topicsCovered: ["x"],
      questions: [
        { question_number: 1, topic: "t", question: "Q?", choices: ["a", "b"], correct_answer: "a" },
        { questionNumber: 2, topic: "t", question: "Q?", answers: ["a", "b"], answer: "b" },
      ],
    });
    const r = normalizeQuiz(text);
    const aliases = r.fixes.filter((f) => f.code === "key_alias").map((f) => `${f.params.from}→${f.params.to}`);
    expect(aliases).toEqual(
      expect.arrayContaining([
        "quizTitle→quiz_title",
        "topicsCovered→topics_covered",
        "question_number→id",
        "questionNumber→id",
        "correct_answer→correctAnswer",
        "answer→correctAnswer",
        "choices→options",
        "answers→options",
      ]),
    );
    expect(Quiz.safeParse(r.value).success).toBe(true);
  });

  test('row 6: numbers as strings ("3") are coerced', () => {
    const text = JSON.stringify({
      quiz_title: "T",
      chapter: "3",
      total_questions: "1",
      questions: [one({ id: "1", points: "2" })],
    });
    const r = normalizeQuiz(text);
    expect(r.fixes.filter((f) => f.code === "number_coerced").map((f) => f.params.field)).toEqual(
      expect.arrayContaining(["chapter", "total_questions", "id", "points"]),
    );
    expect(r.value).toMatchObject({ chapter: 3, total_questions: 1, questions: [{ id: 1, points: 2 }] });
  });

  test('row 7: a letter answer ("B") resolves to the option text', () => {
    const v = parsedValue(quizText([one({ options: ["red", "green"], correctAnswer: "B" })]));
    expect(v.questions[0]?.correctAnswer).toBe("green");
    expectFix(quizText([one({ options: ["red", "green"], correctAnswer: "B" })]), "answer_letter_resolved");
  });

  test("row 7: an index answer (1) resolves to the option text", () => {
    const text = quizText([one({ options: ["red", "green"], correctAnswer: 1 })]);
    expectFix(text, "answer_index_resolved");
    expect(parsedValue(text).questions[0]?.correctAnswer).toBe("green");
  });

  test("row 7: a bare integer answer with numeric options is never read as an index", () => {
    const text = quizText([one({ options: ["5", "3", "7"], correctAnswer: 1 })]);
    expect(parsedValue(text).questions[0]?.correctAnswer).toBe("1");
    expect(codesOf(text)).not.toContain("answer_index_resolved");
  });

  test('row 7: a prefixed answer ("B) 2n − 1") resolves, and A)/a./(c) option prefixes are stripped', () => {
    const text = quizText([
      one({ options: ["A) n", "B) 2n − 1", "C) n^2"], correctAnswer: "B) 2n − 1" }),
      one({ id: 2, options: ["a. x", "b. y"], correctAnswer: "a" }),
      one({ id: 3, options: ["(a) p", "(b) q", "(c) r"], correctAnswer: "(c)" }),
    ]);
    const r = normalizeQuiz(text);
    const v = r.value as AnyQuiz;
    expect(v.questions.map((q) => q.options)).toEqual([
      ["n", "2n − 1", "n^2"],
      ["x", "y"],
      ["p", "q", "r"],
    ]);
    expect(v.questions.map((q) => q.correctAnswer)).toEqual(["2n − 1", "x", "r"]);
    expect(r.fixes.filter((f) => f.code === "option_prefix_stripped")).toHaveLength(3);
    // A letter answer with option text that doesn't match that option is left alone.
    const mismatch = parsedValue(quizText([one({ options: ["n", "2n"], correctAnswer: "A) 2n" })]));
    expect(mismatch.questions[0]?.correctAnswer).toBe("A) 2n");
  });

  test("row 7: options are only stripped when every option carries the next letter", () => {
    const v = parsedValue(quizText([one({ options: ["A) one", "C) three"], correctAnswer: "A) one" })]));
    expect(v.questions[0]?.options).toEqual(["A) one", "C) three"]);
  });

  test("row 8: an answer that differs only in case, whitespace or LaTeX spacing snaps to that option", () => {
    const text = quizText([
      one({ options: ["Paris", "Rome"], correctAnswer: "  paris " }),
      one({ id: 2, options: ["$2n - 1$", "$n$"], correctAnswer: "$2n\\,-\\,1$" }),
    ]);
    const r = normalizeQuiz(text);
    expect((r.value as AnyQuiz).questions.map((q) => q.correctAnswer)).toEqual(["Paris", "$2n - 1$"]);
    expect(r.fixes.filter((f) => f.code === "answer_snapped")).toHaveLength(2);
  });

  test('row 8: "1" is NOT snapped to "-1" (SPEC §2.4, sample Q7)', () => {
    const r = normalizeQuiz(fixtureText());
    const q7 = (r.value as AnyQuiz).questions[6];
    expect(q7?.correctAnswer).toBe("1");
    expect(r.fixes.some((f) => f.path[1] === 6 && f.path[2] === "correctAnswer")).toBe(false);
    const analysis = analyzeImport(fixtureText());
    expect(analysis.report.canSave).toBe(false);
    expect(analysis.report.errors.map((e) => e.code)).toEqual(["answer_not_in_options"]);
  });

  test("row 8: never picks between two plausible matches", () => {
    const v = parsedValue(quizText([one({ options: ["Paris", "PARIS "], correctAnswer: "paris" })]));
    expect(v.questions[0]?.correctAnswer).toBe("paris");
  });

  test("row 9: missing or duplicate ids are renumbered 1..n with a warning", () => {
    const dup = quizText([one({ id: 1 }), one({ id: 1 }), one({ id: 5 })]);
    const r = normalizeQuiz(dup);
    expect(r.fixes.find((f) => f.code === "ids_renumbered")?.severity).toBe("warning");
    expect((r.value as AnyQuiz).questions.map((q) => q.id)).toEqual([1, 2, 3]);
    const missing = { ...one() } as Record<string, unknown>;
    delete missing.id;
    expect(codesOf(quizText([missing]))).toContain("ids_renumbered");
  });

  test("row 10: wrong or missing total_questions is recomputed", () => {
    expectFix(quizText([one()], { total_questions: 9 }), "total_questions_recomputed");
    const text = JSON.stringify({ quiz_title: "T", questions: [one()] });
    expectFix(text, "total_questions_recomputed");
    expect(parsedValue(text).total_questions).toBe(1);
  });

  test("row 11: type missing or inconsistent with options is inferred", () => {
    const noType = { ...one() } as Record<string, unknown>;
    delete noType.type;
    const r = normalizeQuiz(
      quizText([
        noType,
        one({ id: 2, type: "short_answer" }),
        one({ id: 3, type: "single_choice", options: undefined }),
      ]),
    );
    const v = r.value as AnyQuiz;
    expect(v.questions.map((q) => q.type)).toEqual(["single_choice", "single_choice", "short_answer"]);
    expect(r.fixes.filter((f) => f.code === "type_inferred")).toHaveLength(3);
  });

  test("normalizeJson applies only the JSON-level fixes", () => {
    const r = normalizeJson("```json\n{answer: 'B', choices: ['x','y',]}\n```");
    expect(r.value).toEqual({ answer: "B", choices: ["x", "y"] });
    expect(r.fixes.map((f) => f.code)).toEqual(["extracted_json", "tolerant_parse"]);
  });

  test("unrecoverable text yields no value", () => {
    expect(normalizeQuiz("no json here").value).toBeUndefined();
    expect(analyzeImport("no json here").report.errors[0]?.code).toBe("parse_failed");
  });
});

// A8: normalization never changes question text and never invents options or answers.
describe("A8: property test over the fixture", () => {
  const alias = fc.constantFrom("options", "choices", "answers");
  const answerKey = fc.constantFrom("correctAnswer", "correct_answer", "answer");
  const answerForm = fc.constantFrom("exact", "letter", "index", "spaced", "upper", "prefixed");
  const wrapper = fc.constantFrom("none", "fence", "prose", "think");

  test("question texts unchanged; options never grow; answers come from the input", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(alias, answerKey, answerForm, fc.boolean()), { minLength: 20, maxLength: 20 }),
        wrapper,
        fc.boolean(),
        (mutations, wrap, trailingCommas) => {
          const original = fixture();
          const mutated = fixture();
          mutated.questions = mutated.questions.map((q, i) => {
            const [optKey, ansKey, form, prefix] = mutations[i] as [string, string, string, boolean];
            const options = (q.options as string[]).map((o, j) =>
              prefix ? `${String.fromCharCode(65 + j)}) ${o}` : o,
            );
            const idx = (q.options as string[]).indexOf(q.correctAnswer as string);
            let answer: unknown = q.correctAnswer;
            if (idx >= 0) {
              if (form === "letter") answer = String.fromCharCode(65 + idx);
              if (form === "index") answer = idx;
              if (form === "spaced") answer = `  ${q.correctAnswer as string}  `;
              if (form === "upper") answer = (q.correctAnswer as string).toUpperCase();
              if (form === "prefixed") answer = `${String.fromCharCode(65 + idx)}) ${q.correctAnswer as string}`;
            }
            const out: Record<string, unknown> = { id: q.id, topic: q.topic, question: q.question };
            out[optKey] = options;
            out[ansKey] = answer;
            return out;
          });
          let text = JSON.stringify(mutated, null, 2);
          if (trailingCommas) text = text.replace(/"\n(\s*)\]/g, '",\n$1]');
          if (wrap === "fence") text = `Here is your quiz:\n\`\`\`json\n${text}\n\`\`\``;
          if (wrap === "prose") text = `Quiz below.\n${text}\nThanks!`;
          if (wrap === "think") text = `<think>hmm { not json</think>${text}`;

          const out = normalizeQuiz(text).value as AnyQuiz;
          expect(out.questions.map((q) => q.question)).toEqual(original.questions.map((q) => q.question));
          out.questions.forEach((q, i) => {
            const origOptions = original.questions[i]?.options as string[];
            const opts = q.options as string[];
            expect(opts.length).toBe(origOptions.length);
            for (const o of opts) expect(origOptions).toContain(o);
            // The answer is either an original option or exactly what the input said (never invented).
            const inputAnswer = String((mutated.questions[i] as Record<string, unknown>)[mutations[i]?.[1] as string]);
            const answer = q.correctAnswer as string;
            expect(origOptions.includes(answer) || answer === inputAnswer).toBe(true);
          });
          // Sample Q7 stays an error whatever the formatting.
          expect(out.questions[6]?.correctAnswer).not.toBe("-1");
        },
      ),
      { numRuns: 150 },
    );
  });
});

// A9 (pure part): export → re-import → export is byte-for-byte stable; base names kept.
describe("A9: export round trip", () => {
  test("export of the fixed fixture equals the export of its re-import", () => {
    const first = analyzeImport(JSON.stringify(fixedFixture(), null, 2));
    expect(first.report.canSave).toBe(true);
    const exported = serializeQuiz(first.quiz as never);
    const second = analyzeImport(exported);
    expect(second.report.canSave).toBe(true);
    expect(second.report.fixes).toEqual([]);
    expect(serializeQuiz(second.quiz as never)).toBe(exported);
    const parsed = JSON.parse(exported);
    expect(Object.keys(parsed).slice(0, 5)).toEqual([
      "quiz_title",
      "course",
      "chapter",
      "total_questions",
      "topics_covered",
    ]);
    expect(Object.keys(parsed.questions[0]).slice(0, 5)).toEqual([
      "id",
      "topic",
      "question",
      "options",
      "correctAnswer",
    ]);
  });
});
