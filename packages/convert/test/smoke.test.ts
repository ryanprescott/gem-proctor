import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MockConvertServer } from "../mock/server.ts";
import { ConvertClient, loadConvertSmoke, runConvertSmoke, textSimilarity, wordsOf } from "../src/index.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const source = readFileSync(join(ROOT, "packages", "authoring", "test", "fixtures", "linear-algebra.md"), "utf8");
let mock: MockConvertServer | undefined;
afterEach(() => mock?.stop());

/** The set on a mock that answers every fixture with `markdown`. */
async function smoke(markdown: string) {
  mock = new MockConvertServer({ answer: () => markdown });
  return runConvertSmoke(new ConvertClient(mock.url));
}

describe("text similarity", () => {
  test("formulas, markup and order don't count; lost and invented words do", () => {
    expect(wordsOf("## The **norm** $\\|x\\|$ of x.")).toEqual(["the", "norm", "of", "x"]);
    expect(textSimilarity(source, source)).toBe(1);
    expect(textSimilarity("b a c", "a b c")).toBe(1);
    expect(textSimilarity("a b", "a b c d")).toBeCloseTo(2 / 3, 5);
    expect(textSimilarity("", source)).toBe(0);
  });
});

describe("convert-smoke on the mock (M26)", () => {
  test("the set names the fixtures, and the two rasterize runs are held to every formula", () => {
    const set = loadConvertSmoke();
    expect(set.runs.map((r) => r.file)).toEqual([
      "linear-algebra-scan.pdf",
      "linear-algebra.pdf",
      "linear-algebra.pdf",
      "linear-algebra.pdf",
    ]);
    expect(set.runs.filter((r) => r.bar).map((r) => r.bar?.formulas)).toEqual([54, 54]);
  });

  test("a conversion that gives back the source passes, and each run sends its options", async () => {
    const report = await smoke(source);
    expect(report.pass).toBe(true);
    expect(report.results.map((r) => r.pass)).toEqual([true, true, undefined, undefined]);
    expect(report.results[0]).toMatchObject({ score: { formulasMatched: 54, headingsFound: 5 }, similarity: 1 });
    expect(mock?.conversions.map((c) => c.options)).toEqual(loadConvertSmoke().runs.map((r) => r.options));
  });

  test("losing the document's title, as Marker does, still passes", async () => {
    const report = await smoke(source.replace(/^# .+\n/m, ""));
    expect(report.pass).toBe(true);
    expect(report.results[0]?.score?.headingsFound).toBe(4);
  });

  test("a missed formula, a lost heading or lost prose each fail, and say so", async () => {
    // One formula of 54 gone is a fail: the bar is all of them.
    const r1 = await smoke(source.replace(/\$[^$\n]+?\$/, "it"));
    expect(r1.pass).toBe(false);
    expect(r1.results[0]?.shortfalls).toEqual(["formulas 53 of 54, below 54"]);
    mock?.stop();

    const r2 = await smoke(source.replace(/^#+ /gm, ""));
    expect(r2.results[0]?.shortfalls).toEqual(["headings 0 of 5, below 4"]);
    mock?.stop();

    const half = source.slice(0, source.length / 2) + [...source.matchAll(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g)].join(" ");
    const r3 = await smoke(half);
    expect(r3.pass).toBe(false);
    expect(r3.results[0]?.shortfalls.some((s) => s.startsWith("text similarity"))).toBe(true);
  });

  test("a converter that fails fails the runs with a bar, and the set goes on", async () => {
    mock = new MockConvertServer({ fail: "bad_pdf" });
    const report = await runConvertSmoke(new ConvertClient(mock.url));
    expect(report.pass).toBe(false);
    expect(report.results).toHaveLength(4);
    expect(report.results.map((r) => r.pass)).toEqual([false, false, undefined, undefined]);
    expect(report.results[0]?.error).toBeDefined();
  });
});
