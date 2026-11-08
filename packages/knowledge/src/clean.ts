import type { SourceWarning } from "@gem/shared";

/**
 * Clean-up of the converter's Markdown (docs/P2.2.md §5), before a creator sees it. Marker's output is close to what
 * the parser wants; what's left is mathematics written in other ways, image links (figures aren't kept), headings with
 * nothing in them, and running headers and footers that repeat on every page.
 */

export interface CleanInput {
  markdown: string;
  pageCount: number;
  pagesConverted: number;
  /** Images the converter found and dropped. */
  figures: number;
}

export interface Cleaned {
  markdown: string;
  warnings: SourceWarning[];
}

/** Fewer characters a page than this and the page was probably a scan the reader missed. */
export const LOW_TEXT_CHARS_PER_PAGE = 200;
/** A line this short, seen this often, is a running header or footer. */
const RUNNING_MAX_CHARS = 80;
const RUNNING_MIN_REPEATS = 3;

interface Segment {
  text: string;
  /** Fenced code is left exactly as it is. */
  code: boolean;
}

/** Splits at ``` fences so no rewrite touches code. */
function segments(markdown: string): Segment[] {
  const out: Segment[] = [];
  let code = false;
  let buf: string[] = [];
  const flush = () => {
    if (buf.length > 0) out.push({ text: buf.join("\n"), code });
    buf = [];
  };
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (!code) {
        flush();
        code = true;
        buf.push(line);
      } else {
        buf.push(line);
        flush();
        code = false;
      }
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

/** `<math>…</math>`, `\(…\)` and `\[…\]` become `$…$` and `$$…$$`, the forms the rest of the product reads. */
function rewriteMath(text: string): string {
  return text
    .replace(/<math\s+display=["']block["'][^>]*>([\s\S]*?)<\/math>/gi, (_m, body: string) => `\n$$${body.trim()}$$\n`)
    .replace(/<math[^>]*>([\s\S]*?)<\/math>/gi, (_m, body: string) => `$${body.trim()}$`)
    .replace(/\\\[([\s\S]*?)\\\]/g, (_m, body: string) => `\n$$${body.trim()}$$\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_m, body: string) => `$${body.trim()}$`);
}

/**
 * Display mathematics alone on its lines, with a blank line either side, so it is a block and not part of a sentence.
 * The `$$` marks are paired in order (the first opens, the second closes, and so on; `\$$` is a dollar sign), not
 * matched by a pattern: one missed opening then can't pair a closing with the next equation's opening, which turned
 * every equation after it inside out (a book's chapter became one 15,000-character "equation"). An odd number of
 * marks is left as it is; `unbalanced_math` says so. An empty pair (`$$$$`) is dropped.
 */
export function isolateDisplayMath(text: string): string {
  const marks: number[] = [];
  for (let at = text.indexOf("$$"); at >= 0; at = text.indexOf("$$", at + 2)) {
    if (text[at - 1] !== "\\") marks.push(at);
  }
  if (marks.length === 0 || marks.length % 2 !== 0) return text;
  let out = "";
  let last = 0;
  for (let k = 0; k < marks.length; k += 2) {
    const open = marks[k] as number;
    const close = marks[k + 1] as number;
    const body = text.slice(open + 2, close).trim();
    out += text.slice(last, open).replace(/[ \t]+$/, "");
    // Over several lines, the marks go on lines of their own: Markdown closes a multi-line `$$` block only at a
    // line that is `$$` alone, so `\tag{12.12}$$` would leave it open to the end of the book.
    out += body === "" ? " " : body.includes("\n") ? `\n\n$$\n${body}\n$$\n\n` : `\n\n$$${body}$$\n\n`;
    last = close + 2;
  }
  out += text.slice(last).replace(/^[ \t]+/, "");
  return out.replace(/\n{3,}/g, "\n\n");
}

/** Which lines are display mathematics: a `$$` mark on them, or between an opening and a closing one. */
export function displayMathLines(lines: string[]): boolean[] {
  let inside = false;
  return lines.map((line) => {
    const marks = (line.match(/(?<!\\)\$\$/g) ?? []).length;
    const math = inside || marks > 0;
    if (marks % 2 === 1) inside = !inside;
    return math;
  });
}

const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;

/** A `$` that opens a price, not mathematics: `$5`, `$1,200.50`, not followed by anything mathematical. */
const PRICE = /\$\d[\d,]*(?:\.\d+)?(?![\d^_{\\=+*/-])/g;

/** Counts mathematics delimiters that never close, ignoring prices and escaped dollar signs. */
export function unbalancedMath(text: string): boolean {
  const body = text
    .replace(/\\\$/g, "")
    .replace(/`[^`\n]*`/g, "")
    .replace(PRICE, "");
  const display = body.match(/\$\$/g)?.length ?? 0;
  if (display % 2 !== 0) return true;
  const inline = (body.replace(/\$\$/g, "").match(/\$/g) ?? []).length;
  return inline % 2 !== 0;
}

/** The heading the first paragraph with an unclosed equation sits under, so there is somewhere to look. */
export function headingOfUnbalancedMath(markdown: string): string | undefined {
  let heading: string | undefined;
  for (const block of markdown.split(/\n[^\S\n]*\n/)) {
    const h = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(block);
    if (h && block.trimStart().startsWith("#")) heading = h[1]?.replace(/[*_`]/g, "").trim();
    if (unbalancedMath(block)) return heading;
  }
  return undefined;
}

const MATHY = /[\\^_={}]/;

/**
 * Closes the one inline equation in a paragraph that never closes. `$` opens when something other than a space
 * follows and closes when something other than a space comes before (the Markdown rule), prices and `\$` aside. A
 * single opener left over at the end is closed at the end of the sentence if what follows it looks like mathematics,
 * and is a stray mark (dropped) if not. Anything less clear (a stray mid-paragraph, `$$`) is left for `unbalanced_math`.
 */
export function repairInlineMath(paragraph: string): { text: string; repaired: boolean } {
  if (paragraph.includes("$$")) return { text: paragraph, repaired: false };
  const skip = [...paragraph.matchAll(/\\\$|`[^`\n]*`/g), ...paragraph.matchAll(PRICE)].map((m) => [
    m.index as number,
    (m.index as number) + m[0].length,
  ]);
  const marks: number[] = [];
  for (let i = 0; i < paragraph.length; i++) {
    if (paragraph[i] === "$" && !skip.some(([a, b]) => i >= (a as number) && i < (b as number))) marks.push(i);
  }
  let open: number | null = null;
  for (const at of marks) {
    const next = paragraph[at + 1];
    const prev = paragraph[at - 1];
    if (open === null) {
      if (next !== undefined && !/\s/.test(next)) open = at;
    } else if (prev !== undefined && !/\s/.test(prev)) open = null;
  }
  if (open === null) return { text: paragraph, repaired: false };
  const rest = paragraph.slice(open + 1);
  // Only the last opener, in a short tail that is mathematics: otherwise the mark is noise.
  if (MATHY.test(rest) && rest.length <= 200) {
    const tail = /[.,;:!?)]*\s*$/.exec(rest);
    const cut = open + 1 + (tail?.index ?? rest.length);
    return { text: `${paragraph.slice(0, cut)}$${paragraph.slice(cut)}`, repaired: true };
  }
  return { text: paragraph.slice(0, open) + paragraph.slice(open + 1), repaired: true };
}

function repairMath(text: string, onRepair: () => void): string {
  return text
    .split(/(\n[^\S\n]*\n)/)
    .map((block, i) => {
      if (i % 2 === 1 || !block.includes("$")) return block;
      const r = repairInlineMath(block);
      if (r.repaired) onRepair();
      return r.text;
    })
    .join("");
}

function dropEmptyHeadings(text: string): string {
  return text.replace(/^#{1,6}[ \t]*$/gm, "").replace(/^#{1,6}[ \t]+[#\s*_`]*$/gm, "");
}

function runningLines(prose: string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const raw of prose) {
    const line = raw.trim();
    if (line === "" || line.length > RUNNING_MAX_CHARS) continue;
    // Headings, lists, tables, mathematics and numbers alone are content, even when they repeat.
    if (/^([#>|$*+-]|\d+[.)]\s|\d+$)/.test(line)) continue;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n >= RUNNING_MIN_REPEATS).map(([line]) => line));
}

export function cleanMarkdown(input: CleanInput): Cleaned {
  const warnings: SourceWarning[] = [];
  let images = 0;
  let repaired = 0;

  const parts = segments(input.markdown.replace(/\r\n?/g, "\n"));
  const rewritten = parts.map((p) => {
    if (p.code) return p;
    const text = isolateDisplayMath(rewriteMath(p.text)).replace(IMAGE, () => {
      images++;
      return "";
    });
    return { ...p, text: dropEmptyHeadings(repairMath(text, () => repaired++)) };
  });

  // A line that repeats on every page is dropped, but only a paragraph line: not in code, and not in display
  // mathematics, where `\end{aligned}` repeats in every other equation of a book.
  const prose = rewritten.map((p) => {
    const lines = p.text.split("\n");
    return { p, lines, math: p.code ? lines.map(() => true) : displayMathLines(lines) };
  });
  const running = runningLines(prose.flatMap(({ lines, math }) => lines.filter((_, i) => !math[i])));
  const kept = prose.map(({ p, lines, math }) =>
    p.code ? p.text : lines.filter((line, i) => math[i] || !running.has(line.trim())).join("\n"),
  );

  const markdown = `${kept
    .join("\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;

  const figures = Math.max(images, input.figures);
  if (figures > 0) warnings.push({ code: "figures_dropped", count: figures });
  if (input.pageCount > input.pagesConverted) {
    warnings.push({ code: "pages_skipped", count: input.pageCount - input.pagesConverted });
  }
  const pages = Math.max(1, input.pagesConverted);
  if (markdown.replace(/\s+/g, "").length / pages < LOW_TEXT_CHARS_PER_PAGE) warnings.push({ code: "low_text" });
  if (repaired > 0) warnings.push({ code: "math_repaired", count: repaired });
  if (unbalancedMath(markdown)) {
    const heading = headingOfUnbalancedMath(markdown);
    warnings.push({ code: "unbalanced_math", ...(heading ? { heading } : {}) });
  }
  return { markdown, warnings };
}
