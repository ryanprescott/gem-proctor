/** Text comparison for L2 and L3: what counts as "the same words" in a model's copy of a passage. */

/** Whitespace, dashes, minus signs, quotes and Markdown emphasis don't change what a quote says. */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[−‐-―]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export const tokens = (text: string): string[] =>
  normalizeText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

function lcs(a: string[], b: string[]): number {
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      row[j] =
        a[i - 1] === b[j - 1] ? (previous[j - 1] as number) + 1 : Math.max(previous[j] as number, row[j - 1] as number);
    }
    previous = row;
  }
  return previous[b.length] as number;
}

/**
 * How much of the quote is in the text, in order: the best window of the text against the quote's tokens, 0 to 1. A
 * slightly misquoted sentence scores high, and a sentence that isn't there scores low.
 */
export function bestWindowSimilarity(quote: string, text: string): number {
  const q = tokens(quote);
  const t = tokens(text);
  if (q.length === 0) return 0;
  if (t.length === 0) return 0;
  const size = Math.min(q.length + 2, t.length);
  let best = 0;
  for (let start = 0; start <= t.length - Math.min(size, t.length); start++) {
    const window = t.slice(start, start + size);
    const score = (2 * lcs(q, window)) / (q.length + Math.min(window.length, q.length));
    if (score > best) best = score;
    if (best >= 1) break;
  }
  return Math.min(best, 1);
}

/** Numbers as written: `1,000` is one number, and `-3` keeps its sign only when it isn't a subtraction. */
export function numbersIn(text: string): string[] {
  return (text.replace(/\$[^$]*\$/g, " ").match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/,/g, ""));
}
