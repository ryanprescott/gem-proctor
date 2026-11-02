/**
 * How well a conversion read a document whose answer is known (docs/P2.2.md M26): the formulas it was meant to find, as
 * LaTeX, and its headings. Formulas are compared after the differences that don't change what an equation says (spacing,
 * `\left`, `\cdot` against `*`, a bold wrapper) are removed; anything else is a miss.
 */

export interface Expected {
  formulas: string[];
  headings: { level: number; title: string }[];
}

export interface Score {
  formulasExpected: number;
  /** Expected formulas found in the output, once each. */
  formulasMatched: number;
  /** Every `$…$` and `$$…$$` in the output, whether expected or not. */
  formulasInOutput: number;
  headingsExpected: number;
  headingsFound: number;
  /** Expected formulas that weren't found, for a report. */
  missed: string[];
}

export function normalizeLatex(latex: string): string {
  return latex
    .replace(/\\(left|right|,|;|!|\s)/g, "")
    .replace(/\\(ldots|dots|cdots)/g, "...")
    .replace(/\\cdot(?![a-z])/g, "*")
    .replace(/\\(mathbf|mathrm|text|operatorname)\{([^}]*)\}/g, "$2")
    .replace(/[\s{}]/g, "");
}

const stripEmphasis = (text: string) =>
  text
    .replace(/[*_`#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

export function formulasIn(markdown: string): string[] {
  return [...markdown.matchAll(/\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g)]
    .map((m) => (m[1] ?? m[2] ?? "").trim())
    .filter(Boolean);
}

export function scoreConversion(markdown: string, expected: Expected): Score {
  const found = formulasIn(markdown).map(normalizeLatex);
  const pool = [...found];
  const missed: string[] = [];
  let matched = 0;
  for (const formula of expected.formulas) {
    const at = pool.indexOf(normalizeLatex(formula));
    if (at < 0) {
      missed.push(formula);
      continue;
    }
    pool.splice(at, 1);
    matched += 1;
  }
  const headings = [...markdown.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => stripEmphasis(m[1] ?? ""));
  const headingsFound = expected.headings.filter((h) => headings.includes(stripEmphasis(h.title))).length;
  return {
    formulasExpected: expected.formulas.length,
    formulasMatched: matched,
    formulasInOutput: found.length,
    headingsExpected: expected.headings.length,
    headingsFound,
    missed,
  };
}
