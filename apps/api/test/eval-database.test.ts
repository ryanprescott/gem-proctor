// `retrieval-mini` through the database (P2.md E51): pgvector, the full-text index and rank fusion, as authoring
// retrieves, with the mock model's hashed vectors, so only the plumbing is measured, not the model.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Source, SourceChunk } from "@gem/db";
import { loadEvalSet, runEval } from "@gem/llm";
import { eq } from "drizzle-orm";
import { hybridRunner } from "../src/llm-eval-database.ts";
import { createSourceEnv, type SourceEnv } from "./authoring-helpers.ts";
import { API, hasDb } from "./helpers.ts";
import { verifyPython } from "./l7-helpers.ts";

describe.skipIf(!hasDb || !verifyPython)("retrieval-mini through the database", () => {
  let env: SourceEnv;
  beforeAll(async () => {
    env = await createSourceEnv();
  }, 60_000);
  afterAll(async () => env?.close());

  test("each query goes through pgvector and the hybrid search; the corpus is gone after", async () => {
    const set = loadEvalSet("retrieval-mini");
    if (set.kind !== "retrieval") throw new Error("kind");
    const report = await runEval(env.t.ctx.llm, set, { hybrid: hybridRunner(env.t.ctx, env.proctorId) });
    const s = report.summary;
    for (const k of ["top1", "mrr", "top1Pgvector", "mrrPgvector", "top1Hybrid", "mrrHybrid"]) {
      expect(s[k], k).toBeNumber();
      expect(s[k] as number).toBeGreaterThan(0);
      expect(s[k] as number).toBeLessThanOrEqual(1);
    }
    expect(s.queries).toBe(16);
    // The mock's hashed vectors carry no meaning, so here the words are all that finds a chunk. With a real model it is
    // the other way (SPEC §13 Q4, P2-audit E52): this checks the plumbing, not that fusion helps.
    expect(s.mrrHybrid as number).toBeGreaterThanOrEqual(s.mrrPgvector as number);

    // The corpus was a source of its own, soft-deleted: not in anyone's library, its chunks still stored.
    const list = (await env.proctor.get(`${API}/sources`)).json().sources;
    expect(list).toEqual([]);
    const rows = await env.t.db.select().from(Source).where(eq(Source.title, "retrieval-mini"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deletedAt).not.toBeNull();
    const chunks = await env.t.db.select().from(SourceChunk);
    expect(chunks.length).toBeGreaterThanOrEqual(set.fixtures.chunks.length);
  }, 60_000);
});
