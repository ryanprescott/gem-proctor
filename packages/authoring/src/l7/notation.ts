import type { L7Deps } from "./programs.ts";
import { classify } from "./programs.ts";

/** The notation check on concept questions (SPEC §3A.3.1): any of the four forms sends it to classification. */

const NOTATION: readonly RegExp[] = [
  // math delimiters or LaTeX commands
  /\$|\\\(|\\\[|\\[a-zA-Z]+/,
  // a bracketed or parenthesised list of numbers
  /[[(]\s*[-−]?\d+(?:\.\d+)?\s*(?:,\s*[-−]?\d+(?:\.\d+)?\s*)+[\])]/,
  // numbers joined by an operator or `=`
  /\d\s*[-−+*/=^×·]\s*[-−]?\d/,
  // symbols with sub- or superscripts
  /\b[a-zA-Z]_\{?\w|\b[a-zA-Z]\^\{?\w/,
];

export function hasNotation(text: string): boolean {
  return NOTATION.some((re) => re.test(text));
}

export interface NotationResult {
  outcome: "pass" | "fail";
  /** Null when there's no notation, so no model call was made. */
  classified: boolean | null;
  reason: "ok" | "calculation_as_concept" | "llm_failed";
}

/**
 * A question the generator marked not computable. If its notation classifies as a calculation it fails, to be
 * regenerated as one: the answer the model marked is never used. A failed classification doesn't pass it silently.
 */
export async function checkConceptNotation(
  deps: L7Deps,
  question: string,
  options: readonly string[],
): Promise<NotationResult> {
  if (!hasNotation([question, ...options].join(" "))) return { outcome: "pass", classified: null, reason: "ok" };
  const verdict = await classify(deps, question, options);
  if (verdict === null) return { outcome: "fail", classified: null, reason: "llm_failed" };
  return verdict.computable
    ? { outcome: "fail", classified: true, reason: "calculation_as_concept" }
    : { outcome: "pass", classified: false, reason: "ok" };
}
