// Hybrid retrieval through real pgvector and full text (P2.md E11–E15). The mock's vectors are unrelated unless a test
// says otherwise, so a hit by vector is one the test arranged.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EMBEDDING_DIMENSIONS, RetrievalLog, SourceChunk } from "@gem/db";
import { embeddingModelId, estimateChunkTokens, expandSections, fuse, retrieve, type ScopeEntry } from "@gem/knowledge";
import { mockVector } from "@gem/llm/mock";
import { eq, sql } from "drizzle-orm";
import { assign } from "../../../packages/llm/test/helpers.ts";
import { createSourceEnv, type SourceBody, type SourceEnv } from "./authoring-helpers.ts";
import { API, hasDb } from "./helpers.ts";
import { verifyPython } from "./l7-helpers.ts";

const DOC = `# Chapter 1

## Inner product

For two vectors the value x^T y is the inner product.

## Norm

The norm of a vector measures its length in space.

## Secret

The hidden sentinel phrase lives only in this section about xylophones.

# Chapter 2

## Matrices

A matrix is a rectangular array, and multiplication composes linear maps.
`;

describe.skipIf(!hasDb || !verifyPython)("retrieval", () => {
  let env: SourceEnv;
  let source: SourceBody;
  let scope: ScopeEntry;
  let sections: { id: string; title: string; parentId: string | null }[];
  const ask = (query: string, s: ScopeEntry[] = [scope], budgetTokens = 10_000, log?: { revisionId: null }) =>
    retrieve(
      { db: env.t.db, llm: env.t.ctx.llm },
      { query, scope: s, budgetTokens, ...(log ? { log: { ...log, objectiveId: null } } : {}) },
    );
  const section = (title: string) => sections.find((s) => s.title === title)?.id as string;

  beforeAll(async () => {
    env = await createSourceEnv();
    // A test can make a query and a chunk share a vector: that's what "similar meaning" is, to the mock.
    env.mock.options.embedVector = (text) => {
      if (text.includes("multiplication composes") || text.includes("tabular operators chained together")) {
        return mockVector("the matrix topic", EMBEDDING_DIMENSIONS);
      }
      if (text.includes("xylophones") || text.includes("percussion instrument story")) {
        return mockVector("the secret topic", EMBEDDING_DIMENSIONS);
      }
      return undefined;
    };
    const res = await env.proctor.post(`${API}/sources`, { title: "Book", citationLabel: "BK", text: DOC });
    source = await env.settled(env.proctor, res.json().source.id);
    sections = (await env.proctor.get(`${API}/sources/${source.id}/sections`)).json().sections;
    scope = { sourceId: source.id, revisionId: source.latest.id, sectionIds: null };
  }, 60_000);
  afterAll(async () => env?.close());

  describe("E11: scope", () => {
    test("a chunk out of scope never comes back, even when it's the best match by both searches", async () => {
      const inScope = await expandSections(env.t.db, source.latest.id, [section("Chapter 2")]);
      const narrow = [{ ...scope, sectionIds: inScope }];
      const everywhere = await ask("percussion instrument story xylophones sentinel");
      expect(everywhere.chunks[0]?.text).toContain("xylophones");
      const scoped = await ask("percussion instrument story xylophones sentinel", narrow);
      expect(scoped.chunks.some((c) => c.text.includes("xylophones"))).toBe(false);
      for (const c of scoped.chunks) expect(inScope).toContain(c.sectionId);
    }, 20_000);

    test("a section stands for what's under it", async () => {
      const ids = await expandSections(env.t.db, source.latest.id, [section("Chapter 1")]);
      expect(new Set(ids)).toEqual(
        new Set([section("Chapter 1"), section("Inner product"), section("Norm"), section("Secret")]),
      );
    });

    test("another revision of the same source is out of scope", async () => {
      await env.proctor.put(`${API}/sources/${source.id}`, { text: `${DOC}\n\nA line about quokkas.` });
      const next = await env.settled(env.proctor, source.id);
      const old = await ask("quokkas");
      expect(old.chunks.some((c) => c.text.includes("quokkas"))).toBe(false);
      const fresh = await ask("quokkas", [{ ...scope, revisionId: next.latest.id }]);
      expect(fresh.chunks.some((c) => c.text.includes("quokkas"))).toBe(true);
    }, 20_000);

    test("an empty scope returns nothing, and asks no model", async () => {
      const before = env.mock.requests.length;
      expect((await ask("anything", [])).chunks).toEqual([]);
      expect(env.mock.requests.length).toBe(before);
    });
  });

  describe("E12: hybrid", () => {
    test("a notation query finds its chunk by full text, unstemmed", async () => {
      const { chunks } = await ask("x^T y");
      expect(chunks[0]?.text).toContain("x^T y is the inner product");
      expect(chunks[0]?.textRank).toBe(1);
    }, 20_000);

    test("a paraphrase with no word in common finds its chunk by vector", async () => {
      const { chunks } = await ask("tabular operators chained together");
      const hit = chunks.find((c) => c.text.includes("multiplication composes"));
      expect(hit?.vectorRank).toBe(1);
      expect(hit?.textRank).toBeNull();
      expect(hit?.rank).toBe(chunks[0]?.rank as number);
    }, 20_000);

    test("a stemmed word matches too", async () => {
      const { chunks } = await ask("measuring lengths");
      expect(chunks[0]?.text).toContain("norm of a vector measures");
    }, 20_000);

    test("RRF merges both lists by rank, deterministically", () => {
      const key = (id: string) => id;
      const merged = fuse([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }], key);
      expect(merged.map((m) => m.id)).toEqual(["b", "a", "c"]);
      expect(merged[0]?.score).toBeCloseTo(1 / 62 + 1 / 61, 10);
      expect(merged[0]).toMatchObject({ vectorRank: 2, textRank: 1 });
      // A tie goes by key, whatever order the lists came in.
      expect(fuse([{ id: "z" }], [{ id: "y" }], key).map((m) => m.id)).toEqual(["y", "z"]);
      expect(fuse([{ id: "y" }], [{ id: "z" }], key).map((m) => m.id)).toEqual(["y", "z"]);
    });

    test("the same query gives the same result", async () => {
      const a = await ask("inner product of vectors");
      const b = await ask("inner product of vectors");
      expect(b.chunks.map((c) => [c.id, c.rank])).toEqual(a.chunks.map((c) => [c.id, c.rank]));
    }, 20_000);
  });

  describe("E13: the query side", () => {
    test("the query prefix is sent", async () => {
      await ask("prefixed query text");
      const sent = env.mock.requests
        .filter((r) => r.path.endsWith("/embeddings"))
        .flatMap((r) => r.body.input as string[]);
      expect(sent).toContain("query-prefix: prefixed query text");
    }, 20_000);

    test("a vector from a different model is never compared", async () => {
      await env.assignEmbeddings({ model: "another-model" });
      try {
        const { chunks, embeddingModel } = await ask("tabular operators chained together");
        expect(embeddingModel).toBe("another-model");
        expect(chunks.filter((c) => c.vectorRank !== null)).toEqual([]);
        // Full text doesn't depend on a model, so it still works.
        expect((await ask("xylophones")).chunks[0]?.textRank).toBe(1);
      } finally {
        await env.assignEmbeddings();
      }
    }, 20_000);
  });

  test("E14: RetrievalLog records the query, scope, chunk ids, ranks, scores and model", async () => {
    const { chunks, logId, embeddingModel } = await ask("x^T y", [scope], 10_000, { revisionId: null });
    expect(logId).not.toBeNull();
    const [row] = await env.t.db
      .select()
      .from(RetrievalLog)
      .where(eq(RetrievalLog.id, logId as string));
    expect(row?.query).toBe("x^T y");
    expect(row?.scope).toEqual([scope]);
    expect(row?.embeddingModel).toBe(embeddingModel);
    expect(embeddingModel).toBe(embeddingModelId(await env.t.ctx.llm.resolve("embeddings")));
    const results = row?.results as { chunkId: string; rank: number | null; score: number }[];
    expect(results.map((r) => r.chunkId)).toEqual(chunks.map((c) => c.id));
    expect(results[0]?.rank).toBe(1);
    expect(results[0]?.score).toBeGreaterThan(0);
  }, 20_000);

  describe("E15: the budget", () => {
    const tokens = (list: { tokenCount: number; text: string }[]) =>
      list.reduce((n, c) => n + estimateChunkTokens(c), 0);

    test("the chunks fit a small window and a large one, and a larger one gets more", async () => {
      const all = await env.t.db.select().from(SourceChunk).where(eq(SourceChunk.revisionId, source.latest.id));
      const smallest = Math.min(...all.map(estimateChunkTokens));
      const small = await ask("vector", [scope], smallest + 2);
      expect(small.chunks.length).toBeGreaterThanOrEqual(1);
      expect(tokens(small.chunks)).toBeLessThanOrEqual(smallest + 2);
      const large = await ask("vector", [scope], 100_000);
      expect(tokens(large.chunks)).toBeGreaterThan(tokens(small.chunks));
    }, 20_000);

    test("neighbours fill the budget after the ranked chunks, marked as such", async () => {
      // Past the 40 each search returns, so some chunks are ranked by neither.
      const body = Array.from({ length: 60 }, (_, i) => `Paragraph ${i}. ${"plain filler text ".repeat(100)}`);
      const text = `# Long\n\n${body.join("\n\n")}`;
      const res = await env.proctor.post(`${API}/sources`, { title: "Long", citationLabel: "LG", text });
      const long = await env.settled(env.proctor, res.json().source.id);
      expect(long.latest.chunks).toBeGreaterThan(45);
      // A budget past what the 40 ranked chunks take, counted as a prompt counts them (chars ÷ 3 at least).
      const { chunks } = await ask(
        "nothing matches this",
        [{ sourceId: long.id, revisionId: long.latest.id, sectionIds: null }],
        100_000,
      );
      const neighbours = chunks.filter((c) => c.rank === null);
      expect(neighbours.length).toBeGreaterThan(0);
      for (const n of neighbours) {
        expect(n.score).toBe(0);
        expect(n.vectorRank).toBeNull();
      }
      expect(chunks.slice(0, 40).every((c) => c.rank !== null)).toBe(true);
    }, 30_000);

    test("a budget too small for anything returns nothing, rather than an oversized chunk", async () => {
      expect((await ask("vector", [scope], 1)).chunks).toEqual([]);
    }, 20_000);

    test("the estimate route gives count, tokens and fit per role", async () => {
      await env.t.db.execute(sql`delete from role_assignment where role = 'authoring.objectives'`);
      // A small window for one role, so `fits` differs by role.
      await assign(env.t.db, "authoring.generate", {
        url: env.mock.url,
        capabilities: { contextWindow: 32_000, maxOutputTokens: 8000 },
      });
      await assign(env.t.db, "authoring.judge", {
        url: env.mock.url,
        capabilities: { contextWindow: 12, maxOutputTokens: 10 },
      });
      const res = await env.proctor.post(`${API}/sources/${source.id}/scope/estimate`, {
        sectionIds: [section("Chapter 1")],
        revision: 1,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const chapter = (await env.proctor.get(`${API}/sources/${source.id}/sections?revision=1`)).json().sections;
      const underIt = chapter.filter((s: { title: string }) =>
        ["Chapter 1", "Inner product", "Norm", "Secret"].includes(s.title),
      );
      expect(body.chunks).toBe(underIt.reduce((n: number, s: { chunks: number }) => n + s.chunks, 0));
      expect(body.tokens).toBe(underIt.reduce((n: number, s: { tokens: number }) => n + s.tokens, 0));
      const fit = Object.fromEntries(body.fit.map((f: { role: string }) => [f.role, f]));
      expect(fit["authoring.generate"]).toMatchObject({ assigned: true, fits: true, budget: 24_000 });
      expect(fit["authoring.judge"]).toMatchObject({ assigned: true, fits: false, budget: 2 });
      expect(fit["authoring.objectives"]).toMatchObject({ assigned: false, fits: false, budget: null });
      expect(JSON.stringify(body)).not.toContain("mock-model");
      expect((await env.other.post(`${API}/sources/${source.id}/scope/estimate`, {})).statusCode).toBe(404);
    }, 20_000);
  });
});
