import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Expected, formulasIn, normalizeLatex, scoreConversion } from "../src/index.ts";

const expected: Expected = {
  formulas: ["x = (2, -1, 2)", "a^T b = 2 \\cdot 1", "\\|a\\| = 3"],
  headings: [
    { level: 1, title: "Vectors and matrices" },
    { level: 2, title: "Inner product" },
  ],
};

describe("scoring a conversion against its known answer", () => {
  test("what doesn't change an equation's meaning doesn't count as a difference", () => {
    expect(normalizeLatex("a^T \\left( b \\right)")).toBe(normalizeLatex("a^T(b)"));
    expect(normalizeLatex("2 \\cdot 1")).toBe(normalizeLatex("2 * 1"));
    expect(normalizeLatex("\\mathbf{a} + \\mathbf{b}")).toBe(normalizeLatex("a+b"));
    expect(normalizeLatex("x_1 + \\cdots + x_n")).toBe(normalizeLatex("x_{1}+...+x_{n}"));
    expect(normalizeLatex("a^T b")).not.toBe(normalizeLatex("a b^T"));
  });

  test("formulas are found inline and displayed, each once, and a miss is reported", () => {
    const md = "## **Inner product**\n\nLet $x = (2, -1, 2)$ and $a^T b = 2 * 1$.\n\n$$\\|a\\| = 4$$\n";
    const s = scoreConversion(md, expected);
    expect(s).toMatchObject({ formulasExpected: 3, formulasMatched: 2, formulasInOutput: 3, headingsFound: 1 });
    expect(s.missed).toEqual(["\\|a\\| = 3"]);
    // A formula written once in the output can't satisfy two expectations.
    const twice = scoreConversion("$x = (2, -1, 2)$", { formulas: ["x = (2, -1, 2)", "x=(2,-1,2)"], headings: [] });
    expect(twice.formulasMatched).toBe(1);
  });

  test("a price isn't a formula pair, and nothing found is 0 of N", () => {
    expect(formulasIn("It costs $5 or $6 today.")).toEqual(["5 or"]);
    expect(scoreConversion("no maths here", expected)).toMatchObject({ formulasMatched: 0, headingsFound: 0 });
  });

  test("the committed fixtures say what the right answer is", () => {
    const dir = join(import.meta.dir, "..", "..", "..", "apps", "convert", "tests", "fixtures");
    const answer = JSON.parse(readFileSync(join(dir, "linear-algebra.expected.json"), "utf8")) as Expected & {
      pages: number;
    };
    expect(answer.pages).toBe(2);
    expect(answer.formulas.length).toBe(54);
    expect(answer.headings.map((h) => h.title)).toEqual([
      "Vectors and matrices",
      "Vectors",
      "Inner product",
      "Norms and distance",
      "Matrices",
    ]);
    // The source Markdown itself scores perfectly: the scorer and the fixture agree.
    const source = readFileSync(
      join(dir, "..", "..", "..", "..", "packages", "authoring", "test", "fixtures", "linear-algebra.md"),
      "utf8",
    );
    expect(scoreConversion(source, answer)).toMatchObject({ formulasMatched: 54, headingsFound: 5, missed: [] });
  });
});
