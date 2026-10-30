import { z } from "zod";
import { QuizShape, ResultShape } from "./quiz.ts";

/**
 * JSON Schemas generated from the shared Zod models (SPEC §4, §12: `GET /schema/quiz.json`, `/schema/result.json`).
 * Cross-field checks (`superRefine`) can't be expressed in JSON Schema; the server enforces them.
 */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-2020-12", io: "input", unrepresentable: "any" });
}

function exportSchema(schema: z.ZodType, id: string, title: string): Record<string, unknown> {
  return { ...jsonSchemaOf(schema), $id: id, title };
}

export function quizJsonSchema(): Record<string, unknown> {
  return exportSchema(QuizShape, "https://gem-proctor.local/schema/quiz.json", "gem-proctor Quiz");
}

export function resultJsonSchema(): Record<string, unknown> {
  return exportSchema(ResultShape, "https://gem-proctor.local/schema/result.json", "gem-proctor Result");
}
