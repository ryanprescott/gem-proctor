import type { FlowBOutcome, L7Reason, Verification, VerificationItem, VerifyValue } from "@gem/shared";
import {
  classify,
  type L7Deps,
  type ProgramRun,
  pickOption,
  type RunRef,
  RunTrail,
  runWithRepair,
  writeBlindProgram,
} from "./programs.ts";

/**
 * Flow B: an imported or hand-edited question, whose stated answer is checked (SPEC §3A.3.1). It works on the
 * normalized value, not the validated quiz: a question that failed validation because its answer isn't among its
 * options is exactly the one that needs this (sample Q7).
 */

export interface ImportedQuestion {
  id: number;
  question: string;
  options: string[] | null;
  correctAnswer: string | null;
  acceptedAnswers: string[];
  type: string | null;
  /** The evidence quotes, when the question has any. */
  passage: string;
}

/** Reads a question out of a normalized value that may not have passed validation. */
export function importedQuestion(value: unknown, index: number): ImportedQuestion {
  const q = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : null);
  const evidence = Array.isArray(q.evidence) ? (q.evidence as { quote?: unknown }[]) : [];
  return {
    id: typeof q.id === "number" ? q.id : index + 1,
    question: typeof q.question === "string" ? q.question : "",
    options: strings(q.options),
    correctAnswer: typeof q.correctAnswer === "string" ? q.correctAnswer : null,
    acceptedAnswers: strings(q.acceptedAnswers) ?? [],
    type: typeof q.type === "string" ? q.type : null,
    passage: evidence
      .map((e) => (typeof e.quote === "string" ? e.quote : ""))
      .filter(Boolean)
      .join("\n"),
  };
}

const NO_PASSAGE = "(no source passage)";

const STATUS: Record<FlowBOutcome, Verification["status"]> = {
  verified: "computed",
  wrong_answer: "failed",
  no_match: "failed",
  ambiguous: "failed",
  couldnt_check: "unverified",
  not_computable: "unverified",
  denied: "failed",
};

function item(
  q: ImportedQuestion,
  outcome: FlowBOutcome,
  reason: L7Reason,
  rest: {
    computable?: boolean;
    blind?: ProgramRun | null;
    matchedOption?: string | null;
    suggestedFix?: string | null;
    status?: Verification["status"];
  } = {},
): VerificationItem {
  const { blind = null, matchedOption = null, suggestedFix = null } = rest;
  return {
    questionId: q.id,
    outcome,
    reason,
    computable: rest.computable ?? true,
    blind: blind
      ? {
          program: blind.program,
          status: blind.status,
          result: blind.result,
          error: blind.error,
          repaired: blind.repaired,
        }
      : null,
    matchedOption,
    suggestedFix,
    verification: {
      status: rest.status ?? STATUS[outcome],
      answerSource: "stated",
      ...(blind ? { program: blind.program } : {}),
      ...(blind?.result ? { result: blind.result.latex } : {}),
      ...(matchedOption === null ? {} : { matchedOption }),
      checkedAt: new Date().toISOString(),
    },
  };
}

async function notComputable(deps: L7Deps, q: ImportedQuestion): Promise<VerificationItem> {
  const options = q.options ?? [];
  if (options.length === 0 || q.correctAnswer === null) {
    return item(q, "not_computable", "not_computable", { computable: false });
  }
  const index = await pickOption(deps, q.question, options);
  if (index === null) return item(q, "not_computable", "not_computable", { computable: false });
  const agreed = options[index] === q.correctAnswer;
  return item(q, "not_computable", agreed ? "model_agreed" : "model_disagreed", {
    computable: false,
    status: agreed ? "model_agreed" : "unverified",
  });
}

interface Parsed {
  texts: string[];
  values: (VerifyValue | null)[];
  unparseable: boolean;
  allProse: boolean;
}

async function parse(deps: L7Deps, texts: string[]): Promise<Parsed> {
  if (texts.length === 0) return { texts, values: [], unparseable: false, allProse: false };
  const reply = await deps.verify.parseOptions({ texts });
  if (reply.status !== "ok" || !reply.results) return { texts, values: [], unparseable: true, allProse: false };
  const values = reply.results.map((r) => (r.ok ? r.value : null));
  const allProse = reply.results.every((r) => !r.ok && r.reason === "text");
  // Prose ("Undefined") can't equal a value. Math that can't be read might, so it's a reason not to decide.
  const unparseable = reply.results.some((r) => !r.ok && r.reason === "parse_error");
  return { texts, values, unparseable, allProse };
}

async function matches(deps: L7Deps, result: VerifyValue, parsed: Parsed) {
  const known = parsed.values.flatMap((v, i) => (v ? [{ value: v, text: parsed.texts[i] as string }] : []));
  if (known.length === 0) return { equal: [] as string[], guard: false };
  const reply = await deps.verify.compare({
    a: result,
    candidates: known.map((k) => k.value),
    tolerance: deps.settings.numericTolerance,
  });
  const results = reply.results ?? [];
  return {
    equal: known.filter((_, i) => results[i]?.equal).map((k) => k.text),
    guard: results.some((r) => r.guard),
  };
}

/** Choice questions: against the options. */
async function decideOptions(
  deps: L7Deps,
  q: ImportedQuestion,
  parsed: Parsed,
  blind: ProgramRun,
  result: VerifyValue,
) {
  if (parsed.values.every((v) => v === null)) {
    return item(q, "couldnt_check", "option_unparseable", { blind });
  }
  const { equal, guard } = await matches(deps, result, parsed);
  if (equal.length > 1) return item(q, "ambiguous", "ambiguous", { blind });
  if (equal.length === 1) {
    const matchedOption = equal[0] as string;
    if (matchedOption === q.correctAnswer) return item(q, "verified", "ok", { blind, matchedOption });
    return item(q, "wrong_answer", "wrong_answer", { blind, matchedOption, suggestedFix: matchedOption });
  }
  if (parsed.unparseable) return item(q, "couldnt_check", "option_unparseable", { blind });
  if (guard) return item(q, "couldnt_check", "comparison_guard", { blind });
  // A program that picked an example `n`, against options written in `n`: a number can't show those are wrong.
  const symbolic = parsed.values.some((v) => v?.kind === "expression" && v.decimal === undefined);
  if (symbolic && result.decimal !== undefined) return item(q, "couldnt_check", "comparison_symbolic", { blind });
  return item(q, "no_match", "no_match", { blind });
}

/** Short-answer and numeric questions: against `correctAnswer` and `acceptedAnswers`. */
async function decideTyped(deps: L7Deps, q: ImportedQuestion, blind: ProgramRun, result: VerifyValue) {
  const accepted = [...(q.correctAnswer === null ? [] : [q.correctAnswer]), ...q.acceptedAnswers];
  const parsed = await parse(deps, accepted);
  if (parsed.values.every((v) => v === null)) {
    return item(q, "couldnt_check", "option_unparseable", { blind });
  }
  const { equal, guard } = await matches(deps, result, parsed);
  if (equal.length > 0) return item(q, "verified", "ok", { blind, matchedOption: equal[0] as string });
  if (guard) return item(q, "couldnt_check", "comparison_guard", { blind });
  const suggestedFix = q.type === "numeric" ? (result.decimal ?? result.text) : result.text;
  return item(q, "wrong_answer", "wrong_answer", { blind, suggestedFix });
}

export interface FlowBOptions {
  /** A hand-edited question keeps its classification: no classify call. */
  knownComputable?: boolean;
}

export async function checkQuestion(
  deps: L7Deps,
  q: ImportedQuestion,
  ref: RunRef,
  opts: FlowBOptions = {},
): Promise<VerificationItem> {
  if (q.question.trim() === "") return item(q, "couldnt_check", "invalid_question", { computable: false });
  if (q.type === "multi_choice") return item(q, "not_computable", "not_computable", { computable: false });
  let computable = opts.knownComputable;
  if (computable === undefined) {
    const verdict = await classify(deps, q.question, q.options ?? []);
    if (verdict === null) return item(q, "couldnt_check", "llm_failed", { computable: false });
    computable = verdict.computable;
  }
  if (!computable) return notComputable(deps, q);
  // Options that are all sentences hold no value to compare with: computing can't check this question, whatever
  // the classification said about the text around them.
  const parsed = q.options ? await parse(deps, q.options) : null;
  if (parsed?.allProse) return notComputable(deps, q);

  const program = await writeBlindProgram(deps, q.question, q.passage || NO_PASSAGE);
  if (program === null) return item(q, "couldnt_check", "llm_failed");
  const trail = new RunTrail();
  const blind = await runWithRepair(deps, trail, { kind: "blind", program, question: q.question });
  if (blind.status === "sandbox_denial") {
    await trail.flush(deps, ref);
    return item(q, "denied", "sandbox_denial", { blind });
  }
  if (blind.status !== "ok" || !blind.result) {
    await trail.flush(deps, ref);
    const reason = blind.status === "timeout" ? "program_timeout" : "program_failed";
    return item(q, "couldnt_check", reason, { blind });
  }
  const decided = parsed
    ? await decideOptions(deps, q, parsed, blind, blind.result)
    : await decideTyped(deps, q, blind, blind.result);
  await trail.flush(deps, ref, decided.matchedOption);
  return decided;
}
