import { runGroundingEval } from "@gem/authoring";
import { type Db, newId, Source, User } from "@gem/db";
import { chunkCap, embedRevision, prepareSource, retrieve, saveRevision } from "@gem/knowledge";
import type { EvalRunOptions, LlmRuntime, Runtime } from "@gem/llm";
import type { EvalSummary } from "@gem/shared";
import { eq } from "drizzle-orm";
import { embeddingsTarget } from "./sources.ts";

/** The eval runners that need the database or the authoring validators (P2.md E51). */

/** `grounding` sets: generation on chunks laid out as authoring lays them out, L1 to L3 on the output. */
export function groundingRunner(ctx: { llm: LlmRuntime }): EvalRunOptions["grounding"] {
  return (set, opts) => runGroundingEval({ llm: ctx.llm }, set, opts);
}

const round = (x: number) => Number(x.toFixed(4));

/**
 * `retrieval` sets, again through the database: the corpus becomes a source of its own (one section a chunk),
 * embedded as any source is, and each query goes through `retrieve`, so pgvector, the full-text index, the scope filter
 * and the rank fusion are what's measured. The source is removed after: it's soft-deleted, since chunks are immutable.
 * It needs an owner; with no one to own it, the set reports its in-memory passes only.
 */
export function hybridRunner(ctx: { db: Db; llm: Runtime }, ownerId: string | null): EvalRunOptions["hybrid"] {
  return async (set): Promise<EvalSummary> => {
    const owner = ownerId ?? (await ctx.db.select({ id: User.id }).from(User).limit(1))[0]?.id ?? null;
    if (owner === null) return {};
    const target = await embeddingsTarget({ llm: ctx.llm });
    const cap = target ? chunkCap(target) : undefined;
    const text = `# Eval corpus\n\n${set.fixtures.chunks.map((c) => `## ${c.id}\n\n${c.text}`).join("\n\n")}\n`;
    const prepared = prepareSource(text, {
      title: set.name,
      citationLabel: "EV",
      format: "markdown",
      ...(cap === undefined ? {} : { maxTokens: cap }),
    });
    const sourceId = newId();
    const revisionId = await ctx.db.transaction(async (tx) => {
      await tx.insert(Source).values({ id: sourceId, ownerId: owner, title: set.name, citationLabel: "EV" });
      return saveRevision(tx, { sourceId, number: 1, text, format: "markdown", createdBy: owner, prepared });
    });
    try {
      await embedRevision({ db: ctx.db, llm: ctx.llm, userId: owner }, revisionId, () => {});
      const ranks = { vector: [] as number[], hybrid: [] as number[] };
      for (const q of set.fixtures.queries) {
        const { chunks } = await retrieve(
          { db: ctx.db, llm: ctx.llm },
          {
            query: q.text,
            scope: [{ sourceId, revisionId, sectionIds: null }],
            budgetTokens: 1_000_000,
            userId: owner,
          },
        );
        // A chunk's text starts with its section's heading, which is the fixture's id.
        const own = (c: { text: string }) => c.text.startsWith(`## ${q.expected}\n`);
        const fused = chunks.filter((c) => c.rank !== null);
        const at = fused.findIndex(own);
        ranks.hybrid.push(at < 0 ? Number.POSITIVE_INFINITY : at + 1);
        const byVector = chunks
          .filter((c) => c.vectorRank !== null)
          .sort((a, b) => (a.vectorRank as number) - (b.vectorRank as number));
        const v = byVector.findIndex(own);
        ranks.vector.push(v < 0 ? Number.POSITIVE_INFINITY : v + 1);
      }
      const top1 = (rs: number[]) => round(rs.filter((r) => r === 1).length / rs.length);
      const mrr = (rs: number[]) => round(rs.reduce((n, r) => n + 1 / r, 0) / rs.length);
      return {
        top1Pgvector: top1(ranks.vector),
        mrrPgvector: mrr(ranks.vector),
        top1Hybrid: top1(ranks.hybrid),
        mrrHybrid: mrr(ranks.hybrid),
      };
    } finally {
      await ctx.db.update(Source).set({ deletedAt: new Date() }).where(eq(Source.id, sourceId));
    }
  };
}
