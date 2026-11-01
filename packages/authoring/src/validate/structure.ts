import { type LayerResult, layerResult, type ValidationIssue, type ValidationIssueCode } from "@gem/shared";
import { normalizeText, numbersIn } from "./text.ts";

/** L1: the cross-field rules Zod can't state (SPEC §3A.3). Everything here is about one question's own fields. */

/** What L1 reads, whichever way the question got here: from the model, or an edit. */
export interface StructureInput {
  type: string;
  computable: boolean;
  question: string;
  objectiveIds: string[];
  evidence: { chunkId: string; quote: string }[];
  inputs: { name: string; from: string; sourceText: string }[];
  answerProgram: string;
  options: { text: string; isCorrect: boolean }[];
  mistakes: unknown[];
}

export interface StructureContext {
  /** The ids the model was given. */
  objectiveIds: ReadonlySet<string>;
  /** The chunks the call sent. A citation to anything else can't be checked (SPEC §3A.2). */
  chunkIds: ReadonlySet<string>;
}

const COMPUTABLE_TYPES = new Set(["single_choice", "true_false", "numeric", "short_answer"]);
const issue = (
  code: ValidationIssueCode,
  severity: "warn" | "fail",
  params: ValidationIssue["params"] = {},
): ValidationIssue => ({ code, severity, params });

/** `{name}` placeholders. A LaTeX group like `x_{1}` isn't one: it comes right after `_` or `^`. */
export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(/(?<![_^\\a-zA-Z}])\{([a-zA-Z][a-zA-Z0-9]{0,5})\}/g)].map((m) => m[1] as string);
}

const withoutPlaceholders = (text: string) => text.replace(/\{[a-zA-Z][a-zA-Z0-9]{0,5}\}/g, " ");

function computableIssues(q: StructureInput): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  if (!COMPUTABLE_TYPES.has(q.type)) out.push(issue("not_computable_type", "fail", { type: q.type }));
  if (q.answerProgram.trim() === "") out.push(issue("program_missing", "fail"));
  if (q.options.length > 0) out.push(issue("options_from_model", "fail"));
  if (q.type === "single_choice" && (q.mistakes.length < 2 || q.mistakes.length > 3)) {
    out.push(issue("mistakes_count", "fail", { count: q.mistakes.length }));
  }

  const used = new Set(placeholdersIn(q.question));
  const declared = new Set(q.inputs.map((i) => i.name));
  if (used.size === 0 && declared.size > 0) out.push(issue("no_placeholders", "fail"));
  for (const name of used) {
    if (!declared.has(name)) out.push(issue("placeholder_undeclared", "fail", { name }));
  }
  if (used.size > 0) {
    for (const name of declared) {
      if (!used.has(name)) out.push(issue("input_unused", "fail", { name }));
    }
  }

  const quotes = q.evidence.map((e) => normalizeText(e.quote)).join("\n");
  for (const input of q.inputs) {
    if (input.from === "source" && !quotes.includes(normalizeText(input.sourceText))) {
      out.push(issue("source_not_in_quote", "fail", { name: input.name }));
    }
  }
  const allowed = new Set(numbersIn(q.evidence.map((e) => e.quote).join(" ")));
  for (const n of numbersIn(withoutPlaceholders(q.question))) {
    if (!allowed.has(n)) out.push(issue("number_outside_placeholder", "warn", { number: n }));
  }
  return out;
}

function conceptIssues(q: StructureInput): ValidationIssue[] {
  const correct = q.options.filter((o) => o.isCorrect).length;
  const out: ValidationIssue[] = [];
  if (q.type === "single_choice" || q.type === "true_false") {
    if (correct > 1) out.push(issue("multiple_correct", "fail", { count: correct }));
    if (correct === 0) out.push(issue("no_correct", "fail"));
  }
  if (q.type === "multi_choice" && correct < 1) out.push(issue("too_few_correct", "fail", { count: correct }));
  if (q.type === "true_false") {
    const texts = q.options.map((o) => o.text).sort();
    if (texts.length !== 2 || texts[0] !== "False" || texts[1] !== "True")
      out.push(issue("true_false_options", "fail"));
  }
  return out;
}

export function checkStructure(q: StructureInput, ctx: StructureContext): LayerResult {
  const issues: ValidationIssue[] = q.computable ? computableIssues(q) : conceptIssues(q);
  const texts = q.options.map((o) => normalizeText(o.text));
  if (new Set(texts).size !== texts.length) issues.push(issue("options_not_unique", "fail"));
  for (const id of q.objectiveIds) {
    if (!ctx.objectiveIds.has(id)) issues.push(issue("objective_unknown", "fail", { id }));
  }
  for (const e of q.evidence) {
    if (!ctx.chunkIds.has(e.chunkId)) issues.push(issue("chunk_unknown", "fail", { chunkId: e.chunkId }));
  }
  return layerResult("L1", issues);
}

/** L1's last rule, which holds after L7 has built the answer: exactly one option is true (SPEC §3A.3). */
export function checkAfterL7(q: {
  type: string;
  options: { isCorrect: boolean }[] | null;
  correctAnswer: string | null;
}): LayerResult {
  const issues: ValidationIssue[] = [];
  if (q.correctAnswer === null) issues.push(issue("answer_missing", "fail"));
  if (q.options && q.type !== "multi_choice" && q.options.filter((o) => o.isCorrect).length !== 1) {
    issues.push(issue("not_one_true", "fail"));
  }
  return layerResult("L1", issues);
}
