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

/** Display mathematics alone on its lines, with a blank line either side, so it is a block and not part of a sentence. */
function isolateDisplayMath(text: string): string {
  return text.replace(/([^\n])\s*\$\$([\s\S]+?)\$\$\s*(?=[^\n]|$)/g, (m, before: string, body: string) =>
    before === "$" ? m : `${before}\n\n$$${body.trim()}$$\n\n`,
  );
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

  const parts = segments(input.markdown.replace(/\r\n?/g, "\n"));
  const rewritten = parts.map((p) => {
    if (p.code) return p;
    const text = isolateDisplayMath(rewriteMath(p.text)).replace(IMAGE, () => {
      images++;
      return "";
    });
    return { ...p, text: dropEmptyHeadings(text) };
  });

  // A line that repeats on every page is dropped, but only a paragraph line: and only outside code.
  const proseLines = rewritten.filter((p) => !p.code).flatMap((p) => p.text.split("\n"));
  const running = runningLines(proseLines);
  const kept = rewritten.map((p) =>
    p.code
      ? p.text
      : p.text
          .split("\n")
          .filter((line) => !running.has(line.trim()))
          .join("\n"),
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
  if (unbalancedMath(markdown)) warnings.push({ code: "unbalanced_math" });
  return { markdown, warnings };
}
