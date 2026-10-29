import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { applyShuffle, newShuffleSeed, type Question, Quiz, SHUFFLE_SEED_RE, shuffleAttempt } from "../src/index.ts";
import { fixedFixture } from "./fixture.ts";

const quiz = Quiz.parse(fixedFixture());
const tf: Question = {
  id: 99,
  topic: "t",
  question: "q",
  type: "true_false",
  options: ["True", "False"],
  correctAnswer: "True",
};
const questions: Question[] = [...quiz.questions, tf];
const seedArb = fc
  .uint8Array({ minLength: 16, maxLength: 16 })
  .map((b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""));
const sorted = <T>(xs: readonly T[]) => [...xs].sort();

describe("B6: shuffleAttempt", () => {
  test("seeds are 128 random bits as hex", () => {
    const a = newShuffleSeed();
    expect(a).toMatch(SHUFFLE_SEED_RE);
    expect(newShuffleSeed()).not.toBe(a);
  });

  test("rejects malformed seeds", () => {
    expect(() => shuffleAttempt("xyz", questions)).toThrow();
    expect(() => shuffleAttempt("A".repeat(32), questions)).toThrow();
  });

  test("property: deterministic, a permutation of questions and options, true_false order kept", () => {
    fc.assert(
      fc.property(seedArb, (seed) => {
        const s = shuffleAttempt(seed, questions);
        expect(shuffleAttempt(seed, questions)).toEqual(s);
        expect(sorted(s.questionIds)).toEqual(sorted(questions.map((q) => q.id)));
        expect(new Set(s.questionIds).size).toBe(questions.length);
        for (const q of questions) {
          if (!q.options) {
            expect(s.options[q.id]).toBeUndefined();
            continue;
          }
          expect(sorted(s.options[q.id] ?? [])).toEqual(sorted(q.options));
        }
        expect(s.options[99]).toEqual(["True", "False"]);
        const shown = applyShuffle(s, questions);
        expect(shown.map((q) => q.id)).toEqual(s.questionIds);
        expect(shown.find((q) => q.id === 1)?.options).toEqual(s.options[1] as string[]);
      }),
      { numRuns: 200 },
    );
  });

  test("property: different seeds give different orders", () => {
    fc.assert(
      fc.property(seedArb, seedArb, (a, b) => {
        fc.pre(a !== b);
        const x = shuffleAttempt(a, questions);
        const y = shuffleAttempt(b, questions);
        // 20 questions: the chance of an equal order and equal option orders is negligible.
        expect(x).not.toEqual(y);
      }),
      { numRuns: 200 },
    );
  });

  test("orders are spread out: every question appears first for some seed", () => {
    const firsts = new Set<number>();
    for (let i = 0; i < 2000; i++)
      firsts.add(shuffleAttempt(newShuffleSeed(), quiz.questions).questionIds[0] as number);
    expect(firsts.size).toBe(quiz.questions.length);
  });

  test("a known seed gives a fixed order (guards accidental PRNG changes)", () => {
    const s = shuffleAttempt("0123456789abcdef0123456789abcdef", quiz.questions);
    expect(s.questionIds).toMatchSnapshot();
    expect(s.options[1]).toMatchSnapshot();
  });
});
