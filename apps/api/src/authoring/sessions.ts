import {
  AuthoringSession,
  AuthoringSessionSource,
  newId,
  Objective,
  Source,
  SourceChunk,
  SourceRevision,
  SourceSection,
} from "@gem/db";
import { estimateChunkTokens, expandSections, type ScopeEntry } from "@gem/knowledge";
import { LlmError, styleLine } from "@gem/llm";
import {
  AppError,
  Blueprint,
  blueprintProblems,
  defaultBlueprint,
  ObjectiveProposal,
  type TestType,
} from "@gem/shared";
import type { ObjectiveInput, ObjectiveView, SessionSourceView } from "@gem/shared/contracts";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { writeAudit } from "../audit.ts";
import type { AppContext } from "../context.ts";

/** Sessions, their scope, objectives and blueprint (P2.md §5). Generation is in `generate.ts`. */

type Ctx = Pick<AppContext, "db" | "llm">;
type SessionRow = typeof AuthoringSession.$inferSelect;

export const sessionTopic = (id: string) => `authoring:${id}`;

/** Most evidence an objective from a heading keeps: enough to show where it comes from. */
const HEADING_EVIDENCE = 8;
const MAX_OBJECTIVES_PER_SECTION = 4;

export async function loadSession(ctx: Pick<AppContext, "db">, id: string): Promise<SessionRow> {
  const [row] = await ctx.db
    .select()
    .from(AuthoringSession)
    .where(and(eq(AuthoringSession.id, id), isNull(AuthoringSession.deletedAt)));
  if (!row) throw new AppError("authoring_session_not_found");
  return row;
}

/** Authoring needs the knowledge base: without `embeddings` there's nothing to retrieve (SPEC §3C.2). */
export async function requireEmbeddings(ctx: Pick<AppContext, "llm">) {
  await ctx.llm.resolve("embeddings");
}

async function latestRevision(ctx: Pick<AppContext, "db">, sourceId: string) {
  const [row] = await ctx.db
    .select()
    .from(SourceRevision)
    .where(eq(SourceRevision.sourceId, sourceId))
    .orderBy(desc(SourceRevision.number))
    .limit(1);
  if (!row) throw new AppError("source_not_found");
  return row;
}

/** A session uses its owner's sources, whoever is asking: an admin reads anything, but authors from their own. */
async function ownedReadySources(
  ctx: Pick<AppContext, "db">,
  ownerId: string,
  wanted: { sourceId: string; sectionIds?: string[] | undefined }[],
) {
  const rows = [];
  for (const w of wanted) {
    const [source] = await ctx.db
      .select()
      .from(Source)
      .where(and(eq(Source.id, w.sourceId), eq(Source.ownerId, ownerId), isNull(Source.deletedAt)));
    if (!source) throw new AppError("source_not_found");
    const revision = await latestRevision(ctx, source.id);
    if (revision.embedStatus !== "ready") throw new AppError("source_not_ready");
    if (w.sectionIds) {
      const known = await ctx.db
        .select({ id: SourceSection.id })
        .from(SourceSection)
        .where(and(eq(SourceSection.revisionId, revision.id), inArray(SourceSection.id, w.sectionIds)));
      if (known.length !== new Set(w.sectionIds).size) throw new AppError("authoring_scope_invalid");
    }
    rows.push({ source, revision, sectionIds: w.sectionIds ?? null });
  }
  return rows;
}

/** The session's scope as retrieval takes it: revisions pinned, and each section standing for what's under it. */
export async function sessionScope(ctx: Pick<AppContext, "db">, sessionId: string): Promise<ScopeEntry[]> {
  const rows = await ctx.db
    .select()
    .from(AuthoringSessionSource)
    .where(eq(AuthoringSessionSource.sessionId, sessionId));
  return Promise.all(
    rows.map(async (r) => ({
      sourceId: r.sourceId,
      revisionId: r.revisionId,
      sectionIds: r.sectionIds ? await expandSections(ctx.db, r.revisionId, r.sectionIds) : null,
    })),
  );
}

async function chunksInScope(ctx: Pick<AppContext, "db">, scope: ScopeEntry[]) {
  const out = [];
  for (const s of scope) {
    const rows = await ctx.db
      .select({
        id: SourceChunk.id,
        key: SourceChunk.chunkKey,
        sectionId: SourceChunk.sectionId,
        text: SourceChunk.text,
        tokenCount: SourceChunk.tokenCount,
      })
      .from(SourceChunk)
      .where(
        and(
          eq(SourceChunk.revisionId, s.revisionId),
          s.sectionIds ? inArray(SourceChunk.sectionId, s.sectionIds) : undefined,
        ),
      )
      .orderBy(asc(SourceChunk.charStart));
    out.push(...rows);
  }
  return out;
}

async function sectionsInScope(ctx: Pick<AppContext, "db">, scope: ScopeEntry[]) {
  const out = [];
  for (const s of scope) {
    const rows = await ctx.db
      .select()
      .from(SourceSection)
      .where(
        and(
          eq(SourceSection.revisionId, s.revisionId),
          s.sectionIds ? inArray(SourceSection.id, s.sectionIds) : undefined,
        ),
      )
      .orderBy(asc(SourceSection.order));
    out.push(...rows);
  }
  return out;
}

/** One objective per selected section that has text: coverage follows the material's own shape (SPEC §3C.4). */
async function headingObjectives(ctx: Pick<AppContext, "db">, sessionId: string) {
  const scope = await sessionScope(ctx, sessionId);
  const [sections, chunks] = [await sectionsInScope(ctx, scope), await chunksInScope(ctx, scope)];
  await ctx.db.delete(Objective).where(eq(Objective.sessionId, sessionId));
  let order = 0;
  for (const section of sections) {
    const own = chunks.filter((c) => c.sectionId === section.id);
    if (own.length === 0) continue;
    await ctx.db.insert(Objective).values({
      id: newId(),
      sessionId,
      label: section.title,
      description: "",
      evidence: own.slice(0, HEADING_EVIDENCE).map((c) => ({ chunkId: c.id })),
      origin: "heading",
      order: order++,
      sectionIds: [section.id],
    });
  }
}

export interface ScopeInput {
  sources: { sourceId: string; sectionIds?: string[] | undefined }[];
}

export async function createSession(
  ctx: Ctx,
  input: ScopeInput & { title: string; testType: TestType },
  ownerId: string,
  meta: object,
) {
  await requireEmbeddings(ctx);
  const sources = await ownedReadySources(ctx, ownerId, input.sources);
  const id = newId();
  await ctx.db.transaction(async (tx) => {
    await tx.insert(AuthoringSession).values({
      id,
      ownerId,
      title: input.title,
      status: "draft",
      testType: input.testType,
      usedValues: { keys: [], source: [] },
    });
    await tx.insert(AuthoringSessionSource).values(
      sources.map((s) => ({
        sessionId: id,
        sourceId: s.source.id,
        revisionId: s.revision.id,
        sectionIds: s.sectionIds,
      })),
    );
    await writeAudit(tx, {
      actorId: ownerId,
      action: "authoring_session.create",
      targetType: "authoring_session",
      targetId: id,
      after: { title: input.title, testType: input.testType, sources: sources.map((s) => s.source.id) },
      ...meta,
    });
  });
  await headingObjectives(ctx, id);
  return id;
}

/** A new scope starts objectives over from its headings. Only before anything is generated. */
export async function updateScope(ctx: Ctx, session: SessionRow, input: ScopeInput) {
  if (session.status !== "draft") throw new AppError("authoring_session_busy");
  const sources = await ownedReadySources(ctx, session.ownerId, input.sources);
  await ctx.db.transaction(async (tx) => {
    await tx.delete(AuthoringSessionSource).where(eq(AuthoringSessionSource.sessionId, session.id));
    await tx.insert(AuthoringSessionSource).values(
      sources.map((s) => ({
        sessionId: session.id,
        sourceId: s.source.id,
        revisionId: s.revision.id,
        sectionIds: s.sectionIds,
      })),
    );
    await tx.update(AuthoringSession).set({ blueprint: null }).where(eq(AuthoringSession.id, session.id));
  });
  await headingObjectives(ctx, session.id);
}

export async function sessionSources(ctx: Pick<AppContext, "db">, sessionId: string): Promise<SessionSourceView[]> {
  const rows = await ctx.db
    .select({ scope: AuthoringSessionSource, source: Source, revision: SourceRevision })
    .from(AuthoringSessionSource)
    .innerJoin(Source, eq(Source.id, AuthoringSessionSource.sourceId))
    .innerJoin(SourceRevision, eq(SourceRevision.id, AuthoringSessionSource.revisionId))
    .where(eq(AuthoringSessionSource.sessionId, sessionId));
  return Promise.all(
    rows.map(async ({ scope, source, revision }) => {
      const latest = await latestRevision(ctx, source.id);
      return {
        sourceId: source.id,
        title: source.title,
        citationLabel: source.citationLabel,
        revisionId: revision.id,
        revisionNumber: revision.number,
        sectionIds: scope.sectionIds,
        latestRevisionNumber: latest.number,
        // A newer revision isn't news until it can be used (SPEC §3C.5).
        changed: latest.id !== revision.id && latest.embedStatus === "ready",
      };
    }),
  );
}

export async function objectiveViews(ctx: Pick<AppContext, "db">, sessionId: string): Promise<ObjectiveView[]> {
  const rows = await ctx.db
    .select()
    .from(Objective)
    .where(eq(Objective.sessionId, sessionId))
    .orderBy(asc(Objective.order));
  return rows.map((o) => ({
    id: o.id,
    label: o.label,
    description: o.description,
    evidence: o.evidence as { chunkId: string }[],
    origin: o.origin,
    order: o.order,
    sectionIds: o.sectionIds,
  }));
}

interface Proposed {
  objectives: ObjectiveView[];
  /** `headings_only`: the role isn't assigned, so the heading objectives stand. */
  notice: "headings_only" | null;
  /** Objectives dropped for citing a chunk that wasn't sent. */
  rejected: number;
  /** Sections the model failed on; they keep their heading objective. */
  failedSections: string[];
}

const normalLabel = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Asks `authoring.objectives` section by section, then merges (SPEC §3A.1 step 2). A section's heading objective makes
 * way for what the model proposes. What a creator wrote stays. A citation is only kept if that chunk was sent.
 */
export async function proposeObjectives(ctx: Ctx, session: SessionRow, userId: string): Promise<Proposed> {
  if (session.status === "generating" || session.status === "published") {
    throw new AppError("authoring_session_busy");
  }
  const target = await ctx.llm.resolve("authoring.objectives").catch((err: unknown) => {
    if (err instanceof LlmError && err.code === "llm_role_unassigned") return null;
    throw err;
  });
  if (!target) {
    return {
      objectives: await objectiveViews(ctx, session.id),
      notice: "headings_only",
      rejected: 0,
      failedSections: [],
    };
  }
  const scope = await sessionScope(ctx, session.id);
  const [sections, chunks] = [await sectionsInScope(ctx, scope), await chunksInScope(ctx, scope)];
  const existing = await objectiveViews(ctx, session.id);
  const budget = target.capabilities.contextWindow - target.capabilities.maxOutputTokens - 1024;
  const failedSections: string[] = [];
  const seen = new Set(existing.filter((o) => o.origin === "human").map((o) => normalLabel(o.label)));
  const proposed: Omit<ObjectiveView, "id" | "order">[] = [];
  let rejected = 0;

  for (const section of sections) {
    const own = chunks.filter((c) => c.sectionId === section.id);
    if (own.length === 0) continue;
    const sent: typeof own = [];
    let used = 0;
    for (const c of own) {
      const tokens = estimateChunkTokens(c);
      if (used + tokens > budget) break;
      used += tokens;
      sent.push(c);
    }
    const passages = sent.map((c) => `[${c.key}]\n${c.text}`).join("\n\n");
    const reply = await ctx.llm
      .generateObject(
        "authoring.objectives",
        ObjectiveProposal,
        {
          promptId: "authoring.objectives",
          vars: { maxObjectives: String(MAX_OBJECTIVES_PER_SECTION) },
          messages: [{ role: "user", content: `Section: ${section.headingPath.join(" > ")}\n\n${passages}` }],
        },
        { userId, maxRepairs: 1 },
      )
      .catch((err: unknown) => {
        if (err instanceof LlmError && err.code !== "llm_cloud_blocked") return null;
        throw err;
      });
    if (!reply) {
      failedSections.push(section.title);
      proposed.push(...existing.filter((o) => o.origin === "heading" && o.sectionIds.includes(section.id)));
      continue;
    }
    const byKey = new Map(sent.map((c) => [c.key, c.id]));
    let kept = 0;
    for (const o of reply.value.objectives) {
      const ids = o.chunkIds.map((k) => byKey.get(k));
      if (ids.some((id) => id === undefined)) {
        rejected += 1;
        continue;
      }
      const label = normalLabel(o.label);
      if (seen.has(label)) continue;
      seen.add(label);
      kept += 1;
      proposed.push({
        label: o.label.trim(),
        description: o.description.trim(),
        evidence: [...new Set(ids as string[])].map((chunkId) => ({ chunkId })),
        origin: "llm",
        sectionIds: [section.id],
      });
    }
    // Nothing usable came back: the heading objective is still the section's coverage target.
    if (kept === 0)
      proposed.push(...existing.filter((o) => o.origin === "heading" && o.sectionIds.includes(section.id)));
  }

  const humans = existing.filter((o) => o.origin === "human");
  await ctx.db.transaction(async (tx) => {
    await tx.delete(Objective).where(eq(Objective.sessionId, session.id));
    let order = 0;
    for (const o of [...proposed, ...humans]) {
      await tx.insert(Objective).values({ ...o, id: newId(), sessionId: session.id, order: order++ });
    }
    await tx.update(AuthoringSession).set({ blueprint: null }).where(eq(AuthoringSession.id, session.id));
  });
  return { objectives: await objectiveViews(ctx, session.id), notice: null, rejected, failedSections };
}

/**
 * The creator's list, whole: edit, merge, remove and add all come to this. Evidence must be chunks in scope, whatever
 * the client sends. Keeping an id keeps the objective; a new one is `human`.
 */
export async function replaceObjectives(ctx: Ctx, session: SessionRow, input: ObjectiveInput[]) {
  if (session.status === "generating" || session.status === "published") {
    throw new AppError("authoring_session_busy");
  }
  const scope = await sessionScope(ctx, session.id);
  const inScope = new Set((await chunksInScope(ctx, scope)).map((c) => c.id));
  const known = new Map((await objectiveViews(ctx, session.id)).map((o) => [o.id, o]));
  for (const o of input) {
    const bad = o.evidence.find((e) => !inScope.has(e.chunkId));
    if (bad) throw new AppError("authoring_chunk_unknown", { chunkId: bad.chunkId });
    if (o.id !== undefined && !known.has(o.id)) throw new AppError("authoring_objective_unknown");
  }
  await ctx.db.transaction(async (tx) => {
    await tx.delete(Objective).where(eq(Objective.sessionId, session.id));
    for (const [order, o] of input.entries()) {
      const before = o.id === undefined ? undefined : known.get(o.id);
      await tx.insert(Objective).values({
        id: o.id ?? newId(),
        sessionId: session.id,
        label: o.label,
        description: o.description ?? "",
        evidence: o.evidence,
        origin: before?.origin ?? "human",
        order,
        sectionIds: o.sectionIds,
      });
    }
    await tx.update(AuthoringSession).set({ blueprint: null }).where(eq(AuthoringSession.id, session.id));
  });
  return objectiveViews(ctx, session.id);
}

/** Tokens of selected text behind each objective: its sections, or its evidence when it has none. */
async function objectiveWeights(ctx: Pick<AppContext, "db">, sessionId: string) {
  const objectives = await objectiveViews(ctx, sessionId);
  const chunks = await chunksInScope(ctx, await sessionScope(ctx, sessionId));
  return objectives.map((o) => {
    const evidence = new Set(o.evidence.map((e) => e.chunkId));
    const own = chunks.filter((c) =>
      o.sectionIds.length > 0 ? o.sectionIds.includes(c.sectionId) : evidence.has(c.id),
    );
    return { id: o.id, tokens: own.reduce((n, c) => n + c.tokenCount, 0) };
  });
}

/** A test type fills the defaults; anything sent as well overrides them, and the sums must still hold. */
export async function saveBlueprint(
  ctx: Ctx,
  session: SessionRow,
  input: Partial<Blueprint> & { testType: TestType },
): Promise<Blueprint> {
  if (session.status === "generating" || session.status === "published") {
    throw new AppError("authoring_session_busy");
  }
  const weights = await objectiveWeights(ctx, session.id);
  if (weights.length === 0) throw new AppError("authoring_no_objectives");
  const target = await ctx.llm.resolve("authoring.generate").catch(() => null);
  const defaults = defaultBlueprint(input.testType, weights, styleLine(input.testType, target?.model ?? "any"));
  const blueprint = Blueprint.parse({ ...defaults, ...input });
  // A new length with no counts sent: spread it again rather than refuse the old ones.
  const known = new Set(weights.map((w) => w.id));
  if (blueprint.perObjective.some((o) => !known.has(o.objectiveId))) throw new AppError("authoring_objective_unknown");
  const problems = blueprintProblems(blueprint);
  if (problems.length > 0) throw new AppError("authoring_blueprint_invalid", { problem: problems[0] as string });
  await ctx.db
    .update(AuthoringSession)
    .set({ blueprint, testType: blueprint.testType })
    .where(eq(AuthoringSession.id, session.id));
  return blueprint;
}

export async function deleteSession(
  ctx: Pick<AppContext, "db" | "now">,
  session: SessionRow,
  userId: string,
  meta: object,
) {
  await ctx.db.transaction(async (tx) => {
    await tx.update(AuthoringSession).set({ deletedAt: ctx.now() }).where(eq(AuthoringSession.id, session.id));
    await writeAudit(tx, {
      actorId: userId,
      action: "authoring_session.delete",
      targetType: "authoring_session",
      targetId: session.id,
      after: { title: session.title, status: session.status },
      ...meta,
    });
  });
}
