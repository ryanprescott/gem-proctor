import { type LayerResult, layerResult, type ValidationIssue } from "@gem/shared";
import { normalizeText, numbersIn } from "./text.ts";

/** L3: answer leakage and form (SPEC §3A.3), plus the P6 number check from the prompts doc (P2.md §5). */

export interface FormInput {
  question: string;
  options: { text: string; isCorrect: boolean }[] | null;
  correctAnswer: string | null;
  explanation: string;
  /** The cited chunks' text and the quotes: numbers there are the source's own. */
  passages: string[];
  computable: boolean;
}

export const QUESTION_MAX_CHARS = 600;
export const OPTION_MAX_CHARS = 300;
/** Shorter answers ("n", "2", "true") turn up in question text by chance. */
const LEAK_MIN_CHARS = 4;
/** How many questions it takes before "the longest option is always right" means anything. */
export const LONGEST_MIN_QUESTIONS = 4;

const ALL_OR_NONE =
  /\b(all|none|both|neither) of (the|these|those) (above|options|answers|choices)\b|\b(both|neither) (a|b|c|d) (and|nor) (a|b|c|d)\b/i;

export function checkForm(q: FormInput, opts: { allowAllOfAbove?: boolean } = {}): LayerResult {
  const issues: ValidationIssue[] = [];
  const answer = q.correctAnswer ? normalizeText(q.correctAnswer) : "";
  if (answer.length >= LEAK_MIN_CHARS && normalizeText(q.question).includes(answer)) {
    issues.push({ code: "answer_in_question", severity: "warn", params: {} });
  }
  if (!opts.allowAllOfAbove && q.options?.some((o) => ALL_OR_NONE.test(o.text))) {
    issues.push({ code: "all_or_none_of_above", severity: "fail", params: {} });
  }
  if (q.question.length > QUESTION_MAX_CHARS) {
    issues.push({ code: "text_too_long", severity: "warn", params: { field: "question", length: q.question.length } });
  }
  const long = q.options?.find((o) => o.text.length > OPTION_MAX_CHARS);
  if (long)
    issues.push({ code: "text_too_long", severity: "warn", params: { field: "option", length: long.text.length } });

  const known = new Set(numbersIn([q.question, ...(q.options ?? []).map((o) => o.text), ...q.passages].join(" ")));
  for (const n of numbersIn(q.explanation)) {
    if (!known.has(n)) {
      issues.push({ code: "number_in_explanation", severity: "warn", params: { number: n } });
      break;
    }
  }
  return layerResult("L3", issues);
}

/**
 * The longest option being the right one on every question is a tell, though no single question shows it. Over a set,
 * it's a warning on the questions it applies to. Computed options are the sandbox's, so they don't count.
 */
export function longestAlwaysCorrect<T extends { id: string; options: FormInput["options"]; computable: boolean }>(
  questions: T[],
): string[] {
  const choice = questions.filter((q) => !q.computable && (q.options?.length ?? 0) >= 3);
  if (choice.length < LONGEST_MIN_QUESTIONS) return [];
  const always = choice.every((q) => {
    const options = q.options ?? [];
    const correct = options.find((o) => o.isCorrect);
    const longest = Math.max(...options.map((o) => o.text.length));
    return correct !== undefined && correct.text.length === longest;
  });
  return always ? choice.map((q) => q.id) : [];
}
