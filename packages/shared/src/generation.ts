import { z } from "zod";

/**
 * The generation schema (SPEC §3A.2, `docs/prompts/authoring-generate.md`): one shallow `anyOf` with a branch per
 * (computable, type). Property order is deliberate: llama.cpp grammars write properties in schema order, and
 * `whyWrong` comes before the option text. No `.describe()`: `strict7`'s JSON Schema is compared with the probe's
 * (`test/fixtures/strict7.json`).
 *
 * `strict8` (current, `gen-v9`) is `strict7` with `objectiveIds` after `tempId`, as P2 needs, and branches for the rest
 * of the types a blueprint can ask for. `strict7` stays as the pinned baseline: its four branches are what was measured.
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

function fields<C extends boolean, T extends string, O extends z.ZodType, M extends z.ZodType, I extends z.ZodType>(
  computable: C,
  type: T,
  options: O,
  mistakes: M,
  inputs: I,
) {
  return {
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
  };
}

function strict7<C extends boolean, T extends string, O extends z.ZodType, M extends z.ZodType, I extends z.ZodType>(
  computable: C,
  type: T,
  options: O,
  mistakes: M,
  inputs: I,
) {
  return z.object({ tempId: text(20), ...fields(computable, type, options, mistakes, inputs) });
}

function strict8<C extends boolean, T extends string, O extends z.ZodType, M extends z.ZodType, I extends z.ZodType>(
  computable: C,
  type: T,
  options: O,
  mistakes: M,
  inputs: I,
) {
  return z.object({
    tempId: text(20),
    objectiveIds: z.array(text(20)).min(1).max(4),
    ...fields(computable, type, options, mistakes, inputs),
  });
}

export const GeneratedQuestionStrict7 = z.union([
  strict7(true, "single_choice", None, z.array(Mistake).min(2).max(3), Inputs),
  strict7(true, "numeric", None, None, Inputs),
  strict7(true, "true_false", None, None, Inputs),
  strict7(false, "single_choice", z.array(AnyOption).min(3).max(4), None, None),
]);
export const GenerationBatchStrict7 = z.object({ questions: z.array(GeneratedQuestionStrict7) });

export const GeneratedQuestion = z.union([
  strict8(true, "single_choice", None, z.array(Mistake).min(2).max(3), Inputs),
  strict8(true, "numeric", None, None, Inputs),
  strict8(true, "true_false", None, None, Inputs),
  strict8(false, "single_choice", z.array(AnyOption).min(3).max(4), None, None),
  strict8(true, "short_answer", None, None, Inputs),
  strict8(false, "multi_choice", z.array(AnyOption).min(3).max(5), None, None),
  strict8(false, "true_false", z.array(AnyOption).length(2), None, None),
  strict8(false, "short_answer", None, None, None).extend({ acceptedAnswers: z.array(text(120)).min(1).max(6) }),
]);
export type GeneratedQuestion = z.infer<typeof GeneratedQuestion>;

export const GenerationBatch = z.object({ questions: z.array(GeneratedQuestion) });
export type GenerationBatch = z.infer<typeof GenerationBatch>;
