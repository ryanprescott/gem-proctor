import { randomBytes } from "node:crypto";
import {
  type BatchPlan,
  checkGrounding,
  checkStructure,
  describeCounts,
  planBatches,
  questionsPerCall,
  RESULT_TYPE_RULES,
} from "@gem/authoring";
import { AuthoringBatch, AuthoringSession, DraftQuestion, newId, Revision } from "@gem/db";
import { estimateChunkTokens, type RetrievedChunk, retrieve } from "@gem/knowledge";
import { LlmError, loadPrompt, type Target } from "@gem/llm";
import {
  ALLOWED_IMPORTS,
  AppError,
  type Blueprint,
  type DraftContent,
  type DraftEvidence,
  type ErrorCode,
  type GeneratedQuestion,
  GenerationBatch,
  type LayerResult,
} from "@gem/shared";
import type { BatchFailedItem, BatchView, SessionProgress } from "@gem/shared/contracts";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { addEvent, contentOf, type DraftRow, formResult, latestResults, recordResults } from "./drafts.ts";
import { loadSession, objectiveViews, sessionScope, sessionTopic } from "./sessions.ts";

/** Generation: per-objective batches, each one pg-boss job through `streamObject` (SPEC §3A.2, P2.md §5). */

export const GENERATE_QUEUE = "llm.generate";
export const L7_QUEUE = "authoring.l7";

type SessionRow = typeof AuthoringSession.$inferSelect;
type BatchRow = typeof AuthoringBatch.$inferSelect;

/** Bounds a single call on a large window: more text costs time, and a question cites only a passage or two. */
export const MAX_RETRIEVAL_TOKENS = 8000;
const CHARS_PER_TOKEN = 3;

/** Stored on the batch, and everything a retry or a revise needs to ask the same thing again. */
export interface StoredPlan extends BatchPlan {
  /** Regenerating: the question to replace, the creator's note, the failed checks. */
  replaces?: { draftId: string; note: string | null; failures: string[]; question: string } | undefined;
  /** Sent as context and asserted unchanged (SPEC §3A.1 step 7). */
  locked?: { question: string }[] | undefined;
}

const running = new Map<string, AbortController>();

async function nextRevision(ctx: Pick<AppContext, "db">, sessionId: string) {
  const [row] = await ctx.db
    .select({ n: sql<number>`coalesce(max(${Revision.number}), 0)::int` })
    .from(Revision)
    .where(eq(Revision.sessionId, sessionId));
  return (row?.n ?? 0) + 1;
}

/** One seed per revision; a question's seed comes from it and its `tempId` (P2.md §5). */
export async function createRevision(
  ctx: Pick<AppContext, "db">,
  sessionId: string,
  trigger: "generate" | "revise",
  request: unknown,
) {
  const id = newId();
  const number = await nextRevision(ctx, sessionId);
  await ctx.db
    .insert(Revision)
    .values({ id, sessionId, number, trigger, request, seed: randomBytes(16).toString("hex") });
  return { id, number };
}

export async function queueBatches(
  ctx: AppContext,
  session: SessionRow,
  revisionId: string,
  plans: StoredPlan[],
): Promise<void> {
  if (!ctx.queue) throw new AppError("service_unavailable");
  const ids = plans.map(() => newId());
  await ctx.db.transaction(async (tx) => {
    for (const [i, plan] of plans.entries()) {
      await tx.insert(AuthoringBatch).values({
        id: ids[i] as string,
        sessionId: session.id,
        revisionId,
        status: "queued",
        plan,
        failedItems: [],
      });
    }
    await tx.update(AuthoringSession).set({ status: "generating" }).where(eq(AuthoringSession.id, session.id));
  });
  for (const batchId of ids) await ctx.queue.send(GENERATE_QUEUE, { batchId });
  ctx.events.publish(sessionTopic(session.id));
}

export async function startGeneration(ctx: AppContext, session: SessionRow) {
  // Once there are questions, more come through retry or revise: generating again would double them.
  if (session.status !== "draft") throw new AppError("authoring_session_busy");
  const blueprint = session.blueprint as Blueprint | null;
  if (!blueprint) throw new AppError("authoring_no_blueprint");
  const [target] = [await ctx.llm.resolve("authoring.generate"), await ctx.llm.resolve("embeddings")];
  await ctx.llm.resolve("verify.solve");
  const plans = planBatches(blueprint, questionsPerCall(target.capabilities.maxOutputTokens));
  const revision = await createRevision(ctx, session.id, "generate", { blueprint });
  await ctx.db.update(AuthoringSession).set({ model: target.model }).where(eq(AuthoringSession.id, session.id));
  await queueBatches(ctx, session, revision.id, plans);
}

interface Prompted {
  vars: Record<string, string>;
  user: string;
  chunks: RetrievedChunk[];
  objectiveIds: Map<string, string>;
}

const chunkBlock = (c: RetrievedChunk) => `Source chunk [${c.chunkKey}]:\n${c.text}`;

function userPrompt(blocks: string[], objectives: string[], plan: StoredPlan, blueprint: Blueprint) {
  const parts = [...blocks, `Objectives:\n${objectives.join("\n")}`];
  if (plan.locked?.length) {
    const list = plan.locked.map((q) => `- ${q.question}`).join("\n");
    parts.push(`Already accepted, so don't repeat these or test the same thing:\n${list}`);
  }
  if (plan.replaces) {
    const { question, note, failures } = plan.replaces;
    parts.push(`Replace this question:\n${question}`);
    if (note) parts.push(`The creator's note: ${note}`);
    if (failures.length > 0) parts.push(`It failed these checks: ${failures.join("; ")}`);
  }
  if (blueprint.constraints.trim()) parts.push(`Constraints from the creator: ${blueprint.constraints.trim()}`);
  parts.push(`Write ${plan.size} questions: ${describeCounts(plan.counts)}.`);
  return parts.join("\n\n");
}

/**
 * Retrieves for the batch's objectives, within the window. What's left after the instructions and the frame goes to
 * chunks, by the runtime's own estimate, so `llm_context_exceeded` can't come from chunks (P2.md §5).
 */
async function buildPrompt(
  ctx: AppContext,
  batch: BatchRow,
  target: Target,
  blueprint: Blueprint,
  signal: AbortSignal,
  userId: string,
): Promise<Prompted> {
  const plan = batch.plan as StoredPlan;
  const all = await objectiveViews(ctx, batch.sessionId);
  const objectives = plan.objectiveIds.flatMap((id) => all.filter((o) => o.id === id));
  const ids = new Map(objectives.map((o, i) => [`O${i + 1}`, o.id]));
  const lines = objectives.map((o, i) => `O${i + 1}: ${o.label}${o.description ? ` — ${o.description}` : ""}`);
  const vars = {
    allowedImports: ALLOWED_IMPORTS,
    resultTypeRules: RESULT_TYPE_RULES,
    styleGuidance: blueprint.style,
  };
  const prompt = loadPrompt("authoring.generate", target.model);
  const frame = userPrompt([], lines, plan, blueprint);
  const taken = Math.ceil((prompt.template.length + frame.length + vars.styleGuidance.length + 1200) / CHARS_PER_TOKEN);
  const room = target.capabilities.contextWindow - target.capabilities.maxOutputTokens - taken;
  const budget = Math.max(0, Math.min(room, MAX_RETRIEVAL_TOKENS));
  const scope = await sessionScope(ctx, batch.sessionId);

  const chosen = new Map<string, RetrievedChunk>();
  const share = Math.floor(budget / Math.max(objectives.length, 1));
  for (const o of objectives) {
    const { chunks } = await retrieve(
      { db: ctx.db, llm: ctx.llm },
      {
        query: `${o.label} ${o.description}`.trim(),
        scope,
        budgetTokens: share,
        log: { revisionId: batch.revisionId, objectiveId: o.id },
        userId,
        signal,
      },
    );
    for (const c of chunks) chosen.set(c.id, c);
  }
  // Each block's tag costs a few tokens too: drop from the end until it's all in.
  const chunks = [...chosen.values()];
  while (chunks.length > 0 && chunks.reduce((n, c) => n + estimateChunkTokens(c) + 16, 0) > Math.max(room, 0)) {
    chunks.pop();
  }
  return { vars, user: userPrompt(chunks.map(chunkBlock), lines, plan, blueprint), chunks, objectiveIds: ids };
}

function contentFrom(
  q: GeneratedQuestion,
  sent: Map<string, RetrievedChunk>,
  ids: Map<string, string>,
  call: { callLogId: string; promptVersion: string; model: string },
): DraftContent {
  const evidence: DraftEvidence[] = q.evidence.map((e) => {
    const chunk = sent.get(e.chunkId);
    return { sourceId: chunk?.sourceId ?? "", chunkId: chunk?.id ?? e.chunkId, chunkKey: e.chunkId, quote: e.quote };
  });
  const options = q.computable
    ? []
    : (q.options as { text: string; isCorrect: boolean; whyWrong?: string }[]).map((o) => ({
        text: o.text,
        isCorrect: o.isCorrect,
        ...(o.whyWrong ? { whyWrong: o.whyWrong } : {}),
      }));
  const accepted = "acceptedAnswers" in q ? q.acceptedAnswers : [];
  const correct = options.filter((o) => o.isCorrect).map((o) => o.text);
  return {
    type: q.type,
    topic: q.topic,
    computable: q.computable,
    objectiveIds: q.objectiveIds.map((id) => ids.get(id) ?? id),
    template: q.question,
    question: q.computable ? null : q.question,
    options: q.type === "short_answer" || q.type === "numeric" ? null : options,
    correctAnswer: q.computable ? null : (correct[0] ?? accepted[0] ?? null),
    ...(q.type === "multi_choice" ? { correctAnswers: correct } : {}),
    ...(accepted.length > 1 ? { acceptedAnswers: accepted.slice(1) } : {}),
    numericTolerance: null,
    explanation: q.explanation,
    evidence,
    inputs: (q.inputs as DraftContent["inputs"]) ?? [],
    constraint: q.constraint,
    answerProgram: q.answerProgram,
    mistakes: (q.mistakes as DraftContent["mistakes"]) ?? [],
    verification: null,
    l7: null,
    l7Pending: false,
    provenance: "llm",
    callLogId: call.callLogId,
    promptVersion: call.promptVersion,
    model: call.model,
  };
}

/** L1–L3, in process, on arrival (P2.md §5). */
export function localChecks(
  content: DraftContent,
  chunks: ReadonlyMap<string, string>,
  context: { objectiveIds: ReadonlySet<string>; chunkIds: ReadonlySet<string> },
  threshold: number,
): LayerResult[] {
  const evidence = content.evidence.map((e) => ({ chunkId: e.chunkId, quote: e.quote }));
  const structure = checkStructure(
    {
      type: content.type,
      computable: content.computable,
      question: content.template,
      objectiveIds: content.objectiveIds,
      evidence,
      inputs: content.inputs,
      answerProgram: content.answerProgram,
      options: content.computable ? [] : (content.options ?? []),
      mistakes: content.mistakes,
    },
    context,
  );
  const grounding = checkGrounding(evidence, chunks, threshold);
  const passages = [
    ...content.evidence.map((e) => e.quote),
    ...content.evidence.flatMap((e) => chunks.get(e.chunkId) ?? []),
  ];
  return [structure, grounding, formResult(content, passages, false)];
}

async function nextPosition(ctx: Pick<AppContext, "db">, sessionId: string) {
  const [row] = await ctx.db
    .select({ n: sql<number>`coalesce(max(${DraftQuestion.position}), 0)::int` })
    .from(DraftQuestion)
    .where(eq(DraftQuestion.sessionId, sessionId));
  return (row?.n ?? 0) + 1;
}

/** The accept rule's input: whether L7 should run on this at all (P2.md §5). */
const needsL7 = (results: LayerResult[]) =>
  !results.some((r) => (r.layer === "L1" || r.layer === "L2") && r.outcome === "fail");

async function saveQuestions(
  ctx: AppContext,
  batch: BatchRow,
  values: GeneratedQuestion[],
  prompted: Prompted,
  call: { callLogId: string; promptVersion: string; model: string },
  threshold: number,
) {
  const plan = batch.plan as StoredPlan;
  const sent = new Map(prompted.chunks.map((c) => [c.chunkKey, c]));
  const texts = new Map(prompted.chunks.map((c) => [c.id, c.text]));
  const context = {
    objectiveIds: new Set(prompted.objectiveIds.values()),
    chunkIds: new Set(prompted.chunks.map((c) => c.id)),
  };
  let position = await nextPosition(ctx, batch.sessionId);
  for (const [i, q] of values.entries()) {
    const content = contentFrom(q, sent, prompted.objectiveIds, call);
    const results = localChecks(content, texts, context, (await settingsOf(ctx)).groundingThreshold ?? threshold);
    const id = newId();
    const pending = needsL7(results);
    await ctx.db.transaction(async (tx) => {
      await tx.insert(DraftQuestion).values({
        id,
        sessionId: batch.sessionId,
        revisionId: batch.revisionId,
        batchId: batch.id,
        tempId: `${q.tempId}-${position}`.slice(0, 40),
        position,
        content: { ...content, l7Pending: pending },
        status: "proposed",
        creatorNote: plan.replaces?.note ?? null,
        supersedesId: i === 0 ? (plan.replaces?.draftId ?? null) : null,
      });
      await addEvent(tx, {
        draftQuestionId: id,
        kind: plan.replaces && i === 0 ? "regenerated" : "generated",
        revisionId: batch.revisionId,
        after: { question: content.template, callLogId: call.callLogId },
        note: plan.replaces?.note ?? null,
      });
      await recordResults(tx, id, batch.revisionId, results);
    });
    position += 1;
    if (pending) await ctx.queue?.send(L7_QUEUE, { draftId: id, flow: "auto" });
  }
}

async function settingsOf(ctx: AppContext) {
  const { getSettings } = await import("../settings.ts");
  return (await getSettings(ctx.db)).authoring;
}

/** A reply cut off at the output budget parses to its complete questions: what it lost has to be said (P2.md §5). */
function lostItems(result: {
  normalizationFixes: { code: string }[];
  failedItems?: { index: number; issues: { path: string; message: string }[] }[];
}): BatchFailedItem[] {
  const items: BatchFailedItem[] = (result.failedItems ?? []).map((f) => ({
    kind: "invalid",
    index: f.index,
    issues: f.issues,
  }));
  if (result.normalizationFixes.some((f) => f.code === "truncated")) {
    items.push({
      kind: "truncated",
      index: -1,
      issues: [{ path: "questions", message: "the reply was cut off, and its last question was dropped" }],
    });
  }
  return items;
}

/** When nothing's left to run, the session is ready for review. */
export async function settleSession(ctx: AppContext, sessionId: string) {
  const batches = await ctx.db
    .select({ status: AuthoringBatch.status })
    .from(AuthoringBatch)
    .where(eq(AuthoringBatch.sessionId, sessionId));
  const busy = batches.some((b) => b.status === "queued" || b.status === "running");
  const drafts = await ctx.db.select().from(DraftQuestion).where(eq(DraftQuestion.sessionId, sessionId));
  const pending = drafts.some((d) => contentOf(d).l7Pending);
  if (!busy && !pending) {
    await ctx.db
      .update(AuthoringSession)
      .set({ status: drafts.length > 0 ? "review" : "draft" })
      .where(and(eq(AuthoringSession.id, sessionId), eq(AuthoringSession.status, "generating")));
  }
  ctx.events.publish(sessionTopic(sessionId));
}

const errorCodeOf = (err: unknown): ErrorCode => {
  if (err instanceof LlmError) return err.code as ErrorCode;
  if (err instanceof AppError) return err.code;
  return "internal";
};

/** Runs one batch to the end. Never throws: a failure stays on the row, with its code, for a retry (SPEC §3A.2). */
export async function processBatch(ctx: AppContext, batchId: string): Promise<void> {
  const [batch] = await ctx.db.select().from(AuthoringBatch).where(eq(AuthoringBatch.id, batchId));
  if (!batch || batch.status !== "queued") return;
  const controller = new AbortController();
  running.set(batchId, controller);
  const session = await loadSession(ctx, batch.sessionId).catch(() => null);
  const set = async (values: Partial<typeof AuthoringBatch.$inferInsert>) => {
    await ctx.db.update(AuthoringBatch).set(values).where(eq(AuthoringBatch.id, batchId));
    ctx.events.publish(sessionTopic(batch.sessionId));
  };
  await set({ status: "running", startedAt: new Date(), errorCode: null, failedItems: [] });
  try {
    if (!session) throw new AppError("authoring_session_not_found");
    const blueprint = session.blueprint as Blueprint;
    const target = await ctx.llm.resolve("authoring.generate");
    const { signal } = controller;
    const prompted = await buildPrompt(ctx, batch, target, blueprint, signal, session.ownerId);
    const stream = ctx.llm.streamObject(
      "authoring.generate",
      GenerationBatch,
      { promptId: "authoring.generate", vars: prompted.vars, messages: [{ role: "user", content: prompted.user }] },
      { userId: session.ownerId, signal, salvage: { path: "questions" } },
    );
    let seen = 0;
    for await (const partial of stream) {
      const written = (partial as { questions?: unknown[] }).questions?.length ?? 0;
      if (written !== seen) {
        seen = written;
        ctx.events.publish(sessionTopic(batch.sessionId));
      }
    }
    const result = await stream.final;
    const call = { callLogId: result.callLogId, promptVersion: result.promptVersion, model: result.model };
    await saveQuestions(ctx, batch, result.value.questions, prompted, call, 0.9);
    await set({
      status: "done",
      callLogId: result.callLogId,
      failedItems: lostItems(result),
      finishedAt: new Date(),
    });
  } catch (err) {
    if (controller.signal.aborted) await set({ status: "cancelled", finishedAt: new Date() });
    else await set({ status: "failed", errorCode: errorCodeOf(err), finishedAt: new Date() });
  } finally {
    running.delete(batchId);
    await settleSession(ctx, batch.sessionId);
  }
}

/** Queued batches never start; a running one's call is aborted through its signal (P2.md §5). */
export async function cancelGeneration(ctx: AppContext, sessionId: string) {
  const batches = await ctx.db.select().from(AuthoringBatch).where(eq(AuthoringBatch.sessionId, sessionId));
  await ctx.db
    .update(AuthoringBatch)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(and(eq(AuthoringBatch.sessionId, sessionId), eq(AuthoringBatch.status, "queued")));
  for (const b of batches) running.get(b.id)?.abort(new Error("cancelled"));
  await settleSession(ctx, sessionId);
}

export async function retryBatch(ctx: AppContext, batchId: string) {
  const [batch] = await ctx.db.select().from(AuthoringBatch).where(eq(AuthoringBatch.id, batchId));
  if (!batch) throw new AppError("authoring_batch_not_found");
  if (batch.status !== "failed" && batch.status !== "cancelled") throw new AppError("authoring_session_busy");
  if (!ctx.queue) throw new AppError("service_unavailable");
  await ctx.db
    .update(AuthoringBatch)
    .set({ status: "queued", errorCode: null, failedItems: [], finishedAt: null })
    .where(eq(AuthoringBatch.id, batchId));
  await ctx.db.update(AuthoringSession).set({ status: "generating" }).where(eq(AuthoringSession.id, batch.sessionId));
  await ctx.queue.send(GENERATE_QUEUE, { batchId });
  ctx.events.publish(sessionTopic(batch.sessionId));
}

export async function batchViews(ctx: Pick<AppContext, "db">, sessionId: string): Promise<BatchView[]> {
  const rows = await ctx.db
    .select({ batch: AuthoringBatch, number: Revision.number })
    .from(AuthoringBatch)
    .innerJoin(Revision, eq(Revision.id, AuthoringBatch.revisionId))
    .where(eq(AuthoringBatch.sessionId, sessionId))
    .orderBy(asc(AuthoringBatch.createdAt), asc(AuthoringBatch.id));
  const ids = rows.map((r) => r.batch.id);
  const counts =
    ids.length === 0
      ? []
      : await ctx.db
          .select({ id: DraftQuestion.batchId, n: sql<number>`count(*)::int` })
          .from(DraftQuestion)
          .where(inArray(DraftQuestion.batchId, ids))
          .groupBy(DraftQuestion.batchId);
  const written = new Map(counts.map((c) => [c.id, c.n]));
  return rows.map(({ batch, number }) => {
    const plan = batch.plan as StoredPlan;
    return {
      id: batch.id,
      revision: number,
      status: batch.status,
      objectiveIds: plan.objectiveIds,
      size: plan.size,
      written: written.get(batch.id) ?? 0,
      errorCode: batch.errorCode as ErrorCode | null,
      failedItems: batch.failedItems as BatchFailedItem[],
    };
  });
}

export async function batchViewById(ctx: Pick<AppContext, "db">, batchId: string): Promise<BatchView> {
  const [row] = await ctx.db
    .select({ sessionId: AuthoringBatch.sessionId })
    .from(AuthoringBatch)
    .where(eq(AuthoringBatch.id, batchId));
  if (!row) throw new AppError("authoring_batch_not_found");
  const view = (await batchViews(ctx, row.sessionId)).find((v) => v.id === batchId);
  if (!view) throw new AppError("authoring_batch_not_found");
  return view;
}

export async function sessionProgress(ctx: Pick<AppContext, "db">, session: SessionRow): Promise<SessionProgress> {
  const batches = await batchViews(ctx, session.id);
  const drafts = await ctx.db.select().from(DraftQuestion).where(eq(DraftQuestion.sessionId, session.id));
  const results = await latestResults(
    ctx.db,
    drafts.map((d) => d.id),
  );
  const pending = drafts.filter((d: DraftRow) => contentOf(d).l7Pending).length;
  return {
    status: session.status,
    batches,
    written: drafts.length,
    checked: drafts.filter((d: DraftRow) => !contentOf(d).l7Pending && (results.get(d.id)?.length ?? 0) > 0).length,
    pending,
  };
}

export async function startGenerateWorker(ctx: AppContext) {
  // A batch left `running` by a stopped API can't finish: it shows as failed, with a retry.
  await ctx.db
    .update(AuthoringBatch)
    .set({ status: "failed", errorCode: "service_unavailable", finishedAt: new Date() })
    .where(eq(AuthoringBatch.status, "running"));
  await ctx.queue?.workOne<{ batchId: string }>(GENERATE_QUEUE, async ({ batchId }) => {
    await processBatch(ctx, batchId);
  });
}
