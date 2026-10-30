import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AppError, type EvalSummary, GenerationBatch, type ModelRole } from "@gem/shared";
import { z } from "zod";
import { LlmError } from "./errors.ts";
import { ACTIVE_PROMPTS, renderPrompt } from "./prompts.ts";
import type { LlmRuntime } from "./types.ts";

/** The eval harness (SPEC §3B.4, P1.5.md §5). P2 and P2.1 add metrics to the same report. */

export const EVALS_DIR = join(import.meta.dir, "..", "evals");

const Chunk = z.object({ id: z.string(), text: z.string() });

const GenerateSet = z.object({
  name: z.string(),
  kind: z.literal("generate"),
  role: z.literal("authoring.generate"),
  prompt: z.string(),
  schema: z.literal("strict7"),
  defaultTrials: z.number().int().positive(),
  questionsPerTrial: z.number().int().positive(),
  request: z.object({ vars: z.record(z.string(), z.string()), user: z.string() }),
  fixtures: z.object({ chunks: z.array(Chunk).min(1) }),
  metrics: z.array(z.string()),
});

const RetrievalSet = z.object({
  name: z.string(),
  kind: z.literal("retrieval"),
  role: z.literal("embeddings"),
  defaultTrials: z.number().int().positive(),
  fixtures: z.object({
    chunks: z.array(Chunk).min(14),
    queries: z.array(z.object({ text: z.string(), expected: z.string() })).min(15),
  }),
  metrics: z.array(z.string()),
});

export const EvalSet = z.discriminatedUnion("kind", [GenerateSet, RetrievalSet]);
export type EvalSet = z.infer<typeof EvalSet>;

export function listEvalSets(dir = EVALS_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "eval.json")))
    .map((e) => e.name)
    .sort();
}

export function loadEvalSet(name: string, dir = EVALS_DIR): EvalSet {
  if (!listEvalSets(dir).includes(name)) throw new AppError("not_found");
  return EvalSet.parse(JSON.parse(readFileSync(join(dir, name, "eval.json"), "utf8")));
}

/** The version a run reports; embeddings use no prompt. */
export function evalPromptVersion(set: EvalSet): string {
  return set.kind === "generate" ? (ACTIVE_PROMPTS[set.prompt] ?? "unknown") : "none";
}

export function evalRole(set: EvalSet): ModelRole {
  return set.role;
}

export interface EvalReport {
  summary: EvalSummary;
  items: Record<string, unknown>[];
}

export interface EvalRunOptions {
  trials?: number;
  evalRunId?: string;
  userId?: string;
}

const round = (x: number, digits = 4) => Number(x.toFixed(digits));
const mean = (xs: number[]) => (xs.length === 0 ? null : round(xs.reduce((a, b) => a + b, 0) / xs.length));

async function runGenerate(
  runtime: LlmRuntime,
  set: z.infer<typeof GenerateSet>,
  opts: EvalRunOptions,
): Promise<EvalReport> {
  const trials = opts.trials ?? set.defaultTrials;
  const [chunk] = set.fixtures.chunks;
  if (!chunk) throw new Error("generate eval without a chunk");
  const chunks = new Map(set.fixtures.chunks.map((c) => [c.id, c.text]));
  const user = renderPrompt(
    { promptId: set.name, version: set.name, file: "eval.json", template: set.request.user },
    { chunkId: chunk.id, chunk: chunk.text },
  ).system;
  const input = {
    promptId: set.prompt,
    vars: { ...set.request.vars },
    messages: [{ role: "user" as const, content: user }],
  };
  const items: Record<string, unknown>[] = [];
  for (let trial = 1; trial <= trials; trial++) {
    try {
      const r = await runtime.generateObject(set.role, GenerationBatch, input, opts);
      const quotes = r.value.questions.flatMap((q) => q.evidence);
      const found = quotes.filter((e) => chunks.get(e.chunkId)?.includes(e.quote.trim()) && e.quote.trim() !== "");
      items.push({
        trial,
        valid: true,
        repairs: r.repairAttempts,
        questions: r.value.questions.length,
        quotes: quotes.length,
        quotesFound: found.length,
        seconds: round(r.latencyMs / 1000, 3),
        finishReason: r.finishReason,
        tokensOut: r.usage.outputTokens,
      });
    } catch (err) {
      // Invalid output is what's being measured; anything else ends the run.
      if (!(err instanceof LlmError) || err.code !== "llm_output_invalid") throw err;
      items.push({ trial, valid: false, repairs: err.params.repairAttempts, questions: 0, quotes: 0, quotesFound: 0 });
    }
  }
  const valid = items.filter((i) => i.valid);
  const sum = (key: string, list = items) => list.reduce((n, i) => n + ((i[key] as number | undefined) ?? 0), 0);
  const questions = sum("questions");
  const quotes = sum("quotes");
  return {
    summary: {
      trials,
      validFirstTry: round(valid.filter((i) => i.repairs === 0).length / trials),
      repairsPerCall: round(sum("repairs") / trials),
      validAfterRepairs: round(valid.length / trials),
      evidenceVerbatim: quotes === 0 ? null : round(sum("quotesFound") / quotes),
      secondsPerQuestion: questions === 0 ? null : round(sum("seconds", valid) / questions, 2),
    },
    items,
  };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [i, x] of a.entries()) {
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return dot / (Math.sqrt(na * nb) || 1);
}

async function retrievalPass(
  runtime: LlmRuntime,
  set: z.infer<typeof RetrievalSet>,
  noPrefix: boolean,
  opts: EvalRunOptions,
) {
  const { chunks, queries } = set.fixtures;
  const embedOpts = { ...opts, noPrefix };
  const docs = await runtime.embed(
    chunks.map((c) => c.text),
    { ...embedOpts, kind: "document" },
  );
  const asked = await runtime.embed(
    queries.map((q) => q.text),
    { ...embedOpts, kind: "query" },
  );
  return queries.map((q, i) => {
    const query = asked.vectors[i] as number[];
    const scored = chunks
      .map((c, n) => ({ id: c.id, score: cosine(query, docs.vectors[n] as number[]) }))
      .sort((a, b) => b.score - a.score);
    return { query: q.text, expected: q.expected, rank: scored.findIndex((s) => s.id === q.expected) + 1 };
  });
}

async function runRetrieval(
  runtime: LlmRuntime,
  set: z.infer<typeof RetrievalSet>,
  opts: EvalRunOptions,
): Promise<EvalReport> {
  const withPrefix = await retrievalPass(runtime, set, false, opts);
  const without = await retrievalPass(runtime, set, true, opts);
  const top1 = (rows: { rank: number }[]) => round(rows.filter((r) => r.rank === 1).length / rows.length);
  const mrr = (rows: { rank: number }[]) => mean(rows.map((r) => 1 / r.rank));
  return {
    summary: {
      queries: withPrefix.length,
      top1: top1(withPrefix),
      mrr: mrr(withPrefix),
      top1NoPrefix: top1(without),
      mrrNoPrefix: mrr(without),
    },
    items: withPrefix.map((r, i) => ({ ...r, rankNoPrefix: without[i]?.rank })),
  };
}

export function runEval(runtime: LlmRuntime, set: EvalSet, opts: EvalRunOptions = {}): Promise<EvalReport> {
  return set.kind === "generate" ? runGenerate(runtime, set, opts) : runRetrieval(runtime, set, opts);
}

/** The plain-text report the CLI prints. */
export function formatEvalReport(
  set: EvalSet,
  head: { model: string; endpoint: string; promptVersion: string },
  report: EvalReport,
): string {
  const lines = [
    `eval ${set.name} (${set.role})`,
    `model ${head.model} on ${head.endpoint}, prompt ${head.promptVersion}`,
    ...Object.entries(report.summary).map(([k, v]) => `  ${k}: ${v ?? "n/a"}`),
  ];
  return lines.join("\n");
}
