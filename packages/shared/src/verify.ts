import { z } from "zod";

/**
 * The sandbox contract (SPEC §3A.3.1, P2.1.md §5). Zod here is the source; its JSON Schema is exported to
 * `apps/verify/gem_verify/contract.json`, and the Python side checks requests and child replies against it with
 * a small stdlib validator. Everything that crosses the socket is text: nothing on this side evaluates a value.
 */

/** Rejected by the API before sending (`verify_program_too_large`). */
export const VERIFY_MAX_PROGRAM_BYTES = 4 * 1024;
/** Request cap on the socket. */
export const VERIFY_MAX_REQUEST_BYTES = 256 * 1024;
/** Reply cap on the socket; a child's result over it is `invalid_output`. */
export const VERIFY_MAX_REPLY_BYTES = 64 * 1024;

export const VERIFY_RUN_STATUSES = ["ok", "program_error", "timeout", "sandbox_denial", "invalid_output"] as const;
export const VerifyRunStatus = z.enum(VERIFY_RUN_STATUSES);
export type VerifyRunStatus = z.infer<typeof VerifyRunStatus>;

export const VERIFY_VALUE_KINDS = [
  "integer",
  "rational",
  "decimal",
  "vector",
  "matrix",
  "expression",
  "boolean",
] as const;
export const VerifyValueKind = z.enum(VERIFY_VALUE_KINDS);
export type VerifyValueKind = z.infer<typeof VerifyValueKind>;

const Text = z.string().max(VERIFY_MAX_REPLY_BYTES);

/** A serialized value. Stored and shown as text; only the runner parses `value` back. */
export const VerifyValue = z.strictObject({
  kind: VerifyValueKind,
  /** Integers and decimals as strings, rationals as "p/q", vectors and matrices as nested lists, others as SymPy `str`. */
  value: z.union([Text, z.array(Text), z.array(z.array(Text))]),
  latex: Text,
  /** The option formatter's rendering (`$…$` where needed). */
  text: Text,
  /** Scalars with a numeric value: a decimal string, for `numeric` questions. */
  decimal: Text.optional(),
  /** Whether `decimal` is the exact value (an integer or a terminating fraction). */
  decimalExact: z.boolean().optional(),
});
export type VerifyValue = z.infer<typeof VerifyValue>;

const Program = z.string().max(VERIFY_MAX_PROGRAM_BYTES);
const Inputs = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,5}$/), VerifyValue);

/** Set by the API from `InstanceSettings.verify`: the parent exits after this many runs (SPEC §3A.3.1, recycling). */
const envelope = { recycleEvery: z.number().int().min(1).optional() };

export const VerifySampling = z.strictObject({
  intMin: z.number().int(),
  intMax: z.number().int(),
  vectorMin: z.number().int().min(1),
  vectorMax: z.number().int().min(1),
  matrixMin: z.number().int().min(1),
  matrixMax: z.number().int().min(1),
  constraintDraws: z.number().int().min(1),
  targetDraws: z.number().int().min(1),
});
export type VerifySampling = z.infer<typeof VerifySampling>;

/** SPEC §3A.3.1, "Input values". An instance setting. */
export const DEFAULT_SAMPLING: VerifySampling = {
  intMin: -9,
  intMax: 9,
  vectorMin: 3,
  vectorMax: 5,
  matrixMin: 2,
  matrixMax: 3,
  constraintDraws: 50,
  targetDraws: 2000,
};

export const VerifyInputDecl = z.strictObject({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,5}$/),
  kind: z.enum(["integer", "rational", "vector", "matrix"]),
  size: z.array(z.number().int().min(1).max(6)).max(2),
  from: z.enum(["source", "sample"]),
  sourceText: z.string().max(60),
});
export type VerifyInputDecl = z.infer<typeof VerifyInputDecl>;

export const VerifyQuestionKind = z.enum(["single_choice", "true_false", "numeric", "short_answer"]);
export type VerifyQuestionKind = z.infer<typeof VerifyQuestionKind>;

export const VerifyHealthRequest = z.strictObject({ kind: z.literal("health"), ...envelope });

export const VerifyRunRequest = z.strictObject({
  kind: z.literal("run"),
  program: Program,
  inputs: Inputs.optional(),
  /** The variable read after the program: `result`, or `valid` for a constraint. */
  variable: z.enum(["result", "valid"]).optional(),
  ...envelope,
});

export const VerifySampleRequest = z.strictObject({
  kind: z.literal("sample_inputs"),
  inputs: z.array(VerifyInputDecl).min(1).max(8),
  constraint: Program,
  /** Evaluated across draws for `true_false` only, inside this one child. */
  answerProgram: Program,
  type: VerifyQuestionKind,
  quotes: z.array(z.string().max(4000)).max(20),
  /** The cited chunks, in order: their written-out values are used first. */
  chunks: z.array(z.string().max(40_000)).max(20),
  /** Value keys already used in the test. */
  used: z.array(z.string().max(2000)).max(1000),
  /** Source values already used in the test. */
  usedSource: z.array(z.string().max(2000)).max(1000),
  seed: z.string().min(1).max(128),
  sampling: VerifySampling,
  ...envelope,
});

export const VerifyParseRequest = z.strictObject({
  kind: z.literal("parse_options"),
  texts: z.array(z.string().max(10_000)).min(1).max(64),
  ...envelope,
});

export const VerifyCompareRequest = z.strictObject({
  kind: z.literal("compare"),
  a: VerifyValue,
  candidates: z.array(VerifyValue).min(1).max(64),
  /** Relative, for floats. */
  tolerance: z.number().min(0),
  ...envelope,
});

export const VerifyBuildRequest = z.strictObject({
  kind: z.literal("build_options"),
  answer: VerifyValue,
  mistakes: z
    .array(
      z.strictObject({
        value: VerifyValue,
        whyWrong: z.string().max(400),
        program: Program,
      }),
    )
    .max(8),
  seed: z.string().min(1).max(128),
  distractorCount: z.number().int().min(1).max(8),
  ...envelope,
});

export const VerifyRequest = z.discriminatedUnion("kind", [
  VerifyHealthRequest,
  VerifyRunRequest,
  VerifySampleRequest,
  VerifyParseRequest,
  VerifyCompareRequest,
  VerifyBuildRequest,
]);
export type VerifyRequest = z.infer<typeof VerifyRequest>;

/** Every child reply carries `status`; anything but `ok` carries `errorType` and `error`, and no payload. */
const childBase = {
  status: VerifyRunStatus,
  errorType: z.string().max(100).optional(),
  error: z.string().max(1000).optional(),
};

export const SAMPLE_FAILURES = [
  "constraint_unmet",
  "constraint_error",
  "source_not_in_quote",
  "source_unparseable",
  "program_error",
] as const;
export const SampleFailure = z.enum(SAMPLE_FAILURES);
export type SampleFailure = z.infer<typeof SampleFailure>;

export const DISTRACTOR_SOURCES = ["common", "near", "random"] as const;

export const VerifyDistractor = z.strictObject({
  text: Text,
  source: z.enum(DISTRACTOR_SOURCES),
  reason: z.string().max(400),
  program: Program.optional(),
});
export type VerifyDistractor = z.infer<typeof VerifyDistractor>;

const payloads = {
  run: { value: VerifyValue.optional() },
  sample_inputs: {
    inputs: Inputs.optional(),
    latex: z.record(z.string(), Text).optional(),
    key: z.string().optional(),
    sourceUsed: z.array(z.string()).optional(),
    /** `true_false`: the target truth value, and whether a draw reached it. Null when source values fixed it. */
    target: z.boolean().nullable().optional(),
    hitTarget: z.boolean().nullable().optional(),
    failure: SampleFailure.optional(),
    detail: z.string().max(1000).optional(),
  },
  parse_options: {
    results: z
      .array(
        z.union([
          z.strictObject({ ok: z.literal(true), value: VerifyValue }),
          z.strictObject({
            ok: z.literal(false),
            /** `text`: prose or a word such as "Undefined", not a value. `parse_error`: math that couldn't be read. */
            reason: z.enum(["text", "parse_error"]),
            error: z.string().max(500).optional(),
          }),
        ]),
      )
      .optional(),
  },
  compare: {
    results: z
      .array(
        z.strictObject({
          equal: z.boolean(),
          /** The 2 s comparison guard fired, so `equal` means "not shown equal". */
          guard: z.boolean(),
        }),
      )
      .optional(),
  },
  build_options: {
    options: z.array(z.strictObject({ text: Text, isCorrect: z.boolean() })).optional(),
    correctAnswer: Text.optional(),
    distractors: z.array(VerifyDistractor).optional(),
    dropped: z.array(z.strictObject({ reason: z.string().max(400), whyWrong: z.string().max(400) })).optional(),
  },
};

const childReply = <T extends z.ZodRawShape>(shape: T) => z.strictObject({ ...childBase, ...shape });

export const VerifyChildReplies = {
  run: childReply(payloads.run),
  sample_inputs: childReply(payloads.sample_inputs),
  parse_options: childReply(payloads.parse_options),
  compare: childReply(payloads.compare),
  build_options: childReply(payloads.build_options),
};

/** What the parent adds to a child's reply. */
const parentAdds = { ok: z.literal(true), durationMs: z.number().int().min(0), sandboxVersion: z.string().max(100) };

export const VerifyReplies = {
  run: VerifyChildReplies.run.extend(parentAdds),
  sample_inputs: VerifyChildReplies.sample_inputs.extend(parentAdds),
  parse_options: VerifyChildReplies.parse_options.extend(parentAdds),
  compare: VerifyChildReplies.compare.extend(parentAdds),
  build_options: VerifyChildReplies.build_options.extend(parentAdds),
};
export type VerifyKind = keyof typeof VerifyReplies;
export type VerifyReply<K extends VerifyKind> = z.infer<(typeof VerifyReplies)[K]>;

/** A refused request: never prose. */
export const VERIFY_REFUSALS = [
  "invalid_json",
  "request_too_large",
  "unsupported_request",
  "reply_too_large",
  "privdrop_failed",
] as const;
export const VerifyRefusal = z.strictObject({ ok: z.literal(false), error: z.enum(VERIFY_REFUSALS) });

export const VerifyHealthReply = z.object({
  ok: z.literal(true),
  sympy: z.string().max(50),
  numpy: z.string().max(50),
});
export type VerifyHealthReply = z.infer<typeof VerifyHealthReply>;

/** The interface L7 and the API use; `SocketVerifyClient` in `apps/api` is the real one, tests may fake it. */
export interface VerifyClient {
  /** Null when the runner can't be reached. */
  health(): Promise<VerifyHealthReply | null>;
  run(request: Omit<z.infer<typeof VerifyRunRequest>, "kind" | "recycleEvery">): Promise<VerifyReply<"run">>;
  sampleInputs(
    request: Omit<z.infer<typeof VerifySampleRequest>, "kind" | "recycleEvery">,
  ): Promise<VerifyReply<"sample_inputs">>;
  parseOptions(
    request: Omit<z.infer<typeof VerifyParseRequest>, "kind" | "recycleEvery">,
  ): Promise<VerifyReply<"parse_options">>;
  compare(
    request: Omit<z.infer<typeof VerifyCompareRequest>, "kind" | "recycleEvery">,
  ): Promise<VerifyReply<"compare">>;
  buildOptions(
    request: Omit<z.infer<typeof VerifyBuildRequest>, "kind" | "recycleEvery">,
  ): Promise<VerifyReply<"build_options">>;
}
