import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConvertOptions } from "@gem/shared";
import type { ConvertClient } from "./client.ts";
import { type Expected, type Score, scoreConversion, textSimilarity } from "./score.ts";

/**
 * `convert-smoke` (docs/P2.2.md M26): the fixture PDFs through a converter, each conversion scored against the known
 * answer: formulas (a normalized LaTeX comparison), headings, and the prose's similarity to the source Markdown. A run
 * with a `bar` passes when it reaches every number in it; a run without one is recorded only.
 */

const ROOT = join(import.meta.dir, "..", "..", "..");

export interface SmokeBar {
  formulas: number;
  headings: number;
  /** `textSimilarity` with the source, 0 to 1. */
  similarity: number;
}

export interface SmokeRun {
  name: string;
  file: string;
  options: ConvertOptions;
  bar?: SmokeBar;
  note?: string;
}

export interface SmokeSet {
  name: string;
  description: string;
  /** Repo-relative directory holding the PDFs and the answer. */
  fixtures: string;
  expected: string;
  runs: SmokeRun[];
}

export interface SmokeResult {
  name: string;
  seconds: number;
  pageCount?: number;
  pagesConverted?: number;
  converterSeconds?: number;
  score?: Score;
  similarity?: number;
  error?: string;
  /** Undefined for a run without a bar. */
  pass?: boolean;
  /** What fell short of the bar, in words. */
  shortfalls: string[];
}

export interface SmokeReport {
  set: string;
  results: SmokeResult[];
  /** Every run with a bar passed. */
  pass: boolean;
}

export function loadConvertSmoke(name = "convert-smoke"): SmokeSet {
  return JSON.parse(readFileSync(join(import.meta.dir, "..", "evals", name, "eval.json"), "utf8")) as SmokeSet;
}

export async function runConvertSmoke(
  client: ConvertClient,
  set: SmokeSet = loadConvertSmoke(),
  onResult: (result: SmokeResult) => void = () => {},
): Promise<SmokeReport> {
  const dir = join(ROOT, set.fixtures);
  const expected = JSON.parse(readFileSync(join(dir, set.expected), "utf8")) as Expected & { source: string };
  const source = readFileSync(join(ROOT, expected.source), "utf8");
  const results: SmokeResult[] = [];
  for (const run of set.runs) {
    const started = performance.now();
    let result: SmokeResult;
    try {
      const reply = await client.convert(readFileSync(join(dir, run.file)), run.options);
      const score = scoreConversion(reply.markdown, expected);
      const similarity = textSimilarity(reply.markdown, source);
      const shortfalls: string[] = [];
      if (run.bar) {
        if (score.formulasMatched < run.bar.formulas)
          shortfalls.push(`formulas ${score.formulasMatched} of ${score.formulasExpected}, below ${run.bar.formulas}`);
        if (score.headingsFound < run.bar.headings)
          shortfalls.push(`headings ${score.headingsFound} of ${score.headingsExpected}, below ${run.bar.headings}`);
        if (similarity < run.bar.similarity)
          shortfalls.push(`text similarity ${similarity.toFixed(3)}, below ${run.bar.similarity}`);
      }
      result = {
        name: run.name,
        seconds: (performance.now() - started) / 1000,
        pageCount: reply.pageCount,
        pagesConverted: reply.pagesConverted,
        converterSeconds: reply.seconds,
        score,
        similarity,
        pass: run.bar ? shortfalls.length === 0 : undefined,
        shortfalls,
      };
    } catch (err) {
      const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      result = {
        name: run.name,
        seconds: (performance.now() - started) / 1000,
        error,
        pass: run.bar ? false : undefined,
        shortfalls: [error],
      };
    }
    results.push(result);
    onResult(result);
  }
  return { set: set.name, results, pass: results.every((r) => r.pass !== false) };
}

/** One line for a run, as the live script prints it. */
export function formatSmokeResult(r: SmokeResult): string {
  const verdict = r.pass === undefined ? "recorded" : r.pass ? "pass" : "FAIL";
  const head = `${r.name.padEnd(24)} ${r.seconds.toFixed(1).padStart(6)} s  ${verdict.padEnd(8)}`;
  if (!r.score) return `${head} ${r.shortfalls.join("; ")}`;
  return (
    `${head} ${r.pagesConverted}/${r.pageCount} pages  formulas ${r.score.formulasMatched}/${r.score.formulasExpected} ` +
    `(${r.score.formulasInOutput} in output)  headings ${r.score.headingsFound}/${r.score.headingsExpected}  ` +
    `text ${r.similarity?.toFixed(3)}${r.shortfalls.length ? `  — ${r.shortfalls.join("; ")}` : ""}`
  );
}
