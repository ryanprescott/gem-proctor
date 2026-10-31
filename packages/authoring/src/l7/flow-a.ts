import { createHash } from "node:crypto";
import {
  type L7Reason,
  type QuestionType,
  VERIFY_MAX_PROGRAM_BYTES,
  type Verification,
  type VerifyDistractor,
  type VerifyInputDecl,
  type VerifyQuestionKind,
  type VerifyValue,
} from "@gem/shared";
import { type L7Deps, type ProgramRun, type RunRef, RunTrail, runWithRepair, writeBlindProgram } from "./programs.ts";

/** Flow A: a generated computable question, whose answer is computed (SPEC §3A.3.1). */

/** What flow A reads from a generated question. Everything the model states about the answer is only a claim. */
export interface ComputableQuestion {
  tempId: string;
  type: QuestionType;
  question: string;
  inputs: VerifyInputDecl[];
  constraint: string;
  answerProgram: string;
  mistakes?: { whyWrong: string; program: string }[];
  evidence: { chunkId: string; quote: string }[];
  /** Possible in `prompt_only` mode; discarded, and recorded as `modelClaim` when different. */
  options?: { text: string; isCorrect?: boolean }[];
  numericAnswer?: { value: number; tolerance?: number };
  acceptedAnswers?: string[];
}

export interface FlowAInput {
  question: ComputableQuestion;
  /** The cited chunks' text, in citation order. */
  chunks: string[];
  batchSeed: string;
  /** Value sets and source values already used in this test. */
  used: { keys: string[]; source: string[] };
  ref: RunRef;
}

export type FlowAOutcome = "computed" | "disagree" | "couldnt_compute" | "failed" | "denied";

export interface FlowAResult {
  outcome: FlowAOutcome;
  /** `pass`, `warn` or `fail` (SPEC §3A.3.1, the outcome table). */
  check: "pass" | "warn" | "fail";
  reason: L7Reason;
  /** The question with its values filled in, once there are values. */
  rendered: string | null;
  options: { text: string; isCorrect: boolean }[] | null;
  correctAnswer: string | null;
  numericTolerance: number | null;
  author: ProgramRun | null;
  blind: ProgramRun | null;
  mistakesDropped: { reason: string; whyWrong: string }[];
  verification: Verification;
  /** To add to the test's used sets. */
  usedKey: string | null;
  usedSource: string[];
  warnings: L7Reason[];
}

export const questionSeed = (batchSeed: string, tempId: string) =>
  createHash("sha256").update(`${batchSeed}\0${tempId}`).digest("hex");

/**
 * Fills `{name}` placeholders. Outside math a value goes in with its own `$…$`; inside `$…$` it goes in bare, so
 * `${x}$` and `$x = {x}$` both come out as one math span.
 */
export function renderQuestion(text: string, latex: Record<string, string>): string {
  let out = "";
  let inMath = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === "$" && text[i - 1] !== "\\") {
      inMath = !inMath;
      out += ch;
      continue;
    }
    if (ch === "{") {
      const end = text.indexOf("}", i);
      const value = end > i ? latex[text.slice(i + 1, end)] : undefined;
      if (value !== undefined) {
        out += inMath ? value : `$${value}$`;
        i = end;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/** What the model said the answer was, if anything. */
function statedAnswer(q: ComputableQuestion): string | null {
  const marked = q.options?.find((o) => o.isCorrect)?.text;
  if (marked !== undefined) return marked;
  if (q.numericAnswer) return String(q.numericAnswer.value);
  return q.acceptedAnswers?.[0] ?? null;
}

async function claimIfDifferent(deps: L7Deps, stated: string | null, value: VerifyValue): Promise<string | undefined> {
  if (stated === null) return undefined;
  const parsed = await deps.verify.parseOptions({ texts: [stated] });
  const first = parsed.results?.[0];
  if (!first?.ok) return stated;
  const same = await deps.verify.compare({
    a: value,
    candidates: [first.value],
    tolerance: deps.settings.numericTolerance,
  });
  return same.results?.[0]?.equal ? undefined : stated;
}

function typeError(type: VerifyQuestionKind) {
  return (value: VerifyValue): string | null => {
    if (type === "true_false") {
      return value.kind === "boolean"
        ? null
        : `TypeError: result must be True or False for a true/false question, got ${value.text}`;
    }
    if (value.kind === "boolean") return `TypeError: result must be a value, not ${value.text}`;
    if (type === "numeric" && value.decimal === undefined) {
      return `TypeError: result must be a number for a numeric question, got ${value.text}`;
    }
    return null;
  };
}

const COMPUTABLE: ReadonlySet<QuestionType> = new Set(["single_choice", "true_false", "numeric", "short_answer"]);

function empty(
  outcome: FlowAOutcome,
  check: FlowAResult["check"],
  reason: L7Reason,
  verification: Verification,
  rest: Partial<FlowAResult> = {},
): FlowAResult {
  return {
    outcome,
    check,
    reason,
    rendered: null,
    options: null,
    correctAnswer: null,
    numericTolerance: null,
    author: null,
    blind: null,
    mistakesDropped: [],
    verification,
    usedKey: null,
    usedSource: [],
    warnings: [],
    ...rest,
  };
}

interface BuiltAnswer {
  options: { text: string; isCorrect: boolean }[] | null;
  correctAnswer: string;
  numericTolerance: number | null;
  distractors?: VerifyDistractor[];
  dropped: { reason: string; whyWrong: string }[];
  denied: boolean;
}

/** Flow A step 5: the answer, from the computed value only. */
async function buildAnswer(
  deps: L7Deps,
  trail: RunTrail,
  q: ComputableQuestion,
  value: VerifyValue,
  seed: string,
  inputs: Record<string, VerifyValue>,
): Promise<BuiltAnswer | null> {
  if (q.type === "true_false") {
    return {
      options: [
        { text: "True", isCorrect: value.text === "True" },
        { text: "False", isCorrect: value.text === "False" },
      ],
      correctAnswer: value.text,
      numericTolerance: null,
      dropped: [],
      denied: false,
    };
  }
  if (q.type === "numeric") {
    return {
      options: null,
      correctAnswer: value.decimal as string,
      numericTolerance: value.decimalExact ? 0 : deps.settings.numericTolerance,
      dropped: [],
      denied: false,
    };
  }
  if (q.type === "short_answer") {
    return { options: null, correctAnswer: value.text, numericTolerance: null, dropped: [], denied: false };
  }
  const mistakes: { value: VerifyValue; whyWrong: string; program: string }[] = [];
  const dropped: { reason: string; whyWrong: string }[] = [];
  let denied = false;
  for (const m of q.mistakes ?? []) {
    if (Buffer.byteLength(m.program, "utf8") > VERIFY_MAX_PROGRAM_BYTES) {
      dropped.push({ reason: "program too large", whyWrong: m.whyWrong });
      continue;
    }
    // No repair for a mistake program; one that fails is dropped.
    const reply = await deps.verify.run({ program: m.program, inputs });
    trail.add({
      programKind: "author",
      program: m.program,
      status: reply.status,
      result: { mistake: true, value: reply.value ?? null, error: reply.error ?? null },
      durationMs: reply.durationMs,
      sandboxVersion: reply.sandboxVersion,
    });
    denied ||= reply.status === "sandbox_denial";
    if (reply.value) mistakes.push({ value: reply.value, whyWrong: m.whyWrong, program: m.program });
    else dropped.push({ reason: reply.error ?? "program failed", whyWrong: m.whyWrong });
  }
  const built = await deps.verify.buildOptions({
    answer: value,
    mistakes,
    seed,
    distractorCount: deps.settings.distractorCount,
  });
  if (built.status !== "ok" || !built.options || built.correctAnswer === undefined) return null;
  return {
    options: built.options,
    correctAnswer: built.correctAnswer,
    numericTolerance: null,
    distractors: built.distractors ?? [],
    dropped: [...dropped, ...(built.dropped ?? [])],
    denied,
  };
}

function failedReason(run: ProgramRun | null): L7Reason {
  if (run === null) return "llm_failed";
  return run.status === "timeout" ? "program_timeout" : "program_failed";
}

export async function computeQuestion(deps: L7Deps, input: FlowAInput): Promise<FlowAResult> {
  const { question: q, ref } = input;
  const seed = questionSeed(input.batchSeed, q.tempId);
  const stated = statedAnswer(q);
  const base: Verification = {
    status: "unverified",
    authorProgram: q.answerProgram,
    seed,
    checkedAt: new Date().toISOString(),
  };
  if (!COMPUTABLE.has(q.type)) return empty("failed", "fail", "not_computable_type", { ...base, status: "failed" });
  const type = q.type as VerifyQuestionKind;
  const trail = new RunTrail();

  const sampled = await deps.verify.sampleInputs({
    inputs: q.inputs,
    constraint: q.constraint,
    answerProgram: type === "true_false" ? q.answerProgram : "",
    type,
    quotes: q.evidence.map((e) => e.quote),
    chunks: input.chunks,
    used: input.used.keys,
    usedSource: input.used.source,
    seed,
    sampling: deps.settings.sampling,
  });
  if (sampled.status === "sandbox_denial") {
    // The constraint or the author program ran in that child.
    trail.add({
      programKind: "author",
      program: q.constraint.trim() ? q.constraint : q.answerProgram,
      status: sampled.status,
      result: { error: sampled.error ?? null },
      durationMs: sampled.durationMs,
      sandboxVersion: sampled.sandboxVersion,
    });
    await trail.flush(deps, ref);
    return empty("denied", "fail", "sandbox_denial", { ...base, status: "failed" });
  }
  if (sampled.status !== "ok") {
    return empty("couldnt_compute", "warn", "program_failed", base);
  }
  if (sampled.failure || !sampled.inputs || !sampled.latex) {
    const reason: L7Reason =
      sampled.failure === "constraint_error" ||
      sampled.failure === "source_not_in_quote" ||
      sampled.failure === "source_unparseable"
        ? sampled.failure
        : "constraint_unmet";
    return empty("failed", "fail", reason, { ...base, status: "failed" });
  }
  const inputs = sampled.inputs;
  const rendered = renderQuestion(q.question, sampled.latex);
  const verification: Verification = { ...base, inputs: sampled.latex };
  const warnings: L7Reason[] = sampled.target === true && sampled.hitTarget === false ? ["target_unreachable"] : [];
  const context = {
    rendered,
    warnings,
    usedKey: sampled.key ?? null,
    usedSource: sampled.sourceUsed ?? [],
  };

  const author = await runWithRepair(deps, trail, {
    kind: "author",
    program: q.answerProgram,
    inputs,
    question: rendered,
    typeError: typeError(type),
  });
  verification.authorProgram = author.program;
  const passage = input.chunks.join("\n\n");
  const blindProgram = author.status === "sandbox_denial" ? null : await writeBlindProgram(deps, rendered, passage);
  const blind =
    blindProgram === null
      ? null
      : await runWithRepair(deps, trail, {
          kind: "blind",
          program: blindProgram,
          question: rendered,
          typeError: typeError(type),
        });
  if (blind) verification.program = blind.program;
  const programs = { ...context, author, blind };

  if (author.status === "sandbox_denial" || blind?.status === "sandbox_denial") {
    await trail.flush(deps, ref);
    return empty("denied", "fail", "sandbox_denial", { ...verification, status: "failed" }, programs);
  }
  if (author.status !== "ok" || !author.result || blind?.status !== "ok" || !blind.result) {
    await trail.flush(deps, ref);
    const reason = failedReason(author.status === "ok" ? blind : author);
    return empty("couldnt_compute", "warn", reason, verification, programs);
  }
  const value = author.result;
  const same = await deps.verify.compare({
    a: value,
    candidates: [blind.result],
    tolerance: deps.settings.numericTolerance,
  });
  if (!same.results?.[0]?.equal) {
    await trail.flush(deps, ref);
    return empty("disagree", "fail", "programs_disagree", { ...verification, status: "failed" }, programs);
  }

  const answer = await buildAnswer(deps, trail, q, value, seed, inputs);
  await trail.flush(deps, ref);
  if (answer === null) return empty("couldnt_compute", "warn", "program_failed", verification, programs);
  if (answer.denied) {
    return empty("denied", "fail", "sandbox_denial", { ...verification, status: "failed" }, programs);
  }
  const modelClaim = await claimIfDifferent(deps, stated, value);
  return empty(
    "computed",
    warnings.length > 0 ? "warn" : "pass",
    "ok",
    {
      ...verification,
      status: "computed",
      answerSource: "computed",
      result: value.latex,
      ...(modelClaim === undefined ? {} : { modelClaim }),
      ...(answer.distractors ? { distractors: answer.distractors } : {}),
    },
    {
      ...programs,
      options: answer.options,
      correctAnswer: answer.correctAnswer,
      numericTolerance: answer.numericTolerance,
      mistakesDropped: answer.dropped,
    },
  );
}
