import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Quiz, quizJsonSchema, resultJsonSchema, serializeResult, toResult } from "../src/index.ts";
import { fixedFixture, fixture } from "./fixture.ts";

function validator(schema: Record<string, unknown>) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

describe("A10: generated JSON Schema, checked with an independent validator (Ajv)", () => {
  test("quiz.json validates the fixture with Q7 fixed", () => {
    const validate = validator(quizJsonSchema());
    expect(validate(fixedFixture())).toBe(true);
  });

  test("quiz.json rejects structurally invalid quizzes", () => {
    const validate = validator(quizJsonSchema());
    const bad = fixture();
    delete (bad as Record<string, unknown>).quiz_title;
    expect(validate(bad)).toBe(false);
    expect(validate({ ...fixture(), questions: [] })).toBe(false);
  });

  test("result.json validates a Result built by toResult", () => {
    const validate = validator(resultJsonSchema());
    const result = toResult(Quiz.parse(fixedFixture()), [{ questionId: 1, answer: "6" }]);
    expect(validate(JSON.parse(serializeResult(result)))).toBe(true);
  });

  test("schemas carry an id and keep the base field names", () => {
    const s = quizJsonSchema() as { $id: string; properties: Record<string, unknown>; required: string[] };
    expect(s.$id).toContain("quiz.json");
    for (const k of ["quiz_title", "course", "chapter", "total_questions", "topics_covered", "questions"]) {
      expect(Object.keys(s.properties)).toContain(k);
    }
    expect(s.required).toEqual(expect.arrayContaining(["quiz_title", "total_questions", "questions"]));
  });
});
