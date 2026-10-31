import { describe, expect, test } from "bun:test";
import {
  type Blueprint,
  blueprintProblems,
  defaultBlueprint,
  mixCounts,
  spreadCounts,
  TEST_TYPE_PRESETS,
  TEST_TYPES,
} from "../src/index.ts";

const style = { line: "line", version: "style-v1" };
const objectives = [
  { id: "a", tokens: 1000 },
  { id: "b", tokens: 3000 },
  { id: "c", tokens: 10 },
];
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("E22: test types", () => {
  test("each type fills SPEC §3A.1.1's defaults", () => {
    const lengths = Object.fromEntries(TEST_TYPES.map((t) => [t, TEST_TYPE_PRESETS[t].length]));
    expect(lengths.chapter_quiz).toBe(10);
    expect(lengths.homework).toBeGreaterThanOrEqual(10);
    expect(lengths.homework).toBeLessThanOrEqual(15);
    expect(lengths.unit_test).toBeGreaterThanOrEqual(20);
    expect(lengths.unit_test).toBeLessThanOrEqual(25);
    expect(lengths.midterm).toBeGreaterThanOrEqual(30);
    expect(lengths.midterm).toBeLessThanOrEqual(40);
    expect(lengths.final).toBeGreaterThanOrEqual(40);
    expect(lengths.final).toBeLessThanOrEqual(50);
    expect(TEST_TYPE_PRESETS.chapter_quiz.spread).toBe("even");
    expect(TEST_TYPE_PRESETS.homework.spread).toBe("even");
    expect(TEST_TYPE_PRESETS.unit_test.spread).toBe("proportional");
    expect(TEST_TYPE_PRESETS.midterm.spread).toBe("proportional");
    expect(TEST_TYPE_PRESETS.final.spread).toBe("proportional");
    // "Mostly single choice"; "more short answer / numeric".
    expect(TEST_TYPE_PRESETS.chapter_quiz.mix.single_choice).toBeGreaterThan(0.5);
    const hw = TEST_TYPE_PRESETS.homework.mix;
    expect((hw.short_answer ?? 0) + (hw.numeric ?? 0)).toBeGreaterThan(hw.single_choice ?? 0);
  });

  test("every default is consistent: mix and objectives add up to the length", () => {
    for (const type of TEST_TYPES) {
      const b = defaultBlueprint(type, objectives, style);
      expect(blueprintProblems(b)).toEqual([]);
      expect(b.questionCount).toBe(TEST_TYPE_PRESETS[type].length);
      expect(sum(Object.values(b.mix) as number[])).toBe(b.questionCount);
    }
  });

  test("even gives each objective the same share", () => {
    const b = defaultBlueprint("chapter_quiz", objectives, style);
    expect(b.perObjective.map((o) => o.count)).toEqual([4, 3, 3]);
  });

  test("proportional goes by token count, with at least one each", () => {
    const b = defaultBlueprint("midterm", objectives, style);
    const [a, big, small] = b.perObjective.map((o) => o.count) as [number, number, number];
    expect(big).toBeGreaterThan(a);
    expect(a).toBeGreaterThan(small);
    expect(small).toBeGreaterThanOrEqual(1);
    expect(a + big + small).toBe(35);
  });
});

describe("the sums", () => {
  test("spreadCounts is exact and deterministic", () => {
    expect(spreadCounts(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(spreadCounts(10, [1, 1, 1])).toEqual(spreadCounts(10, [1, 1, 1]));
    expect(spreadCounts(7, [0, 0])).toEqual([4, 3]);
    expect(spreadCounts(5, [])).toEqual([]);
    expect(sum(spreadCounts(23, [0.33, 0.33, 0.34]))).toBe(23);
  });

  test("the minimum holds when the total allows it, and is given up when it doesn't", () => {
    expect(spreadCounts(5, [100, 1, 1], 1)).toEqual([3, 1, 1]);
    expect(sum(spreadCounts(2, [1, 1, 1], 1))).toBe(2);
  });

  test("mixCounts leaves no type at zero and adds up", () => {
    const mix = mixCounts(10, { single_choice: 0.8, true_false: 0.1, numeric: 0.1 });
    expect(mix).toEqual({ single_choice: 8, numeric: 1, true_false: 1 });
    expect(Object.keys(mixCounts(1, { single_choice: 0.9, numeric: 0.1 }))).toEqual(["single_choice"]);
  });

  test("a blueprint whose counts don't add up says which", () => {
    const b: Blueprint = defaultBlueprint("chapter_quiz", objectives, style);
    expect(blueprintProblems({ ...b, questionCount: 11 })).toEqual(["mix_sum", "objective_sum"]);
    expect(blueprintProblems({ ...b, mix: { single_choice: 9 } })).toEqual(["mix_sum"]);
    expect(blueprintProblems({ ...b, perObjective: [] })).toEqual(["objective_sum"]);
  });
});
