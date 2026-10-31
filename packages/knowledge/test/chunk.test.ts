import { describe, expect, test } from "bun:test";
import { estimateTokens } from "@gem/shared";
import { chunkSource, OVERLAP_TOKENS, TARGET_TOKENS, UnitTooLargeError } from "../src/chunk.ts";
import { parseSource } from "../src/parse.ts";

const opts = { title: "Book", citationLabel: "VMLS" };
const chunks = (text: string, maxTokens?: number) =>
  chunkSource(text, parseSource(text, opts), { citationLabel: "VMLS", ...(maxTokens ? { maxTokens } : {}) });

const sentence = (i: number) => `Sentence number ${i} says something plain about vectors and their inner products.`;
const paragraph = (n: number, start = 0) => Array.from({ length: n }, (_, i) => sentence(start + i)).join(" ");

describe("E3: sections", () => {
  test("headings nest by level, and each section knows its path", () => {
    const { sections } = parseSource("# A\n\nx\n\n## B\n\ny\n\n### C\n\nz\n\n## D\n\nw\n\n# E\n\nv", opts);
    expect(sections.map((s) => [s.title, s.level, s.parent])).toEqual([
      ["A", 1, null],
      ["B", 2, 0],
      ["C", 3, 1],
      ["D", 2, 0],
      ["E", 1, null],
    ]);
    expect(sections[2]?.headingPath).toEqual(["A", "B", "C"]);
    expect(sections[2]?.slugPath).toBe("a.b.c");
  });

  test("text before the first heading is its own section, named after the source", () => {
    const { sections } = parseSource("Intro.\n\n# A\n\nx", opts);
    expect(sections.map((s) => s.title)).toEqual(["Book", "A"]);
  });

  test("no headings at all: one section, with a warning", () => {
    const parsed = parseSource("Only text.\n\nAnd more.", opts);
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.warnings).toEqual([{ code: "no_headings" }]);
  });

  test("plain text is one section split by paragraph, and `#` is not a heading there", () => {
    const parsed = parseSource("# not a heading\n\nSecond paragraph.\n  \nThird.", { ...opts, format: "text" });
    expect(parsed.format).toBe("text");
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0]?.units).toHaveLength(3);
  });

  test("duplicate headings under one parent get distinct slugs, so keys stay unique", () => {
    const list = chunks("# A\n\nx\n\n# A\n\ny\n\n# A\n\nz");
    expect(list.map((c) => c.chunkKey)).toEqual(["vmls:a:c1", "vmls:a-2:c1", "vmls:a-3:c1"]);
  });

  test("a heading with no latin letters still gets a slug", () => {
    expect(chunks("# 第一章\n\n文字。")[0]?.chunkKey).toBe("vmls:s1:c1");
  });
});

describe("E4: chunks", () => {
  test("target size: long text goes to chunks near the target, none far over it", () => {
    const text = `# A\n\n${Array.from({ length: 30 }, (_, i) => paragraph(6, i * 6)).join("\n\n")}`;
    const list = chunks(text);
    expect(list.length).toBeGreaterThan(3);
    for (const c of list) expect(c.tokenCount).toBeLessThanOrEqual(TARGET_TOKENS);
    const middle = list.slice(0, -1);
    expect(middle.reduce((n, c) => n + c.tokenCount, 0) / middle.length).toBeGreaterThan(TARGET_TOKENS * 0.7);
  });

  test("offsets slice back to the exact text, whatever the content", () => {
    const text = `# A *b* c\n\nLead with $x^T y$ and **bold**.\r\n\r\n- item\n- item two\n\n> quoted\n\n${paragraph(60)}\n\n$$\n\\sum_i x_i\n$$\n`;
    for (const c of chunks(text)) expect(text.slice(c.charStart, c.charEnd)).toBe(c.text);
  });

  test("overlap: the next chunk starts with the end of the one before, and stays small", () => {
    const text = `# A\n\n${paragraph(60)}`;
    const list = chunks(text);
    expect(list.length).toBeGreaterThan(1);
    for (let i = 1; i < list.length; i++) {
      const [a, b] = [list[i - 1], list[i]];
      if (!a || !b) continue;
      expect(b.charStart).toBeLessThan(a.charEnd);
      expect(estimateTokens(text.slice(b.charStart, a.charEnd))).toBeLessThanOrEqual(OVERLAP_TOKENS);
    }
  });

  test("a code block over the target stays whole, in one chunk", () => {
    const code = `\`\`\`python\n${'print("line")\n'.repeat(150)}\`\`\``;
    const text = `# A\n\n${paragraph(5)}\n\n${code}\n\n${paragraph(5, 50)}`;
    const list = chunks(text);
    expect(list.filter((c) => c.text.includes("```python")).length).toBe(1);
    const holder = list.find((c) => c.text.includes("```python"));
    expect(holder?.text).toContain(code);
    expect(list.filter((c) => c.text.includes('print("line")'))).toHaveLength(1);
  });

  test("a table stays whole", () => {
    const rows = Array.from({ length: 80 }, (_, i) => `| row ${i} | value ${i} |`).join("\n");
    const table = `| a | b |\n|---|---|\n${rows}`;
    const list = chunks(`# A\n\n${paragraph(30)}\n\n${table}\n\n${paragraph(30, 40)}`);
    const holders = list.filter((c) => c.text.includes("| row 40 |"));
    expect(holders).toHaveLength(1);
    expect(holders[0]?.text).toContain(table);
  });

  test("a $$ block stays whole", () => {
    const math = `$$\n${"x_1 + y_2 = z_3 \\\\\n".repeat(120)}$$`;
    const list = chunks(`# A\n\n${paragraph(30)}\n\n${math}\n\n${paragraph(30, 40)}`);
    const holders = list.filter((c) => c.text.includes("x_1 + y_2"));
    expect(holders).toHaveLength(1);
    expect(holders[0]?.text).toContain(math);
  });

  test("inline math isn't cut, and LaTeX comes back as written", () => {
    const inline = String.raw`$\frac{a. b}{c} = \begin{bmatrix} 1 & 2 \end{bmatrix}^T$`;
    const long = Array.from({ length: 80 }, (_, i) => `${sentence(i)} Then ${inline} holds.`).join(" ");
    const list = chunks(`# A\n\n${long}`);
    expect(list.length).toBeGreaterThan(1);
    for (const c of list) {
      expect((c.text.match(/\$/g)?.length ?? 0) % 2).toBe(0);
      if (c.text.includes("frac")) expect(c.text).toContain(inline);
    }
  });

  test("a sentence over the target is cut between words, outside math", () => {
    const list = chunks(`# A\n\n${"word ".repeat(2000)}`);
    expect(list.length).toBeGreaterThan(1);
    for (const c of list) expect(c.tokenCount).toBeLessThanOrEqual(TARGET_TOKENS);
  });

  test("a section with a heading and nothing else has no chunks", () => {
    expect(chunks("# A\n\n## B\n\ntext").map((c) => c.chunkKey)).toEqual(["vmls:a.b:c1"]);
  });

  test("the same text gets the same hash, and a different text doesn't", () => {
    const [a] = chunks("# A\n\nSame.");
    const [b] = chunks("# A\n\nSame.");
    const [c] = chunks("# A\n\nOther.");
    expect(a?.contentHash).toBe(b?.contentHash as string);
    expect(a?.contentHash).not.toBe(c?.contentHash as string);
    expect(a?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("E5: the cap", () => {
  test("an unsplittable block over the cap fails with its heading path", () => {
    const code = `\`\`\`\n${"x = 1\n".repeat(300)}\`\`\``;
    let error: unknown;
    try {
      chunks(`# A\n\n## B\n\n${code}`, 200);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UnitTooLargeError);
    const e = error as UnitTooLargeError;
    expect(e.heading).toBe("A › B");
    expect(e.maxTokens).toBe(200);
    expect(e.tokens).toBeGreaterThan(200);
  });

  test("ordinary text under a small cap is split to fit, not refused", () => {
    const list = chunks(`# A\n\n${paragraph(40)}`, 300);
    for (const c of list) expect(c.tokenCount).toBeLessThanOrEqual(300);
  });
});

describe("the estimate", () => {
  test("characters ÷ 3, and ÷ 1.5 for CJK-heavy text", () => {
    expect(estimateTokens("a".repeat(30))).toBe(10);
    expect(estimateTokens("字".repeat(30))).toBe(20);
  });
});
