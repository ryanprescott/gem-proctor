import { describe, expect, test } from "bun:test";
import { isExerciseSection } from "../src/sources.ts";

describe("isExerciseSection", () => {
  test("a section that is a set of exercises, however it's numbered or marked up", () => {
    for (const title of [
      "Exercises",
      "exercises",
      "Exercise",
      "**Exercises**",
      "3.2 Exercises",
      "Chapter 4 Problems",
      "12. Problems",
      "Practice problems",
      "Practice exercises:",
      "Review questions",
      "Homework",
      "Homework problems",
      "End-of-chapter exercises",
      "  Exercises  ",
    ]) {
      expect(isExerciseSection(title), title).toBe(true);
    }
  });

  test("anything else is a section like any other, even if it mentions exercises", () => {
    for (const title of [
      "Exercises in linear algebra",
      "Problems of scale",
      "Solving problems",
      "Worked examples",
      "Examples",
      "Applications",
      "Exercise 3.14",
      "Introduction",
      "",
    ]) {
      expect(isExerciseSection(title), title).toBe(false);
    }
  });
});
