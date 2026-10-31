import { LlmError, type LlmRuntime } from "@gem/llm";
import {
  ALLOWED_IMPORTS,
  AppError,
  type VerificationProgram,
  type VerifyClient,
  type VerifyReply,
  type VerifyRunStatus,
  type VerifySettings,
  type VerifyValue,
} from "@gem/shared";
import { z } from "zod";

/** The programs of one question: running them, the one repair, and the record of each run (P2.1.md §5). */

/** Same text as the probe, so `blind-v2` and `repair-v1` run as measured. */
export const RESULT_TYPE_RULES =
  "for single_choice, numeric and short_answer: a number, Fraction, list (vector), list of lists (matrix) or sympy expression; for true_false: True or False (a bool, not a number)";

export const ProgramReply = z.object({ program: z.string().max(4096) });
export const ClassifyReply = z.object({ reason: z.string().max(200), computable: z.boolean() });
export const PickReply = z.object({ reason: z.string().max(200), option: z.number().int() });

/** Where a run hangs from. */
export interface RunRef {
  questionId: number;
  jobId?: string;
  testVersionId?: string;
  draftQuestionId?: string;
}

export interface RunRecord extends RunRef {
  programKind: "author" | "blind";
  program: string;
  status: VerifyRunStatus;
  result: unknown;
  matchedOption: string | null;
  durationMs: number;
  sandboxVersion: string;
}

/** Writes `VerificationRun` rows and the denial's audit row. */
export interface RunRecorder {
  run(record: RunRecord): Promise<string>;
  /** `verify.sandbox_denial`: the program's text stays out of the row; `runId` points at it. */
  denial(ref: RunRef, runId: string): Promise<void>;
}

export interface L7Deps {
  llm: LlmRuntime;
  verify: VerifyClient;
  recorder: RunRecorder;
  settings: VerifySettings;
  userId?: string;
  signal?: AbortSignal;
}

const REPAIRABLE = new Set([
  "SyntaxError",
  "IndentationError",
  "TabError",
  "NameError",
  "UnboundLocalError",
  "ImportError",
  "ModuleNotFoundError",
  "ResultTypeError",
  "WrongResultType",
]);

export interface ProgramRun extends VerificationProgram {
  errorType: string | null;
  sandboxVersion: string;
}

export type RunReply = VerifyReply<"run">;

/** Runs of one question, written when its outcome is known: `matched_option` is append-only too. */
export class RunTrail {
  private readonly pending: Omit<RunRecord, keyof RunRef | "matchedOption">[] = [];

  add(entry: (typeof this.pending)[number]) {
    this.pending.push(entry);
  }

  /** The last blind run gets `matchedOption`. A denial writes its audit row against its own run. */
  async flush(deps: L7Deps, ref: RunRef, matchedOption: string | null = null) {
    const lastBlind = this.pending.map((p) => p.programKind).lastIndexOf("blind");
    for (const [i, entry] of this.pending.entries()) {
      const runId = await deps.recorder.run({
        ...ref,
        ...entry,
        matchedOption: i === lastBlind ? matchedOption : null,
      });
      if (entry.status === "sandbox_denial") await deps.recorder.denial(ref, runId);
    }
    this.pending.length = 0;
  }
}

function tooLarge(): RunReply {
  return {
    ok: true,
    status: "program_error",
    errorType: "ProgramTooLarge",
    error: "the program is over 4 KB",
    durationMs: 0,
    sandboxVersion: "api",
  };
}

async function exec(
  deps: L7Deps,
  trail: RunTrail,
  kind: "author" | "blind",
  program: string,
  inputs: Record<string, VerifyValue> | undefined,
): Promise<RunReply> {
  let reply: RunReply;
  try {
    reply = await deps.verify.run({ program, ...(inputs ? { inputs } : {}) });
  } catch (err) {
    if (err instanceof AppError && err.code === "verify_program_too_large") reply = tooLarge();
    else throw err;
  }
  trail.add({
    programKind: kind,
    program,
    status: reply.status,
    result: reply.value ?? (reply.error ? { error: reply.error, errorType: reply.errorType } : null),
    durationMs: reply.durationMs,
    sandboxVersion: reply.sandboxVersion,
  });
  return reply;
}

export interface RunOptions {
  kind: "author" | "blind";
  program: string;
  inputs?: Record<string, VerifyValue>;
  /** The rendered question, for the repair prompt. */
  question: string;
  /** A value of the wrong type for this question: the error message, or null. */
  typeError?: (value: VerifyValue) => string | null;
}

const toRun = (reply: RunReply, program: string, repaired: boolean, typeError: string | null): ProgramRun => ({
  program,
  status: typeError ? "program_error" : reply.status,
  result: typeError ? null : (reply.value ?? null),
  error: typeError ?? reply.error ?? null,
  errorType: typeError ? "WrongResultType" : (reply.errorType ?? null),
  repaired,
  sandboxVersion: reply.sandboxVersion,
});

const callOpts = (deps: L7Deps) => ({
  ...(deps.userId ? { userId: deps.userId } : {}),
  ...(deps.signal ? { signal: deps.signal } : {}),
});

/** A role that isn't there, or isn't allowed, is the caller's problem; a bad reply is this question's. */
function rethrowUnlessModelFailure(err: unknown) {
  if (err instanceof LlmError && err.code !== "llm_role_unassigned" && err.code !== "llm_cloud_blocked") return;
  throw err;
}

/**
 * Runs a program, with one repair for a mechanical failure: a syntax error, `NameError`, `ImportError` or the wrong
 * result type. Never for a timeout or a denial, and mistake programs don't come through here (P2.1.md §5).
 */
export async function runWithRepair(deps: L7Deps, trail: RunTrail, o: RunOptions): Promise<ProgramRun> {
  const first = await exec(deps, trail, o.kind, o.program, o.inputs);
  const firstType = first.status === "ok" && first.value ? (o.typeError?.(first.value) ?? null) : null;
  const run = toRun(first, o.program, false, firstType);
  if (run.status === "ok" || !run.errorType || !REPAIRABLE.has(run.errorType)) return run;
  let fixed: string;
  try {
    const reply = await deps.llm.generateObject(
      "verify.solve",
      ProgramReply,
      {
        promptId: "program-repair",
        vars: {
          question: o.question,
          program: o.program,
          error: run.error ?? "",
          allowedImports: ALLOWED_IMPORTS,
          resultTypeRules: RESULT_TYPE_RULES,
        },
      },
      callOpts(deps),
    );
    fixed = reply.value.program;
  } catch (err) {
    rethrowUnlessModelFailure(err);
    return run;
  }
  const second = await exec(deps, trail, o.kind, fixed, o.inputs);
  const secondType = second.status === "ok" && second.value ? (o.typeError?.(second.value) ?? null) : null;
  return toRun(second, fixed, true, secondType);
}

/** The blind program, from the question and the passage alone (SPEC §3A.3.1). Null when the model fails. */
export async function writeBlindProgram(deps: L7Deps, question: string, passage: string): Promise<string | null> {
  try {
    const reply = await deps.llm.generateObject(
      "verify.solve",
      ProgramReply,
      {
        promptId: "verify.solve.blind",
        vars: { allowedImports: ALLOWED_IMPORTS, resultTypeRules: RESULT_TYPE_RULES, passage, question },
      },
      callOpts(deps),
    );
    return reply.value.program;
  } catch (err) {
    rethrowUnlessModelFailure(err);
    return null;
  }
}

/** `verify.solve.classify`. Null when the model fails. */
export async function classify(deps: L7Deps, question: string, options: readonly string[]) {
  try {
    const reply = await deps.llm.generateObject(
      "verify.solve",
      ClassifyReply,
      {
        promptId: "verify.solve.classify",
        vars: { question, options: options.length > 0 ? options.map((o) => `- ${o}`).join("\n") : "(none)" },
      },
      callOpts(deps),
    );
    return reply.value;
  } catch (err) {
    rethrowUnlessModelFailure(err);
    return null;
  }
}

/** The optional blind pick for a non-computable question: the option's index, or null. */
export async function pickOption(deps: L7Deps, question: string, options: readonly string[]) {
  try {
    const reply = await deps.llm.generateObject(
      "verify.solve",
      PickReply,
      {
        promptId: "verify.solve.pick",
        vars: { question, options: options.map((o, i) => `${i + 1}. ${o}`).join("\n") },
      },
      callOpts(deps),
    );
    const index = reply.value.option - 1;
    return index >= 0 && index < options.length ? index : null;
  } catch (err) {
    rethrowUnlessModelFailure(err);
    return null;
  }
}
