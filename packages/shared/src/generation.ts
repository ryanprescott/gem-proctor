import { z } from "zod";

/**
 * The `strict7` generation schema (SPEC §3A.2, `docs/prompts/authoring-generate.md`): one shallow `anyOf`
 * with a branch per (computable, type). Property order is deliberate: llama.cpp grammars write properties
 * in schema order, and `whyWrong` comes before the option text. No `.describe()`: its JSON Schema is compared
 * with the probe's (`test/fixtures/strict7.json`).
 */

const text = (max: number) => z.string().max(max);

const Evidence = z.object({ chunkId: z.string(), quote: z.string() });

const Input = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,5}$/),
  kind: z.enum(["integer", "rational", "vector", "matrix"]),
  size: z.array(z.number().int().min(1).max(6)).max(2),
  from: z.enum(["source", "sample"]),
  sourceText: text(60),
});

const Mistake = z.object({ whyWrong: text(120), program: text(400) });
const AnyOption = z.object({ whyWrong: text(160).optional(), text: text(200), isCorrect: z.boolean() });

/** Not `z.never()`: its `not: {}` doesn't convert to a grammar. */
const None = z.array(z.unknown()).max(0);
const Inputs = z.array(Input).min(1).max(4);

function branch<C extends boolean, T extends string, O extends z.ZodType, M extends z.ZodType, I extends z.ZodType>(
  computable: C,
  type: T,
  options: O,
  mistakes: M,
  inputs: I,
) {
  return z.object({
    tempId: text(20),
    type: z.literal(type),
    topic: text(80),
    computable: z.literal(computable),
    evidence: z.array(Evidence).min(1),
    inputs,
    question: text(400),
    constraint: text(computable ? 200 : 0),
    answerProgram: text(computable ? 600 : 0),
    options,
    mistakes,
    explanation: text(300),
  });
}

export const GeneratedQuestion = z.union([
  branch(true, "single_choice", None, z.array(Mistake).min(2).max(3), Inputs),
  branch(true, "numeric", None, None, Inputs),
  branch(true, "true_false", None, None, Inputs),
  branch(false, "single_choice", z.array(AnyOption).min(3).max(4), None, None),
]);
export type GeneratedQuestion = z.infer<typeof GeneratedQuestion>;

export const GenerationBatch = z.object({ questions: z.array(GeneratedQuestion) });
export type GenerationBatch = z.infer<typeof GenerationBatch>;
