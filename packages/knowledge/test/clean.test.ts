import { describe, expect, test } from "bun:test";
import { cleanMarkdown, unbalancedMath } from "../src/clean.ts";

const base = { pageCount: 2, pagesConverted: 2, figures: 0 };
const prose = `${"A sentence about vectors and matrices that carries real text. ".repeat(8)}\n`;
const clean = (markdown: string, over: Partial<typeof base> = {}) => cleanMarkdown({ ...base, ...over, markdown });

describe("M14: mathematics", () => {
  test("other delimiters become $ and $$", () => {
    const out = clean(`${prose}The norm is \\(\\|x\\|\\) and <math>a+b</math>.\n\n\\[ x = y \\]\n`).markdown;
    expect(out).toContain("$\\|x\\|$");
    expect(out).toContain("$a+b$");
    expect(out).toContain("$$x = y$$");
    expect(out).not.toContain("\\(");
    expect(out).not.toContain("<math");
  });

  test("display mathematics inside a sentence is lifted onto its own lines", () => {
    const out = clean(`${prose}so we get $$x^2$$ as claimed\n`).markdown;
    expect(out).toContain("\n\n$$x^2$$\n\n");
  });

  test("prices keep their dollar signs and are not unbalanced", () => {
    const out = clean(`${prose}It costs $5 now and $1,200.50 later.\n`);
    expect(out.markdown).toContain("$5 now and $1,200.50 later");
    expect(out.warnings.map((w) => w.code)).not.toContain("unbalanced_math");
  });

  test("fenced code is left alone", () => {
    const code = "```\n\\(not math\\) <math>x</math> ![i](a.png)\n```";
    expect(clean(`${prose}${code}\n`).markdown).toContain(code);
  });

  test("an unclosed delimiter is warned about", () => {
    expect(unbalancedMath("a $x + y here")).toBe(true);
    expect(unbalancedMath("a $x$ and $$y$$")).toBe(false);
    expect(unbalancedMath("price \\$5 and $x$")).toBe(false);
    expect(clean(`${prose}We have $x + y.\n`).warnings.map((w) => w.code)).toContain("unbalanced_math");
  });
});

describe("M15: clean-up and warnings", () => {
  test("images are removed and counted", () => {
    const out = clean(`${prose}![fig](a.png) text ![](b.jpg)\n`);
    expect(out.markdown).not.toContain("![");
    expect(out.warnings).toContainEqual({ code: "figures_dropped", count: 2 });
  });

  test("the converter's own figure count is used when larger", () => {
    expect(clean(prose, { figures: 5 }).warnings).toContainEqual({ code: "figures_dropped", count: 5 });
  });

  test("empty headings are dropped, and ones with words are kept", () => {
    const out = clean(`${prose}\n#\n\n## \n\n## Real heading\n\nbody\n`).markdown;
    expect(out).toContain("## Real heading");
    expect(out.split("\n").filter((l) => /^#+\s*$/.test(l))).toEqual([]);
  });

  test("a line that repeats on every page is dropped; repeated content is not", () => {
    const page = (n: number) => `Linear Algebra, Draft\n\n${prose}Section text ${n}.\n\n- same item\n`;
    const out = clean([1, 2, 3].map(page).join("\n"), { pageCount: 3, pagesConverted: 3 }).markdown;
    expect(out).not.toContain("Linear Algebra, Draft");
    expect(out.match(/- same item/g)?.length).toBe(3);
  });

  test("little text per page is warned about; skipped pages are counted", () => {
    const out = clean("Short.\n", { pageCount: 10, pagesConverted: 4 });
    expect(out.warnings).toContainEqual({ code: "low_text" });
    expect(out.warnings).toContainEqual({ code: "pages_skipped", count: 6 });
  });

  test("a normal document has no warnings", () => {
    expect(clean(prose).warnings).toEqual([]);
  });
});
