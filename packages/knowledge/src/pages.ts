/**
 * A PDF's pages as read, made into one Markdown text (SPEC §3C.1). Marker reads each page as it looks, so a book's
 * running headers, page numbers and split chapter titles come through, and its headings are only as good as what it
 * could see. Here, with the pages kept apart and the PDF's own outline:
 *
 * - **Running headers and page numbers go.** A short line at a page's top or bottom that recurs at an edge on pages
 *   close together (three or more, at most two pages apart) is a running header: "1 Vectors" on every other page.
 *   Digits don't count, so each chapter's header is one pattern. A heading that recurs far apart ("Exercises", once
 *   a chapter) is content. A bare number or roman numeral at an edge is a page number.
 * - **The outline makes the headings,** where the PDF has one: each bookmark is found on its page by its title (the
 *   numbering aside: "1.1", "Chapter 1", "I") and becomes a heading at its depth; one not found is put at the top of
 *   its page. Marker's other headings become bold text, so the table of contents is the book's own. A "Chapter 1"
 *   line on its own goes. Without an outline, Marker's headings stay.
 * - For part of a book (a chapter), depths count from that part's top, so the chapter is `#`.
 *
 * The clean-up of what's inside the text (equations, images, `clean.ts`) runs on the result as for any conversion.
 */

import { displayMathLines } from "./clean.ts";

export interface PageText {
  page: number;
  markdown: string;
}

export interface OutlineItem {
  title: string;
  level: number;
  page: number | null;
}

/** How many lines at each end of a page count as its edge. */
const EDGE_TOP = 3;
const EDGE_BOTTOM = 2;
const RUNNING_MAX_CHARS = 60;
const RUNNING_RUN = 3;
const RUNNING_GAP = 2;

const HEADING = /^(#{1,6})\s+(.*)$/;
const PAGE_NUMBER = /^[*_\s]*(\d{1,4}|[ivxlcdm]{1,8})[*_\s]*$/i;
const CHAPTER_LABEL = /^(chapter|part|appendix|lecture|unit)\s+([\d]+|[ivxlcdm]+|[a-z])\.?$/i;

/** A line's text without its Markdown: no heading marks, emphasis or extra spaces. */
function plain(line: string): string {
  return line.replace(HEADING, "$2").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
}

/** A title to compare: lower case, its numbering ("1.1", "Chapter 1", "I") and end punctuation gone. */
export function titleKey(text: string): string {
  return plain(text)
    .toLowerCase()
    .replace(/^(chapter|part|section|appendix|lecture|unit)\s+([\d.]+|[ivxlcdm]+|[a-z])[.:]?\s+/i, "")
    .replace(/^(\d+(\.\d+)*|[ivxlcdm]+)\.?\s+/i, "")
    .replace(/[.:;,!?]+$/, "")
    .trim();
}

/** A line as a pattern for running headers: digits don't count, so "1 Vectors" and "12 Vectors" are one. */
const runningKey = (line: string) => plain(line).toLowerCase().replace(/\d+/g, "0");

/**
 * Whether a line could be a running header: short, with words in it, and no mathematics. A line that is only `$$`
 * (an equation set over several lines) sits at page edges too, and dropping one unpairs every equation after it.
 */
const headerLike = (line: string) => {
  const text = plain(line);
  return text.length <= RUNNING_MAX_CHARS && /\p{L}/u.test(text) && !text.includes("$");
};

/** The indexes of a page's edge lines: the first and last non-empty ones that aren't display mathematics. */
function edges(lines: string[]): number[] {
  const math = displayMathLines(lines);
  const filled = lines.map((l, i) => (l.trim() === "" || math[i] ? -1 : i)).filter((i) => i >= 0);
  return [...new Set([...filled.slice(0, EDGE_TOP), ...filled.slice(-EDGE_BOTTOM)])];
}

/** Patterns that recur at page edges on pages close together: three or more, each at most two pages from the last. */
function runningKeys(pages: { page: number; lines: string[] }[]): Set<string> {
  const seen = new Map<string, number[]>();
  for (const { page, lines } of pages) {
    for (const i of edges(lines)) {
      const line = lines[i] as string;
      if (!headerLike(line)) continue;
      const key = runningKey(line);
      const at = seen.get(key) ?? [];
      if (at.at(-1) !== page) at.push(page);
      seen.set(key, at);
    }
  }
  const running = new Set<string>();
  for (const [key, at] of seen) {
    let run = 1;
    for (let i = 1; i < at.length && run < RUNNING_RUN; i++) {
      run = (at[i] as number) - (at[i - 1] as number) <= RUNNING_GAP ? run + 1 : 1;
    }
    if (run >= RUNNING_RUN) running.add(key);
  }
  return running;
}

/** The pages made into one text, as above. `pages` are the pages to use, in any order; `outline` the whole PDF's. */
export function assemblePages(pages: PageText[], outline: OutlineItem[] = []): string {
  const sorted = [...pages].sort((a, b) => a.page - b.page);
  const included = new Set(sorted.map((p) => p.page));
  const items = outline.filter((o) => o.page !== null && included.has(o.page) && titleKey(o.title) !== "");
  const top = items.length > 0 ? Math.min(...items.map((o) => o.level)) : 0;
  const byPage = new Map<number, OutlineItem[]>();
  for (const o of items) byPage.set(o.page as number, [...(byPage.get(o.page as number) ?? []), o]);

  const split = sorted.map((p) => ({ page: p.page, lines: p.markdown.split("\n") }));
  const running = runningKeys(split);

  const out: string[] = [];
  for (const { page, lines } of split) {
    const here = byPage.get(page) ?? [];
    const protectedKeys = new Set(here.map((o) => titleKey(o.title)));
    const keep = lines.map(() => true);
    for (const i of edges(lines)) {
      const line = lines[i] as string;
      if (protectedKeys.has(titleKey(line))) continue;
      if (PAGE_NUMBER.test(plain(line)) || running.has(runningKey(line))) keep[i] = false;
    }
    let body = lines.filter((_, i) => keep[i]);

    if (items.length > 0) {
      // The outline's headings, in order, each found after the one before it; Marker's others become bold text.
      const matched = new Map<number, string>();
      let from = 0;
      const missing: string[] = [];
      for (const o of here) {
        const key = titleKey(o.title);
        const at = body.findIndex((line, i) => i >= from && line.trim() !== "" && titleKey(line) === key);
        const heading = `${"#".repeat(Math.min(o.level - top + 1, 6))} ${o.title.trim()}`;
        if (at < 0) {
          missing.push(heading);
          continue;
        }
        matched.set(at, heading);
        from = at + 1;
      }
      body = body.flatMap((line, i) => {
        const heading = matched.get(i);
        if (heading) return [heading];
        const h = HEADING.exec(line);
        if (!h) return [line];
        const text = plain(line);
        if (CHAPTER_LABEL.test(text)) return [];
        return text === "" ? [] : [`**${text}**`];
      });
      if (missing.length > 0) body = [...missing, "", ...body];
    }
    const text = body.join("\n").trim();
    if (text !== "") out.push(text);
  }
  return out.length > 0 ? `${out.join("\n\n")}\n` : "";
}

/** The outline's entries with the pages they cover: from their page to the page before the next at their depth or above. */
export function outlineRanges(
  outline: OutlineItem[],
  pageCount: number,
): (Omit<OutlineItem, "page"> & { page: number; lastPage: number })[] {
  const withPages = outline.filter((o): o is OutlineItem & { page: number } => o.page !== null);
  return withPages.map((o, i) => {
    const next = withPages.slice(i + 1).find((n) => n.level <= o.level && n.page > o.page);
    return { ...o, lastPage: next ? next.page - 1 : pageCount };
  });
}
