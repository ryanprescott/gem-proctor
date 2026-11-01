import { checkConceptNotation, checkQuestion, computeQuestion, importedQuestion, type L7Deps } from "@gem/authoring";
import { AuthoringSession, DraftQuestion, Revision, SourceChunk } from "@gem/db";
import type { DraftContent, DraftL7, L7Reason, LayerResult, VerificationItem } from "@gem/shared";
import { eq, inArray } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { getSettings } from "../settings.ts";
import { dbRecorder } from "../verification.ts";
import { addEvent, chunkTexts, contentOf, recordResults } from "./drafts.ts";
import { L7_QUEUE, settleSession } from "./generate.ts";
import { revalidateLocal } from "./review.ts";

/** L7 on a draft question: the answer computed (flow A), checked (flow B), or the notation scan (SPEC §3A.3.1). */

/** `auto`: just generated. `rerun`: the creator asked again. `edited`: a hand edit, so flow B. */
export type L7Flow = "auto" | "rerun" | "edited";

type Used = { keys: string[]; source: string[] };

const layer = (outcome: LayerResult["outcome"], reason: L7Reason): LayerResult => ({
  layer: "L7",
  outcome,
  issues: [],
  reason,
});

async function usedValues(ctx: Pick<AppContext, "db">, sessionId: string): Promise<Used> {
  const [row] = await ctx.db.select().from(AuthoringSession).where(eq(AuthoringSession.id, sessionId));
  const used = (row?.usedValues ?? {}) as Partial<Used>;
  return { keys: used.keys ?? [], source: used.source ?? [] };
}

/** The chunks behind a denial are flagged for the creator to read: nothing is deleted (P2.md §5). */
async function flagChunks(ctx: Pick<AppContext, "db">, content: DraftContent) {
  const ids = content.evidence.map((e) => e.chunkId);
  if (ids.length === 0) return;
  await ctx.db
    .update(SourceChunk)
    .set({ flaggedAt: new Date(), flagReason: "sandbox_denial" })
    .where(inArray(SourceChunk.id, ids));
}

async function deps(ctx: AppContext, userId: string): Promise<L7Deps> {
  return {
    llm: ctx.llm,
    verify: ctx.verify,
    recorder: dbRecorder(ctx.db),
    settings: (await getSettings(ctx.db)).verify,
    userId,
  };
}

/** What a finished L7 leaves on the draft, and the event that records it. */
interface Outcome {
  content: DraftContent;
  result: LayerResult;
  computed: boolean;
}

function fromFlowB(content: DraftContent, item: VerificationItem): Outcome {
  const check: LayerResult["outcome"] =
    item.outcome === "verified"
      ? "pass"
      : item.outcome === "couldnt_check" || item.outcome === "not_computable"
        ? "warn"
        : "fail";
  const l7: DraftL7 = {
    flow: "b",
    outcome: item.outcome,
    reason: item.reason,
    author: null,
    blind: item.blind,
    suggestedFix: item.suggestedFix,
  };
  return {
    content: { ...content, verification: item.verification, l7, l7Pending: false },
    result: layer(check, item.reason),
    computed: item.outcome === "verified",
  };
}

async function runFlowA(ctx: AppContext, d: L7Deps, draft: typeof DraftQuestion.$inferSelect): Promise<Outcome> {
  const content = contentOf(draft);
  const [rev] = await ctx.db.select({ seed: Revision.seed }).from(Revision).where(eq(Revision.id, draft.revisionId));
  const texts = await chunkTexts(
    ctx,
    content.evidence.map((e) => e.chunkId),
  );
  const used = await usedValues(ctx, draft.sessionId);
  const flow = await computeQuestion(d, {
    question: {
      tempId: draft.tempId,
      type: content.type,
      question: content.template,
      inputs: content.inputs as never,
      constraint: content.constraint,
      answerProgram: content.answerProgram,
      mistakes: content.mistakes,
      evidence: content.evidence.map((e) => ({ chunkId: e.chunkId, quote: e.quote })),
    },
    chunks: content.evidence.flatMap((e) => texts.get(e.chunkId) ?? []),
    batchSeed: rev?.seed ?? draft.revisionId,
    used,
    ref: { questionId: draft.position, draftQuestionId: draft.id },
  });
  const l7: DraftL7 = {
    flow: "a",
    outcome: flow.outcome,
    reason: flow.reason,
    author: flow.author,
    blind: flow.blind,
    suggestedFix: null,
  };
  if (flow.outcome === "computed") {
    await ctx.db
      .update(AuthoringSession)
      .set({
        usedValues: {
          keys: [...used.keys, ...(flow.usedKey ? [flow.usedKey] : [])],
          source: [...used.source, ...flow.usedSource],
        },
      })
      .where(eq(AuthoringSession.id, draft.sessionId));
  }
  const computed = flow.outcome === "computed";
  return {
    content: {
      ...content,
      question: flow.rendered ?? content.question,
      options: computed ? flow.options : content.options,
      correctAnswer: computed ? flow.correctAnswer : content.correctAnswer,
      numericTolerance: computed ? flow.numericTolerance : content.numericTolerance,
      verification: flow.verification,
      l7,
      l7Pending: false,
    },
    result: layer(flow.check, flow.reason),
    computed,
  };
}

async function runNotation(d: L7Deps, content: DraftContent): Promise<Outcome> {
  const options = (content.options ?? []).map((o) => o.text);
  const notation = await checkConceptNotation(d, content.template, options);
  const l7: DraftL7 | null =
    notation.classified === null
      ? null
      : {
          flow: "notation",
          outcome: notation.outcome,
          reason: notation.reason,
          author: null,
          blind: null,
          suggestedFix: null,
        };
  return {
    content: {
      ...content,
      // A concept question has been classified, which is all the proctored gate asks of it (SPEC §3A.3.1).
      verification: { status: "unverified", answerSource: "stated", checkedAt: new Date().toISOString() },
      l7,
      l7Pending: false,
    },
    result: layer(notation.outcome === "pass" ? "pass" : "fail", notation.reason),
    computed: false,
  };
}

/** Runs L7 on a draft to the end. Never throws: a failure becomes a warn the creator can re-run. */
export async function processL7(ctx: AppContext, draftId: string, flow: L7Flow): Promise<void> {
  const [draft] = await ctx.db.select().from(DraftQuestion).where(eq(DraftQuestion.id, draftId));
  if (!draft) return;
  const [session] = await ctx.db.select().from(AuthoringSession).where(eq(AuthoringSession.id, draft.sessionId));
  if (!session) return;
  const content = contentOf(draft);
  let outcome: Outcome;
  try {
    const d = await deps(ctx, session.ownerId);
    if (content.computable && flow === "edited") {
      const q = importedQuestion(
        {
          id: draft.position,
          question: content.question ?? content.template,
          options: content.options?.map((o) => o.text),
          correctAnswer: content.correctAnswer,
          acceptedAnswers: content.acceptedAnswers,
          type: content.type,
          evidence: content.evidence,
        },
        draft.position,
      );
      outcome = fromFlowB(
        content,
        await checkQuestion(d, q, { questionId: draft.position, draftQuestionId: draft.id }, { knownComputable: true }),
      );
    } else if (content.computable) {
      outcome = await runFlowA(ctx, d, draft);
    } else {
      outcome = await runNotation(d, content);
    }
  } catch {
    outcome = {
      content: { ...content, l7Pending: false },
      result: layer("warn", "llm_failed"),
      computed: false,
    };
  }
  const denied = outcome.result.reason === "sandbox_denial";
  if (denied) await flagChunks(ctx, content);
  await ctx.db.transaction(async (tx) => {
    await tx.update(DraftQuestion).set({ content: outcome.content }).where(eq(DraftQuestion.id, draftId));
    await recordResults(tx, draftId, draft.revisionId, [outcome.result]);
    if (outcome.computed && content.computable && flow !== "edited") {
      await addEvent(tx, {
        draftQuestionId: draftId,
        kind: "answer_computed",
        revisionId: draft.revisionId,
        before: { correctAnswer: content.correctAnswer },
        after: { correctAnswer: outcome.content.correctAnswer, status: outcome.content.verification?.status },
      });
    }
  });
  await revalidateLocal(ctx, draftId);
  await settleSession(ctx, draft.sessionId);
}

export async function startL7Worker(ctx: AppContext) {
  // A draft left pending by a stopped API has no job any more: it's queued again.
  await ctx.queue?.workOne<{ draftId: string; flow: L7Flow }>(L7_QUEUE, async ({ draftId, flow }) => {
    await processL7(ctx, draftId, flow);
  });
}
