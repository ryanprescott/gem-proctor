import { type LayerResult, layerResult, type ValidationIssue } from "@gem/shared";
import { bestWindowSimilarity, normalizeText } from "./text.ts";

/**
 * L2: each quote is in the chunk it cites (SPEC §3A.3). An exact match, then a normalized one, then token similarity
 * against `threshold`. Below that, or with no such chunk, it's a likely hallucination: a **fail**.
 */

export type GroundingMatch = "exact" | "normalized" | "fuzzy" | "missing";

export function matchQuote(quote: string, chunk: string, threshold: number): { match: GroundingMatch; score: number } {
  if (chunk.includes(quote)) return { match: "exact", score: 1 };
  if (normalizeText(chunk).includes(normalizeText(quote))) return { match: "normalized", score: 1 };
  const score = bestWindowSimilarity(quote, chunk);
  return { match: score >= threshold ? "fuzzy" : "missing", score };
}

export function checkGrounding(
  evidence: { chunkId: string; quote: string }[],
  chunks: ReadonlyMap<string, string>,
  threshold: number,
): LayerResult {
  const issues: ValidationIssue[] = [];
  for (const e of evidence) {
    if (e.quote.trim() === "") {
      issues.push({ code: "quote_empty", severity: "fail", params: { chunkId: e.chunkId } });
      continue;
    }
    const text = chunks.get(e.chunkId);
    if (text === undefined) {
      issues.push({ code: "chunk_unknown", severity: "fail", params: { chunkId: e.chunkId } });
      continue;
    }
    const { match, score } = matchQuote(e.quote, text, threshold);
    if (match === "missing") {
      issues.push({
        code: "quote_not_found",
        severity: "fail",
        params: { chunkId: e.chunkId, score: Number(score.toFixed(3)) },
      });
    }
  }
  return layerResult("L2", issues);
}
