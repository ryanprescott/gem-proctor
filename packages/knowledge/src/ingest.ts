import { type Db, EMBEDDING_DIMENSIONS, newId, SourceChunk, SourceRevision, SourceSection } from "@gem/db";
import type { EmbedOptions, EmbedResult, Target } from "@gem/llm";
import { AppError, type ModelRole, type SourceFormat, type SourcePreview } from "@gem/shared";
import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { type ChunkDraft, chunkSource, hashText, UnitTooLargeError } from "./chunk.ts";
import { type ParsedSource, parseSource } from "./parse.ts";

/** Saving a revision and embedding it (SPEC §3C.2, §3C.5, P2.md §5). */

/** What ingest and retrieval need from the LLM layer. */
export interface EmbeddingRuntime {
  resolve(role: ModelRole): Promise<Target>;
  embed(texts: string[], opts: EmbedOptions): Promise<EmbedResult>;
}

/** A chunk's size for a prompt budget: the endpoint's own count once embedded, and never below the estimate. */
export const estimateChunkTokens = (c: { text: string; tokenCount: number }) =>
  Math.max(c.tokenCount, Math.ceil(c.text.length / 3));

/** Each batch is one round of progress. */
export const EMBED_BATCH = 16;

/** Vectors from different models are never compared, so the id goes with each vector. */
export const embeddingModelId = (target: Pick<Target, "model">) => target.model;

/** The prefix counts against the cap: it's embedded with the chunk, and never stored (SPEC §3C.2). */
export function chunkCap(target: Pick<Target, "capabilities" | "embedding">): number | undefined {
  const cap = target.capabilities.maxInputTokens;
  if (cap === undefined) return undefined;
  const prefix = target.embedding?.documentPrefix ?? "";
  return Math.max(1, cap - Math.ceil(prefix.length / 3));
}

export interface Prepared {
  parsed: ParsedSource;
  chunks: ChunkDraft[];
}

export function prepareSource(
  text: string,
  opts: { title: string; citationLabel: string; format: SourceFormat; maxTokens?: number },
): Prepared {
  const parsed = parseSource(text, { title: opts.title, format: opts.format });
  try {
    return { parsed, chunks: chunkSource(text, parsed, opts) };
  } catch (err) {
    if (err instanceof UnitTooLargeError) {
      throw new AppError("knowledge_unit_too_large", {
        heading: err.heading,
        tokens: err.tokens,
        maxTokens: err.maxTokens,
      });
    }
    throw err;
  }
}

/** What a preview shows. Nothing is saved, and a unit over the cap is a warning here, not an error. */
export function previewSource(
  text: string,
  opts: { title: string; citationLabel: string; format: SourceFormat; maxTokens?: number },
): SourcePreview {
  const parsed = parseSource(text, { title: opts.title, format: opts.format });
  const warnings = [...parsed.warnings];
  let chunks: ChunkDraft[] = [];
  try {
    chunks = chunkSource(text, parsed, opts);
  } catch (err) {
    if (!(err instanceof UnitTooLargeError)) throw err;
    warnings.push({ code: "unit_too_large", heading: err.heading, tokens: err.tokens });
    chunks = chunkSource(text, parsed, { citationLabel: opts.citationLabel });
  }
  return {
    format: parsed.format,
    warnings,
    chunks: chunks.length,
    tokens: chunks.reduce((n, c) => n + c.tokenCount, 0),
    sections: parsed.sections.map((s) => {
      const own = chunks.filter((c) => c.section === s.order);
      return {
        order: s.order,
        parentOrder: s.parent,
        level: s.level,
        title: s.title,
        tokens: own.reduce((n, c) => n + c.tokenCount, 0),
        chunks: own.length,
      };
    }),
  };
}

type Tx = Pick<Db, "insert">;

/** Writes the revision's rows. Chunks are immutable: a new revision always means new rows (SPEC §3C.5). */
export async function saveRevision(
  tx: Tx,
  input: {
    sourceId: string;
    number: number;
    text: string;
    format: SourceFormat;
    createdBy: string;
    prepared: Prepared;
  },
): Promise<string> {
  const { parsed, chunks } = input.prepared;
  const revisionId = newId();
  await tx.insert(SourceRevision).values({
    id: revisionId,
    sourceId: input.sourceId,
    number: input.number,
    markdown: input.text,
    format: input.format,
    contentHash: hashText(input.text),
    embedStatus: "pending",
    createdBy: input.createdBy,
  });
  const sectionIds = parsed.sections.map(() => newId());
  for (const s of parsed.sections) {
    await tx.insert(SourceSection).values({
      id: sectionIds[s.order] as string,
      revisionId,
      parentId: s.parent === null ? null : (sectionIds[s.parent] as string),
      level: s.level,
      title: s.title,
      slug: s.slug,
      order: s.order,
      headingPath: s.headingPath,
      charStart: s.start,
      charEnd: s.end,
    });
  }
  if (chunks.length > 0) {
    await tx.insert(SourceChunk).values(
      chunks.map((c) => ({
        id: newId(),
        revisionId,
        sectionId: sectionIds[c.section] as string,
        chunkKey: c.chunkKey,
        charStart: c.charStart,
        charEnd: c.charEnd,
        contentHash: c.contentHash,
        text: c.text,
        tokenCount: c.tokenCount,
      })),
    );
  }
  return revisionId;
}

export interface EmbedProgress {
  done: number;
  total: number;
}

/**
 * Embeds a revision. A chunk whose hash and model match an earlier revision copies that vector, with no model call.
 * What's already stored survives a failure, so a retry only pays for the rest. Throws `AppError` or `LlmError`.
 */
export async function embedRevision(
  deps: { db: Db; llm: EmbeddingRuntime; userId?: string },
  revisionId: string,
  onProgress: (p: EmbedProgress) => Promise<void> | void,
): Promise<{ reused: number; embedded: number }> {
  const { db, llm } = deps;
  const target = await llm.resolve("embeddings");
  const dimensions = target.embedding?.dimensions;
  if (dimensions !== EMBEDDING_DIMENSIONS) {
    throw new AppError("knowledge_dimension_mismatch", {
      expected: EMBEDDING_DIMENSIONS,
      actual: dimensions ?? 0,
    });
  }
  const model = embeddingModelId(target);
  const [revision] = await db.select().from(SourceRevision).where(eq(SourceRevision.id, revisionId));
  if (!revision) throw new AppError("source_not_found");
  const chunks = await db
    .select({ id: SourceChunk.id, text: SourceChunk.text, hash: SourceChunk.contentHash, key: SourceChunk.chunkKey })
    .from(SourceChunk)
    .where(
      and(
        eq(SourceChunk.revisionId, revisionId),
        or(isNull(SourceChunk.embedding), ne(SourceChunk.embeddingModel, model)),
      ),
    )
    .orderBy(asc(SourceChunk.charStart));
  const [counted] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(SourceChunk)
    .where(eq(SourceChunk.revisionId, revisionId));
  const total = counted?.n ?? chunks.length;
  let done = total - chunks.length;
  await onProgress({ done, total });

  const cap = chunkCap(target);
  const over = cap === undefined ? undefined : chunks.find((c) => c.text.length / 3 > cap);
  if (over && cap !== undefined) {
    throw new AppError("knowledge_unit_too_large", {
      heading: over.key,
      tokens: Math.ceil(over.text.length / 3),
      maxTokens: cap,
    });
  }

  // Reuse is per source: an earlier revision's vector for the same text and the same model.
  const hashes = [...new Set(chunks.map((c) => c.hash))];
  const earlier =
    hashes.length === 0
      ? []
      : await db
          .selectDistinctOn([SourceChunk.contentHash], {
            hash: SourceChunk.contentHash,
            embedding: SourceChunk.embedding,
          })
          .from(SourceChunk)
          .innerJoin(SourceRevision, eq(SourceRevision.id, SourceChunk.revisionId))
          .where(
            and(
              eq(SourceRevision.sourceId, revision.sourceId),
              ne(SourceRevision.id, revisionId),
              inArray(SourceChunk.contentHash, hashes),
              eq(SourceChunk.embeddingModel, model),
              isNotNull(SourceChunk.embedding),
            ),
          );
  const vectors = new Map(earlier.map((e) => [e.hash, e.embedding as number[]]));
  const remaining: typeof chunks = [];
  let reused = 0;
  for (const c of chunks) {
    const vector = vectors.get(c.hash);
    if (!vector) {
      remaining.push(c);
      continue;
    }
    await db.update(SourceChunk).set({ embedding: vector, embeddingModel: model }).where(eq(SourceChunk.id, c.id));
    reused += 1;
    done += 1;
  }
  if (reused > 0) await onProgress({ done, total });

  let embedded = 0;
  for (let i = 0; i < remaining.length; i += EMBED_BATCH) {
    const batch = remaining.slice(i, i + EMBED_BATCH);
    const { vectors: out, tokens } = await llm.embed(
      batch.map((c) => c.text),
      { kind: "document", ...(deps.userId ? { userId: deps.userId } : {}) },
    );
    for (const [n, c] of batch.entries()) {
      await db
        .update(SourceChunk)
        .set({ embedding: out[n] as number[], embeddingModel: model, tokenCount: Math.max(1, tokens[n] ?? 1) })
        .where(eq(SourceChunk.id, c.id));
    }
    embedded += batch.length;
    done += batch.length;
    await onProgress({ done, total });
  }
  return { reused, embedded };
}
