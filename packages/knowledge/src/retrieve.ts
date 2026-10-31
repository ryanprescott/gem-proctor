import { type Db, newId, RetrievalLog, SourceChunk, SourceSection } from "@gem/db";
import { and, asc, eq, inArray, isNotNull, or, type SQL, sql } from "drizzle-orm";
import { type EmbeddingRuntime, embeddingModelId } from "./ingest.ts";

/**
 * Hybrid retrieval (SPEC §3C.3, P2.md §5). The scope filter is in the SQL of both searches, so a chunk outside it can
 * never come back, whatever its rank. Vector and full-text results are merged by reciprocal-rank fusion.
 */

export const RANK_LIMIT = 40;
export const RRF_K = 60;

/** One source in scope: a revision, and its sections (null: all of them). */
export interface ScopeEntry {
  sourceId: string;
  revisionId: string;
  sectionIds: string[] | null;
}

export interface RetrievedChunk {
  id: string;
  sourceId: string;
  revisionId: string;
  sectionId: string;
  chunkKey: string;
  text: string;
  tokenCount: number;
  charStart: number;
  /** Null for a neighbour added to fill the budget. */
  rank: number | null;
  score: number;
  vectorRank: number | null;
  textRank: number | null;
}

export interface RetrievalRequest {
  query: string;
  scope: ScopeEntry[];
  /** Most tokens of chunk text to return; what doesn't fit stays out (P2.md §5). */
  budgetTokens: number;
  /** Where `RetrievalLog` hangs from; without it nothing is logged. */
  log?: { revisionId: string | null; objectiveId: string | null };
  userId?: string;
  signal?: AbortSignal;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  embeddingModel: string;
  logId: string | null;
}

function scopeFilter(scope: ScopeEntry[]): SQL | undefined {
  return or(
    ...scope.map((s) =>
      s.sectionIds === null
        ? eq(SourceChunk.revisionId, s.revisionId)
        : and(eq(SourceChunk.revisionId, s.revisionId), inArray(SourceChunk.sectionId, s.sectionIds)),
    ),
  );
}

/** A section stands for everything under it: the picker sends what's ticked, and the filter needs the leaves too. */
export async function expandSections(db: Pick<Db, "select">, revisionId: string, ids: string[]): Promise<string[]> {
  const rows = await db
    .select({ id: SourceSection.id, parentId: SourceSection.parentId })
    .from(SourceSection)
    .where(eq(SourceSection.revisionId, revisionId));
  const out = new Set(ids);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) {
      if (r.parentId !== null && out.has(r.parentId) && !out.has(r.id)) {
        out.add(r.id);
        grew = true;
      }
    }
  }
  return [...out];
}

type Hit = { id: string };

async function vectorSearch(db: Db, filter: SQL, model: string, vector: number[]): Promise<Hit[]> {
  const literal = `[${vector.join(",")}]`;
  return db.transaction(async (tx) => {
    // A filtered HNSW scan can run out of candidates; this keeps it going until it has enough (pgvector 0.8).
    await tx.execute(sql`select set_config('hnsw.iterative_scan', 'relaxed_order', true)`);
    const rows = await tx
      .select({ id: SourceChunk.id, distance: sql<number>`${SourceChunk.embedding} <=> ${literal}::vector` })
      .from(SourceChunk)
      .where(and(filter, isNotNull(SourceChunk.embedding), eq(SourceChunk.embeddingModel, model)))
      .orderBy(sql`${SourceChunk.embedding} <=> ${literal}::vector`, asc(SourceChunk.chunkKey))
      .limit(RANK_LIMIT);
    return [...rows].sort((a, b) => a.distance - b.distance);
  });
}

/**
 * Any word can match, in either config: `simple` keeps notation like `x^T y` unstemmed, `english` stems prose. A chunk
 * holding the words as a phrase goes first, which is what makes notation queries exact.
 */
async function textSearch(db: Db, filter: SQL, query: string): Promise<Hit[]> {
  const anyWord = (config: "simple" | "english") =>
    sql`replace(plainto_tsquery(${sql.raw(`'${config}'`)}, ${query})::text, ' & ', ' | ')::tsquery`;
  const words = sql`(${anyWord("simple")} || ${anyWord("english")})`;
  const phrase = sql`phraseto_tsquery('simple', ${query})`;
  return db
    .select({ id: SourceChunk.id })
    .from(SourceChunk)
    .where(and(filter, sql`${SourceChunk.tsv} @@ ${words}`))
    .orderBy(
      sql`(${SourceChunk.tsv} @@ ${phrase}) desc`,
      sql`ts_rank_cd(${SourceChunk.tsv}, ${words}) desc`,
      asc(SourceChunk.chunkKey),
    )
    .limit(RANK_LIMIT);
}

/** Reciprocal-rank fusion: deterministic, with ties broken by key, which the caller supplies through `key`. */
export function fuse(
  vector: Hit[],
  text: Hit[],
  key: (id: string) => string,
): { id: string; score: number; vectorRank: number | null; textRank: number | null }[] {
  const merged = new Map<string, { score: number; vectorRank: number | null; textRank: number | null }>();
  const entry = (id: string) => {
    const e = merged.get(id) ?? { score: 0, vectorRank: null, textRank: null };
    merged.set(id, e);
    return e;
  };
  for (const [i, h] of vector.entries()) {
    const e = entry(h.id);
    e.vectorRank = i + 1;
    e.score += 1 / (RRF_K + i + 1);
  }
  for (const [i, h] of text.entries()) {
    const e = entry(h.id);
    e.textRank = i + 1;
    e.score += 1 / (RRF_K + i + 1);
  }
  return [...merged.entries()]
    .map(([id, e]) => ({ id, ...e }))
    .sort((a, b) => b.score - a.score || key(a.id).localeCompare(key(b.id)));
}

type Row = Omit<RetrievedChunk, "rank" | "score" | "vectorRank" | "textRank">;

const COLUMNS = {
  id: SourceChunk.id,
  revisionId: SourceChunk.revisionId,
  sectionId: SourceChunk.sectionId,
  chunkKey: SourceChunk.chunkKey,
  text: SourceChunk.text,
  tokenCount: SourceChunk.tokenCount,
  charStart: SourceChunk.charStart,
};

/** The chunks either side of what was picked, nearest the best rank first, while they fit. */
async function addNeighbours(
  db: Db,
  picked: RetrievedChunk[],
  scope: ScopeEntry[],
  filter: SQL,
  budget: number,
): Promise<RetrievedChunk[]> {
  let left = budget - picked.reduce((n, c) => n + c.tokenCount, 0);
  if (left <= 0 || picked.length === 0) return picked;
  const sections = [...new Set(picked.map((c) => c.sectionId))];
  const rows = await db
    .select(COLUMNS)
    .from(SourceChunk)
    .where(and(filter, inArray(SourceChunk.sectionId, sections)))
    .orderBy(asc(SourceChunk.charStart));
  const out = [...picked];
  const have = new Set(picked.map((c) => c.id));
  const sourceOf = new Map(scope.map((s) => [s.revisionId, s.sourceId]));
  for (const c of picked) {
    const inSection = rows.filter((r) => r.sectionId === c.sectionId);
    const at = inSection.findIndex((r) => r.id === c.id);
    for (const n of [inSection[at + 1], inSection[at - 1]]) {
      if (!n || have.has(n.id) || n.tokenCount > left) continue;
      have.add(n.id);
      left -= n.tokenCount;
      out.push({
        ...n,
        sourceId: sourceOf.get(n.revisionId) as string,
        rank: null,
        score: 0,
        vectorRank: null,
        textRank: null,
      });
    }
  }
  return out;
}

export async function retrieve(
  deps: { db: Db; llm: EmbeddingRuntime },
  req: RetrievalRequest,
): Promise<RetrievalResult> {
  const { db, llm } = deps;
  const target = await llm.resolve("embeddings");
  const embeddingModel = embeddingModelId(target);
  const filter = scopeFilter(req.scope);
  if (!filter) return { chunks: [], embeddingModel, logId: null };
  const opts = { kind: "query" as const, ...(req.userId ? { userId: req.userId } : {}) };
  const { vectors } = await llm.embed([req.query], { ...opts, ...(req.signal ? { signal: req.signal } : {}) });
  const [vectorHits, textHits] = [
    await vectorSearch(db, filter, embeddingModel, vectors[0] as number[]),
    await textSearch(db, filter, req.query),
  ];
  const ids = [...new Set([...vectorHits, ...textHits].map((h) => h.id))];
  const rows: (typeof COLUMNS extends unknown ? Omit<Row, "sourceId"> : never)[] =
    ids.length === 0 ? [] : await db.select(COLUMNS).from(SourceChunk).where(inArray(SourceChunk.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const sourceOf = new Map(req.scope.map((s) => [s.revisionId, s.sourceId]));
  const fused = fuse(vectorHits, textHits, (id) => byId.get(id)?.chunkKey ?? id);

  const picked: RetrievedChunk[] = [];
  let used = 0;
  for (const [i, f] of fused.entries()) {
    const row = byId.get(f.id);
    if (!row) continue;
    if (used + row.tokenCount > req.budgetTokens) continue;
    used += row.tokenCount;
    picked.push({ ...row, sourceId: sourceOf.get(row.revisionId) as string, ...f, rank: i + 1 });
  }
  const chunks = await addNeighbours(db, picked, req.scope, filter, req.budgetTokens);

  let logId: string | null = null;
  if (req.log) {
    logId = newId();
    await db.insert(RetrievalLog).values({
      id: logId,
      revisionId: req.log.revisionId,
      objectiveId: req.log.objectiveId,
      query: req.query,
      scope: req.scope,
      results: chunks.map((c) => ({
        chunkId: c.id,
        chunkKey: c.chunkKey,
        rank: c.rank,
        score: c.score,
        vectorRank: c.vectorRank,
        textRank: c.textRank,
      })),
      embeddingModel,
    });
  }
  return { chunks, embeddingModel, logId };
}
