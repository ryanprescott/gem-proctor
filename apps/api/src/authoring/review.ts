import { checkAfterL7, checkGrounding, checkProctorReady, toQuiz } from "@gem/authoring";
import {
  AuthoringSession,
  DraftQuestion,
  newId,
  QuestionEvent,
  Revision,
  Source,
  SourceChunk,
  SourceRevision,
  Test,
  TestVersion,
  User,
} from "@gem/db";
import {
  AppError,
  type DraftContent,
  type DraftStatus,
  type LayerResult,
  layerResult,
  Quiz,
  type VerifyValue,
} from "@gem/shared";
import type { DraftView, QuestionEdit, QuestionHistoryEvent } from "@gem/shared/contracts";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { writeAudit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { getSettings } from "../settings.ts";
import {
  addEvent,
  chunkTexts,
  contentOf,
  currentDrafts,
  type DraftRow,
  draftViews,
  formResult,
  isBlocked,
  latestResults,
  loadDraft,
  longestIds,
  recordResults,
} from "./drafts.ts";
import { createRevision, L7_QUEUE, localChecks, queueBatches, type StoredPlan } from "./generate.ts";
import { objectiveViews, sessionSources } from "./sessions.ts";

/** Review, revise, re-validate and publish (SPEC §3A.1 steps 6–8, §3A.4, §3C.5; P2.md §5). */

type SessionRow = typeof AuthoringSession.$inferSelect;

export async function draftView(ctx: Pick<AppContext, "db">, row: DraftRow): Promise<DraftView> {
  const [view] = await draftViews(ctx, [row]);
  return view as DraftView;
}

const sameResult = (a: LayerResult | undefined, b: LayerResult) =>
  a !== undefined && a.outcome === b.outcome && JSON.stringify(a.issues) === JSON.stringify(b.issues);

/**
 * L1–L3 again, on what the question says now. The newest row per layer is the current one, so only a layer that
 * changed gets a new row. L1's last rule is merged in once the answer exists (SPEC §3A.3).
 */
export async function revalidateLocal(ctx: AppContext, draftId: string) {
  const draft = await loadDraft(ctx, draftId);
  const content = contentOf(draft);
  const objectives = await objectiveViews(ctx, draft.sessionId);
  const texts = await chunkTexts(
    ctx,
    content.evidence.map((e) => e.chunkId),
  );
  const { groundingThreshold } = (await getSettings(ctx.db)).authoring;
  const [l1, l2] = localChecks(
    content,
    texts,
    { objectiveIds: new Set(objectives.map((o) => o.id)), chunkIds: new Set(texts.keys()) },
    groundingThreshold,
  );
  const after =
    content.correctAnswer !== null && !content.l7Pending
      ? checkAfterL7({ type: content.type, options: content.options, correctAnswer: content.correctAnswer })
      : null;
  const structure = after && l1 ? layerResult("L1", [...l1.issues, ...after.issues]) : (l1 as LayerResult);
  const rows = await currentDrafts(ctx, draft.sessionId);
  const passages = [
    ...content.evidence.map((e) => e.quote),
    ...content.evidence.flatMap((e) => texts.get(e.chunkId) ?? []),
  ];
  const form = formResult(content, passages, longestIds(rows).has(draft.id));
  const have = (await latestResults(ctx.db, [draftId])).get(draftId) ?? [];
  const changed = [structure, l2 as LayerResult, form].filter(
    (r) =>
      !sameResult(
        have.find((h) => h.layer === r.layer),
        r,
      ),
  );
  if (changed.length > 0) await recordResults(ctx.db, draftId, draft.revisionId, changed);
  // A question that joins or leaves the longest-option set changes its siblings' L3.
  for (const sibling of rows) {
    if (sibling.id === draftId) continue;
    const c = contentOf(sibling);
    const t = await chunkTexts(
      ctx,
      c.evidence.map((e) => e.chunkId),
    );
    const p = [...c.evidence.map((e) => e.quote), ...c.evidence.flatMap((e) => t.get(e.chunkId) ?? [])];
    const l3 = formResult(c, p, longestIds(rows).has(sibling.id));
    const sibHave = (await latestResults(ctx.db, [sibling.id])).get(sibling.id) ?? [];
    if (
      !sameResult(
        sibHave.find((h) => h.layer === "L3"),
        l3,
      )
    ) {
      await recordResults(ctx.db, sibling.id, sibling.revisionId, [l3]);
    }
  }
  ctx.events.publish(`authoring:${draft.sessionId}`);
}

function ensureOpen(draft: DraftRow) {
  if (draft.status === "locked") throw new AppError("authoring_question_locked");
}

const setDraft = (ctx: Pick<AppContext, "db">, id: string, values: Partial<typeof DraftQuestion.$inferInsert>) =>
  ctx.db.update(DraftQuestion).set(values).where(eq(DraftQuestion.id, id));

async function queueL7(ctx: AppContext, draftId: string, flow: "rerun" | "edited") {
  if (!ctx.queue) throw new AppError("service_unavailable");
  await ctx.queue.send(L7_QUEUE, { draftId, flow });
}

/** Accept, reject, lock or reopen (P2.md §5: a blocked question can't be accepted). */
export async function setStatus(
  ctx: AppContext,
  draft: DraftRow,
  status: DraftStatus,
  userId: string,
  note: string | undefined,
): Promise<DraftRow> {
  if (draft.status === status) return draft;
  if (status === "accepted" || status === "locked") {
    const view = await draftView(ctx, draft);
    if (view.blocked) throw new AppError("authoring_question_blocked");
  }
  await ctx.db.transaction(async (tx) => {
    await tx.update(DraftQuestion).set({ status }).where(eq(DraftQuestion.id, draft.id));
    // `proposed` is a reopen: it has no event kind of its own, so it's an edit with a note, not a silent change.
    await addEvent(tx, {
      draftQuestionId: draft.id,
      kind: status === "proposed" ? "edited" : status,
      actorId: userId,
      revisionId: draft.revisionId,
      before: { status: draft.status },
      after: { status },
      note: note ?? null,
    });
  });
  ctx.events.publish(`authoring:${draft.sessionId}`);
  return loadDraft(ctx, draft.id);
}

const ANSWER_FIELDS = [
  "question",
  "options",
  "correctAnswer",
  "correctAnswers",
  "acceptedAnswers",
  "numericTolerance",
] as const;

function applyEdit(content: DraftContent, edit: QuestionEdit): DraftContent {
  const next: DraftContent = { ...content };
  if (edit.topic !== undefined) next.topic = edit.topic;
  if (edit.explanation !== undefined) next.explanation = edit.explanation;
  if (edit.question !== undefined) {
    next.question = edit.question;
    if (!content.computable) next.template = edit.question;
  }
  if (edit.options !== undefined) {
    const was = new Map((content.options ?? []).map((o) => [o.text, o.whyWrong]));
    next.options = edit.options.map((o) => {
      const whyWrong = was.get(o.text);
      return { text: o.text, isCorrect: o.isCorrect, ...(whyWrong ? { whyWrong } : {}) };
    });
    if (edit.correctAnswer === undefined && content.type !== "multi_choice") {
      next.correctAnswer = next.options.find((o) => o.isCorrect)?.text ?? null;
    }
    if (content.type === "multi_choice") {
      next.correctAnswers = next.options.filter((o) => o.isCorrect).map((o) => o.text);
      next.correctAnswer = next.correctAnswers[0] ?? null;
    }
  }
  if (edit.correctAnswer !== undefined) {
    next.correctAnswer = edit.correctAnswer;
    if (next.options && edit.options === undefined && content.type !== "multi_choice") {
      next.options = next.options.map((o) => ({ ...o, isCorrect: o.text === edit.correctAnswer }));
    }
  }
  if (edit.correctAnswers !== undefined) {
    next.correctAnswers = edit.correctAnswers;
    next.correctAnswer = edit.correctAnswers[0] ?? null;
    if (next.options)
      next.options = next.options.map((o) => ({ ...o, isCorrect: edit.correctAnswers?.includes(o.text) ?? false }));
  }
  if (edit.acceptedAnswers !== undefined) next.acceptedAnswers = edit.acceptedAnswers;
  if (edit.numericTolerance !== undefined) next.numericTolerance = edit.numericTolerance;
  return next;
}

const notationIn = (c: DraftContent) =>
  /\$|\\[a-zA-Z]+|[[(]\s*[-−]?\d+(?:\.\d+)?\s*(?:,\s*[-−]?\d+(?:\.\d+)?\s*)+[\])]|\d\s*[-−+*/=^×·]\s*[-−]?\d|\b[a-zA-Z]_\{?\w|\b[a-zA-Z]\^\{?\w/.test(
    [c.template, c.question ?? "", ...(c.options ?? []).map((o) => o.text)].join(" "),
  );

/** An inline edit: re-validated at once, and a computable one goes back through flow B (P2.md §5). */
export async function editDraft(ctx: AppContext, draft: DraftRow, edit: QuestionEdit, userId: string) {
  ensureOpen(draft);
  const content = contentOf(draft);
  const touched = Object.keys(edit).filter((k) => (edit as Record<string, unknown>)[k] !== undefined);
  const next = applyEdit(content, edit);
  next.provenance =
    content.provenance === "human" || (content.correctAnswer === null && edit.correctAnswer !== undefined)
      ? "human"
      : "llm_edited";
  const answerTouched = touched.some((k) => (ANSWER_FIELDS as readonly string[]).includes(k));
  // What a check said about the old text says nothing about the new.
  const recheck = answerTouched && (content.computable || notationIn(next));
  if (answerTouched) {
    next.verification = content.computable
      ? null
      : { status: "unverified", answerSource: "stated", checkedAt: ctx.now().toISOString() };
    next.l7 = null;
  }
  next.l7Pending = recheck;
  if (recheck && !ctx.queue) throw new AppError("service_unavailable");
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const k of touched) {
    before[k] = (content as Record<string, unknown>)[k];
    after[k] = (next as Record<string, unknown>)[k];
  }
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(DraftQuestion)
      .set({
        content: next,
        status: draft.status === "accepted" ? "proposed" : draft.status,
        editedBy: userId,
        editedAt: ctx.now(),
      })
      .where(eq(DraftQuestion.id, draft.id));
    await addEvent(tx, {
      draftQuestionId: draft.id,
      kind: "edited",
      actorId: userId,
      revisionId: draft.revisionId,
      before,
      after,
    });
    if (answerTouched && !recheck) {
      await recordResults(tx, draft.id, draft.revisionId, [{ layer: "L7", outcome: "pass", issues: [], reason: "ok" }]);
    }
  });
  await revalidateLocal(ctx, draft.id);
  if (recheck) await queueL7(ctx, draft.id, "edited");
  ctx.events.publish(`authoring:${draft.sessionId}`);
  return loadDraft(ctx, draft.id);
}

/** Re-run L7. A question the creator has edited is checked, not computed again (SPEC §3A.3.1). */
export async function rerunL7(ctx: AppContext, draft: DraftRow) {
  ensureOpen(draft);
  const content = contentOf(draft);
  await setDraft(ctx, draft.id, { content: { ...content, l7Pending: true } });
  await queueL7(ctx, draft.id, content.provenance === "llm" ? "rerun" : "edited");
  ctx.events.publish(`authoring:${draft.sessionId}`);
  return loadDraft(ctx, draft.id);
}

/** Flow B's suggestion, applied only when the creator confirms it; then it's checked again. */
export async function acceptFix(ctx: AppContext, draft: DraftRow, userId: string, note: string | undefined) {
  ensureOpen(draft);
  const content = contentOf(draft);
  const fix = content.l7?.suggestedFix;
  if (!fix || content.l7?.flow !== "b") throw new AppError("authoring_fix_unavailable");
  const next: DraftContent = {
    ...content,
    correctAnswer: fix,
    options: content.options ? content.options.map((o) => ({ ...o, isCorrect: o.text === fix })) : content.options,
    provenance: content.provenance === "human" ? "human" : "llm_edited",
    verification: null,
    l7: null,
    l7Pending: true,
  };
  if (!ctx.queue) throw new AppError("service_unavailable");
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(DraftQuestion)
      .set({ content: next, editedBy: userId, editedAt: ctx.now() })
      .where(eq(DraftQuestion.id, draft.id));
    await addEvent(tx, {
      draftQuestionId: draft.id,
      kind: "fix_accepted",
      actorId: userId,
      revisionId: draft.revisionId,
      before: { correctAnswer: content.correctAnswer },
      after: { correctAnswer: fix },
      note: note ?? null,
    });
  });
  await revalidateLocal(ctx, draft.id);
  await queueL7(ctx, draft.id, "edited");
  return loadDraft(ctx, draft.id);
}

/** The answer from one chosen value: no common errors, since those came from the author's own mistake programs. */
async function answerFrom(ctx: AppContext, content: DraftContent, value: VerifyValue, seed: string) {
  const settings = (await getSettings(ctx.db)).verify;
  if (content.type === "true_false") {
    return {
      options: [
        { text: "True", isCorrect: value.text === "True" },
        { text: "False", isCorrect: value.text === "False" },
      ],
      correctAnswer: value.text,
      numericTolerance: null as number | null,
    };
  }
  if (content.type === "numeric") {
    return {
      options: null,
      correctAnswer: value.decimal ?? value.text,
      numericTolerance: value.decimalExact ? 0 : settings.numericTolerance,
    };
  }
  if (content.type === "short_answer") return { options: null, correctAnswer: value.text, numericTolerance: null };
  const built = await ctx.verify.buildOptions({
    answer: value,
    mistakes: [],
    seed,
    distractorCount: settings.distractorCount,
  });
  if (built.status !== "ok" || !built.options || built.correctAnswer === undefined) {
    throw new AppError("authoring_fix_unavailable");
  }
  return { options: built.options, correctAnswer: built.correctAnswer, numericTolerance: null as number | null };
}

/** The programs disagreed: the creator says which one is right, and that's recorded (SPEC §3A.3.1). */
export async function chooseProgram(
  ctx: AppContext,
  draft: DraftRow,
  which: "author" | "blind",
  userId: string,
  note: string | undefined,
) {
  ensureOpen(draft);
  const content = contentOf(draft);
  const l7 = content.l7;
  const chosen = which === "author" ? l7?.author?.result : l7?.blind?.result;
  if (!l7 || l7.flow !== "a" || l7.outcome !== "disagree" || !chosen) {
    throw new AppError("authoring_fix_unavailable");
  }
  const [revision] = await ctx.db.select().from(Revision).where(eq(Revision.id, draft.revisionId));
  const built = await answerFrom(ctx, content, chosen, `${revision?.seed ?? ""}:${draft.tempId}:${which}`);
  const next: DraftContent = {
    ...content,
    options: built.options,
    correctAnswer: built.correctAnswer,
    numericTolerance: built.numericTolerance,
    provenance: "human",
    l7: { ...l7, outcome: "chosen" },
    // The programs didn't agree, so this is a person's decision, not a computation: it doesn't open a proctored test.
    verification: {
      ...(content.verification ?? { status: "unverified" }),
      status: "unverified",
      answerSource: "stated",
    },
  };
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(DraftQuestion)
      .set({ content: next, editedBy: userId, editedAt: ctx.now() })
      .where(eq(DraftQuestion.id, draft.id));
    await addEvent(tx, {
      draftQuestionId: draft.id,
      kind: "fix_accepted",
      actorId: userId,
      revisionId: draft.revisionId,
      before: { correctAnswer: content.correctAnswer, programs: "disagree" },
      after: { correctAnswer: built.correctAnswer, chose: which },
      note: note ?? null,
    });
    await recordResults(tx, draft.id, draft.revisionId, [
      { layer: "L7", outcome: "warn", issues: [], reason: "programs_disagree" },
    ]);
  });
  await revalidateLocal(ctx, draft.id);
  return loadDraft(ctx, draft.id);
}

/** The one way past flow B for an edited computable question: it isn't computable, and a note says why. */
export async function reclassify(ctx: AppContext, draft: DraftRow, userId: string, note: string) {
  ensureOpen(draft);
  const content = contentOf(draft);
  if (!content.computable) throw new AppError("authoring_fix_unavailable");
  const next: DraftContent = {
    ...content,
    computable: false,
    template: content.question ?? content.template,
    inputs: [],
    answerProgram: "",
    constraint: "",
    mistakes: [],
    provenance: "human",
    verification: { status: "unverified", answerSource: "stated", checkedAt: ctx.now().toISOString() },
    l7: null,
    l7Pending: false,
  };
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(DraftQuestion)
      .set({ content: next, editedBy: userId, editedAt: ctx.now() })
      .where(eq(DraftQuestion.id, draft.id));
    await addEvent(tx, {
      draftQuestionId: draft.id,
      kind: "reclassified",
      actorId: userId,
      revisionId: draft.revisionId,
      before: { computable: true },
      after: { computable: false },
      note,
    });
    await recordResults(tx, draft.id, draft.revisionId, [
      { layer: "L7", outcome: "warn", issues: [], reason: "not_computable" },
    ]);
  });
  await revalidateLocal(ctx, draft.id);
  return loadDraft(ctx, draft.id);
}

export async function questionHistory(ctx: Pick<AppContext, "db">, draft: DraftRow) {
  const all = await ctx.db
    .select()
    .from(DraftQuestion)
    .where(eq(DraftQuestion.sessionId, draft.sessionId))
    .orderBy(asc(DraftQuestion.position));
  const byId = new Map(all.map((d) => [d.id, d]));
  const chain: DraftRow[] = [];
  // Back to the first version, then forward to the newest.
  let cursor: DraftRow | undefined = draft;
  while (cursor?.supersedesId) cursor = byId.get(cursor.supersedesId);
  while (cursor) {
    chain.push(cursor);
    const at: string = cursor.id;
    cursor = all.find((d) => d.supersedesId === at);
  }
  const revisions = await ctx.db
    .select({ id: Revision.id, number: Revision.number })
    .from(Revision)
    .where(eq(Revision.sessionId, draft.sessionId));
  const numbers = new Map(revisions.map((r) => [r.id, r.number]));
  const events = await ctx.db
    .select({ event: QuestionEvent, actorName: User.displayName })
    .from(QuestionEvent)
    .leftJoin(User, eq(User.id, QuestionEvent.actorId))
    .where(
      inArray(
        QuestionEvent.draftQuestionId,
        chain.map((c) => c.id),
      ),
    )
    .orderBy(asc(QuestionEvent.at), asc(QuestionEvent.id));
  return {
    versions: chain.map((c) => ({
      id: c.id,
      revision: numbers.get(c.revisionId) ?? 0,
      tempId: c.tempId,
      supersedesId: c.supersedesId,
    })),
    events: events.map(
      ({ event: e, actorName }): QuestionHistoryEvent => ({
        id: e.id,
        draftQuestionId: e.draftQuestionId,
        kind: e.kind,
        actorId: e.actorId,
        actorName,
        at: e.at.toISOString(),
        note: e.note,
        before: e.before,
        after: e.after,
      }),
    ),
  };
}

/**
 * Only the named questions go back to the model. Accepted and locked ones go as context and stay as they are
 * (SPEC §3A.1 step 7); the new questions replace the old, which stay in the history.
 */
export async function reviseSession(
  ctx: AppContext,
  session: SessionRow,
  items: { id: string; note?: string | undefined }[],
) {
  if (session.status !== "review") throw new AppError("authoring_not_in_review");
  const current = await currentDrafts(ctx, session.id);
  const byId = new Map(current.map((d) => [d.id, d]));
  const named = items.map((i) => {
    const draft = byId.get(i.id);
    if (!draft) throw new AppError("authoring_question_not_found");
    ensureOpen(draft);
    return { draft, note: i.note?.trim() || null };
  });
  const target = await ctx.llm.resolve("authoring.generate");
  await ctx.llm.resolve("embeddings");
  const results = await latestResults(
    ctx.db,
    named.map((n) => n.draft.id),
  );
  const objectives = await objectiveViews(ctx, session.id);
  const known = new Set(objectives.map((o) => o.id));
  const ids = new Set(named.map((n) => n.draft.id));
  const locked = current
    .filter((d) => !ids.has(d.id) && (d.status === "accepted" || d.status === "locked"))
    .map((d) => ({ question: contentOf(d).question ?? contentOf(d).template }));
  const plans: StoredPlan[] = named.map(({ draft, note }) => {
    const content = contentOf(draft);
    const failures = (results.get(draft.id) ?? []).flatMap((r) =>
      r.outcome === "fail"
        ? [...r.issues.map((i) => `${r.layer} ${i.code}`), ...(r.reason ? [`${r.layer} ${r.reason}`] : [])]
        : [],
    );
    const objectiveIds = content.objectiveIds.filter((o) => known.has(o));
    return {
      objectiveIds: objectiveIds.length > 0 ? objectiveIds : [objectives[0]?.id as string],
      counts: { [content.type]: 1 },
      size: 1,
      replaces: { draftId: draft.id, note, failures, question: content.question ?? content.template },
      locked,
    };
  });
  const revision = await createRevision(ctx, session.id, "revise", { questions: items });
  await ctx.db.update(AuthoringSession).set({ model: target.model }).where(eq(AuthoringSession.id, session.id));
  await queueBatches(ctx, session, revision.id, plans);
}

/**
 * A source changed: L2 again, against its newest revision (SPEC §3C.5). A quote is looked for in the chunk with the
 * same key, and failing that anywhere in the new revision. Published evidence is never touched by this.
 */
export async function revalidateSession(ctx: AppContext, session: SessionRow) {
  const drafts = await currentDrafts(ctx, session.id);
  const { groundingThreshold } = (await getSettings(ctx.db)).authoring;
  for (const draft of drafts) {
    const content = contentOf(draft);
    const olds = await ctx.db
      .select({ id: SourceChunk.id, key: SourceChunk.chunkKey, sourceId: SourceRevision.sourceId })
      .from(SourceChunk)
      .innerJoin(SourceRevision, eq(SourceRevision.id, SourceChunk.revisionId))
      .where(inArray(SourceChunk.id, content.evidence.length > 0 ? content.evidence.map((e) => e.chunkId) : [newId()]));
    const texts = new Map<string, string>();
    for (const old of olds) {
      const [latest] = await ctx.db
        .select()
        .from(SourceRevision)
        .where(and(eq(SourceRevision.sourceId, old.sourceId), eq(SourceRevision.embedStatus, "ready")))
        .orderBy(desc(SourceRevision.number))
        .limit(1);
      if (!latest) continue;
      const chunks = await ctx.db
        .select({ key: SourceChunk.chunkKey, text: SourceChunk.text })
        .from(SourceChunk)
        .where(eq(SourceChunk.revisionId, latest.id))
        .orderBy(asc(SourceChunk.chunkKey));
      const same = chunks.find((c) => c.key === old.key);
      texts.set(
        old.id,
        same ? `${same.text}\n\n${chunks.map((c) => c.text).join("\n\n")}` : chunks.map((c) => c.text).join("\n\n"),
      );
    }
    const l2 = checkGrounding(
      content.evidence.map((e) => ({ chunkId: e.chunkId, quote: e.quote })),
      texts,
      groundingThreshold,
    );
    const have = (await latestResults(ctx.db, [draft.id])).get(draft.id) ?? [];
    if (
      !sameResult(
        have.find((h) => h.layer === "L2"),
        l2,
      )
    ) {
      await recordResults(ctx.db, draft.id, draft.revisionId, [l2]);
    }
  }
  ctx.events.publish(`authoring:${session.id}`);
}

export interface PublishInput {
  title?: string | undefined;
  description?: string | undefined;
}

/** Accepted questions → mapper → `Quiz` → an immutable `TestVersion` with the trail frozen into it (SPEC §3A.1). */
export async function publishSession(
  ctx: AppContext,
  session: SessionRow,
  input: PublishInput,
  userId: string,
  meta: object,
) {
  if (session.status !== "review") throw new AppError("authoring_not_in_review");
  const current = await currentDrafts(ctx, session.id);
  const chosen = current.filter((d) => d.status === "accepted" || d.status === "locked");
  if (chosen.length === 0) throw new AppError("authoring_nothing_accepted");
  const views = await draftViews(ctx, chosen);
  const blocked = views.find((v) => v.blocked);
  if (blocked) throw new AppError("authoring_question_blocked", { questionId: blocked.id });

  const objectives = await objectiveViews(ctx, session.id);
  const used = new Set(chosen.flatMap((d) => contentOf(d).objectiveIds));
  const title = input.title?.trim() || session.title;
  const quiz = toQuiz(
    chosen.map((d) => ({ content: contentOf(d), tempId: d.tempId })),
    {
      title,
      testType: session.testType,
      objectiveLabels: objectives.filter((o) => used.has(o.id)).map((o) => o.label),
    },
  );
  const parsed = Quiz.safeParse({ ...quiz, ...(input.description ? { description: input.description } : {}) });
  if (!parsed.success) throw new AppError("import_invalid_quiz", { errors: parsed.error.issues.length });

  const chain = new Map<string, DraftRow[]>();
  const all = await ctx.db.select().from(DraftQuestion).where(eq(DraftQuestion.sessionId, session.id));
  const byId = new Map(all.map((d) => [d.id, d]));
  for (const d of chosen) {
    const versions: DraftRow[] = [];
    let cursor: DraftRow | undefined = d;
    while (cursor) {
      versions.unshift(cursor);
      cursor = cursor.supersedesId ? byId.get(cursor.supersedesId) : undefined;
    }
    chain.set(d.id, versions);
  }
  const everyId = [...new Set([...chain.values()].flatMap((v) => v.map((d) => d.id)))];
  const events = await ctx.db
    .select()
    .from(QuestionEvent)
    .where(inArray(QuestionEvent.draftQuestionId, everyId.length > 0 ? everyId : [newId()]))
    .orderBy(asc(QuestionEvent.at), asc(QuestionEvent.id));
  const results = await latestResults(ctx.db, everyId);
  const revisions = await ctx.db
    .select()
    .from(Revision)
    .where(eq(Revision.sessionId, session.id))
    .orderBy(asc(Revision.number));
  const revisionNumber = new Map(revisions.map((r) => [r.id, r.number]));
  const sources = await sessionSources(ctx, session.id);
  const chunkIds = [...new Set(chosen.flatMap((d) => contentOf(d).evidence.map((e) => e.chunkId)))];
  const chunkRows = await ctx.db
    .select({
      id: SourceChunk.id,
      key: SourceChunk.chunkKey,
      revisionId: SourceChunk.revisionId,
      number: SourceRevision.number,
      sourceId: SourceRevision.sourceId,
      title: Source.title,
    })
    .from(SourceChunk)
    .innerJoin(SourceRevision, eq(SourceRevision.id, SourceChunk.revisionId))
    .innerJoin(Source, eq(Source.id, SourceRevision.sourceId))
    .where(inArray(SourceChunk.id, chunkIds.length > 0 ? chunkIds : [newId()]));
  const chunkInfo = new Map(chunkRows.map((c) => [c.id, c]));
  const publishedAt = ctx.now();
  const provenance = {
    format: 1,
    sessionId: session.id,
    sessionTitle: session.title,
    publishedAt: publishedAt.toISOString(),
    publishedBy: userId,
    testType: session.testType,
    rounds: revisions.length,
    revisions: revisions.map((r) => ({
      number: r.number,
      trigger: r.trigger,
      seed: r.seed,
      createdAt: r.createdAt.toISOString(),
    })),
    models: [...new Set(everyId.map((id) => contentOf(byId.get(id) as DraftRow).model).filter(Boolean))],
    blueprint: session.blueprint,
    sources: sources.map((s) => ({
      sourceId: s.sourceId,
      title: s.title,
      revisionId: s.revisionId,
      revisionNumber: s.revisionNumber,
      sectionIds: s.sectionIds,
    })),
    objectives: objectives.map((o) => ({ id: o.id, label: o.label, description: o.description, origin: o.origin })),
    questions: chosen.map((d, i) => {
      const content = contentOf(d);
      const versions = chain.get(d.id) ?? [d];
      return {
        questionId: i + 1,
        draftId: d.id,
        tempId: d.tempId,
        revision: revisionNumber.get(d.revisionId) ?? 0,
        provenance: content.provenance,
        objectiveIds: content.objectiveIds,
        evidence: content.evidence.map((e) => {
          const info = chunkInfo.get(e.chunkId);
          return {
            ...e,
            sourceRevisionId: info?.revisionId ?? null,
            sourceRevisionNumber: info?.number ?? null,
            sourceTitle: info?.title ?? null,
          };
        }),
        call: { callLogId: content.callLogId, promptVersion: content.promptVersion, model: content.model },
        verification: content.verification,
        l7: content.l7,
        validations: results.get(d.id) ?? [],
        history: versions.map((v) => v.id),
        events: events
          .filter((e) => versions.some((v) => v.id === e.draftQuestionId))
          .map((e) => ({
            draftQuestionId: e.draftQuestionId,
            kind: e.kind,
            actorId: e.actorId,
            at: e.at.toISOString(),
            note: e.note,
            before: e.before,
            after: e.after,
          })),
      };
    }),
  };
  const testId = newId();
  const versionId = newId();
  await ctx.db.transaction(async (tx) => {
    await tx.insert(Test).values({
      id: testId,
      ownerId: session.ownerId,
      title,
      description: input.description ?? null,
      tags: [],
      authoringSessionId: session.id,
    });
    await tx.insert(TestVersion).values({
      id: versionId,
      testId,
      versionNumber: 1,
      content: parsed.data,
      provenance,
      publishedAt,
    });
    await tx.update(AuthoringSession).set({ status: "published" }).where(eq(AuthoringSession.id, session.id));
    await writeAudit(tx, {
      actorId: userId,
      action: "authoring_session.publish",
      targetType: "authoring_session",
      targetId: session.id,
      after: { testId, versionId, questions: chosen.length },
      ...meta,
    });
  });
  const { verify } = await getSettings(ctx.db);
  ctx.events.publish(`authoring:${session.id}`);
  return { testId, versionId, proctorReady: checkProctorReady(parsed.data, verify.proctoredGate).proctorReady };
}
