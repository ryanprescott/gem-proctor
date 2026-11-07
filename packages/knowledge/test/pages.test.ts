import { describe, expect, test } from "bun:test";
import { assemblePages, type OutlineItem, outlineRanges, titleKey } from "../src/pages.ts";

const WORDS = ["vectors", "matrices", "norms", "angles", "bases", "clusters", "inverses", "projections"];
/** A page's own paragraph: its words differ from page to page, as a book's do. */
const prose = (n: number) =>
  `On this page the ${WORDS[n % WORDS.length]} come up, with $x_${n}$ and ${WORDS[(n + 3) % WORDS.length]} beside them.`;
/** A book's pages as Marker reads them: a running header and a page number at the top of each, chapter 1 on 13. */
function book(): { page: number; markdown: string }[] {
  const pages = [];
  for (let page = 13; page <= 20; page++) {
    const head = page % 2 === 0 ? `${page - 9}\n\n# 1 Vectors` : `## 1.1 Vectors\n\n${page - 9}`;
    const body =
      page === 13
        ? "# Chapter 1\n\n# Vectors\n\n## 1.1 Vectors\n\nA vector is an ordered list."
        : page === 17
          ? `## **1.2 Vector addition**\n\n${prose(page)}`
          : page === 19
            ? `## Exercises\n\n${prose(page)}\n\n## Examples.\n\nAn example.`
            : prose(page);
    pages.push({ page, markdown: page === 13 ? body : `${head}\n\n${body}` });
  }
  return pages;
}
const OUTLINE: OutlineItem[] = [
  { title: "I Vectors", level: 0, page: 11 },
  { title: "Vectors", level: 1, page: 13 },
  { title: "Vectors", level: 2, page: 13 },
  { title: "Vector addition", level: 2, page: 17 },
  { title: "Exercises", level: 2, page: 19 },
  { title: "Linear functions", level: 1, page: 21 },
];
const headings = (md: string) => [...md.matchAll(/^(#+) (.+)$/gm)].map((m) => `${m[1]} ${m[2]}`);

describe("a book's pages made into one text", () => {
  test("titles compare without their numbering, emphasis or end punctuation", () => {
    expect(titleKey("## **1.2 Vector addition**")).toBe("vector addition");
    expect(titleKey("# Chapter 1 Vectors")).toBe("vectors");
    expect(titleKey("# Chapter 1")).toBe("chapter 1");
    expect(titleKey("I Vectors")).toBe("vectors");
    expect(titleKey("Examples.")).toBe("examples");
    expect(titleKey("Inner product")).toBe("inner product");
  });

  test("running headers and page numbers go, recurring by position on pages close together", () => {
    const md = assemblePages(book());
    expect(md).not.toMatch(/^# 1 Vectors$/m);
    expect(md).not.toMatch(/^\d+$/m);
    // Without an outline, a section heading written as its own running header can't be told from it, and goes
    // too; its text stays. With one, it's the outline's (the next test).
    expect(md).not.toContain("1.1 Vectors");
    expect(md).toContain("A vector is an ordered list.");
    for (let page = 14; page <= 20; page++) expect(md).toContain(prose(page).slice(0, 20));
  });

  test("with an outline, the headings are the book's own, at its depths, and Marker's others are bold text", () => {
    const md = assemblePages(book(), OUTLINE);
    // The part (I Vectors, page 11) isn't among these pages, so the chapter is the top.
    expect(headings(md)).toEqual(["# Vectors", "## Vectors", "## Vector addition", "## Exercises"]);
    expect(md).not.toContain("Chapter 1");
    expect(md).toContain("**Examples.**");
    expect(md).toContain("A vector is an ordered list.");
  });

  test("a bookmark whose title isn't on its page is put at its top; one outside the pages is left out", () => {
    const pages = [{ page: 21, markdown: "Text that starts the chapter without its title." }];
    expect(headings(assemblePages(pages, OUTLINE))).toEqual(["# Linear functions"]);
  });

  test("a heading far apart, once a chapter, isn't a running header", () => {
    const pages = [5, 25, 45, 65].map((page) => ({ page, markdown: `## Exercises\n\n${prose(page)}` }));
    expect(assemblePages(pages).match(/## Exercises/g)?.length).toBe(4);
  });

  test("outline entries cover their pages up to the next at their depth or above", () => {
    const ranges = outlineRanges(OUTLINE, 40).map((r) => [r.title, r.level, r.page, r.lastPage]);
    expect(ranges).toEqual([
      ["I Vectors", 0, 11, 40],
      ["Vectors", 1, 13, 20],
      ["Vectors", 2, 13, 16],
      ["Vector addition", 2, 17, 18],
      ["Exercises", 2, 19, 20],
      ["Linear functions", 1, 21, 40],
    ]);
  });
});
