import { describe, expect, test } from "bun:test";
import { findUnparsedMath } from "../src/ui/math.ts";

describe("M22: equations the browser can't read", () => {
  test("good equations, inline and display, are not reported", () => {
    expect(findUnparsedMath("Orthogonal when $x^T y = 0$.\n\n$$\\|x\\| = \\sqrt{x^T x}$$\n")).toEqual([]);
  });

  test("an unknown command and an unclosed brace are reported as written", () => {
    expect(findUnparsedMath("a $\\notacommand{x}$ and $$\\frac{1}{$$ and $y$")).toEqual([
      "\\frac{1}{",
      "\\notacommand{x}",
    ]);
  });

  test("code, prices and escaped dollars are left alone", () => {
    const md = "```\n$\\notacommand$\n```\nand `$\\bad$` cost \\$5 and $6 in total";
    expect(findUnparsedMath(md)).toEqual([]);
  });

  test("it stops at the limit", () => {
    const many = Array.from({ length: 30 }, (_, i) => `$\\bad${"a".repeat(i + 1)}{x}$`).join(" ");
    expect(findUnparsedMath(many, 5)).toHaveLength(5);
  });
});
