import { AuthoringSession, DraftQuestion, Revision } from "@gem/db";
import { AppError, type Blueprint } from "@gem/shared";
import {
  authoringBatchRetry,
  authoringBlueprint,
  authoringEvents,
  authoringGenerate,
  authoringGenerateCancel,
  authoringObjectivesPropose,
  authoringObjectivesPut,
  authoringPublish,
  authoringQuestionAcceptFix,
  authoringQuestionChooseProgram,
  authoringQuestionHistory,
  authoringQuestionPatch,
  authoringQuestionReclassify,
  authoringQuestionValidate,
  authoringQuestionVerify,
  authoringRevalidate,
  authoringRevise,
  authoringScope,
  authoringSessionsCreate,
  authoringSessionsDelete,
  authoringSessionsGet,
  authoringSessionsList,
  type SessionDetail,
  type SessionSummary,
} from "@gem/shared/contracts";
import { and, asc, count, desc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { currentDrafts, draftViews, loadDraft } from "../authoring/drafts.ts";
import {
  batchViewById,
  cancelGeneration,
  retryBatch,
  sessionProgress,
  startGeneration,
} from "../authoring/generate.ts";
import {
  acceptFix,
  chooseProgram,
  draftView,
  editDraft,
  publishSession,
  questionHistory,
  reclassify,
  rerunL7,
  revalidateLocal,
  revalidateSession,
  reviseSession,
  setStatus,
} from "../authoring/review.ts";
import {
  createSession,
  deleteSession,
  loadSession,
  objectiveViews,
  proposeObjectives,
  replaceObjectives,
  saveBlueprint,
  sessionSources,
  sessionTopic,
  updateScope,
} from "../authoring/sessions.ts";
import type { AppContext } from "../context.ts";
import { streamState } from "../events.ts";
import { route } from "../http/route.ts";
import { requestMeta } from "./auth.ts";
import { modelCallLimit } from "./llm.ts";

type SessionRow = typeof AuthoringSession.$inferSelect;

function toSummary(s: SessionRow, questionCount = 0): SessionSummary {
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    testType: s.testType,
    ownerId: s.ownerId,
    createdAt: s.createdAt.toISOString(),
    questionCount,
  };
}

async function detail(ctx: AppContext, id: string): Promise<SessionDetail> {
  const session = await loadSession(ctx, id);
  // Progress first: a job can finish between the two reads, and the questions must be no older than the counts, so
  // that "nothing pending" never arrives with questions that still say pending.
  const progress = await sessionProgress(ctx, session);
  const questions = await draftViews(ctx, await currentDrafts(ctx, id));
  const revisions = await ctx.db
    .select()
    .from(Revision)
    .where(eq(Revision.sessionId, id))
    .orderBy(asc(Revision.number));
  return {
    session: toSummary(session, questions.length),
    sources: await sessionSources(ctx, id),
    objectives: await objectiveViews(ctx, id),
    blueprint: (session.blueprint ?? null) as Blueprint | null,
    revisions: revisions.map((r) => ({
      id: r.id,
      number: r.number,
      trigger: r.trigger,
      createdAt: r.createdAt.toISOString(),
    })),
    progress,
    questions,
  };
}

export function authoringRoutes(app: FastifyInstance, ctx: AppContext) {
  route(app, authoringSessionsList, async ({ user }) => {
    // Their own, even for an admin: an admin reaches another's by its id.
    const rows = await ctx.db
      .select()
      .from(AuthoringSession)
      .where(and(eq(AuthoringSession.ownerId, user.userId), isNull(AuthoringSession.deletedAt)))
      .orderBy(desc(AuthoringSession.createdAt));
    const counts = await ctx.db
      .select({ id: DraftQuestion.sessionId, n: count() })
      .from(DraftQuestion)
      .groupBy(DraftQuestion.sessionId);
    const by = new Map(counts.map((c) => [c.id, c.n]));
    return { sessions: rows.map((r) => toSummary(r, by.get(r.id) ?? 0)) };
  });

  route(app, authoringSessionsCreate, async ({ body, user, request }) =>
    detail(ctx, await createSession(ctx, body, user.userId, requestMeta(request))),
  );

  route(app, authoringSessionsGet, async ({ params }) => detail(ctx, params.id));

  route(app, authoringSessionsDelete, async ({ params, user, request }) => {
    await deleteSession(ctx, await loadSession(ctx, params.id), user.userId, requestMeta(request));
    return { ok: true as const };
  });

  route(app, authoringScope, async ({ params, body }) => {
    await updateScope(ctx, await loadSession(ctx, params.id), body);
    return detail(ctx, params.id);
  });

  route(
    app,
    authoringObjectivesPropose,
    async ({ params, user }) => proposeObjectives(ctx, await loadSession(ctx, params.id), user.userId),
    modelCallLimit(ctx),
  );

  route(app, authoringObjectivesPut, async ({ params, body }) => ({
    objectives: await replaceObjectives(ctx, await loadSession(ctx, params.id), body.objectives),
  }));

  route(app, authoringBlueprint, async ({ params, body }) => {
    if (body.testType === undefined) throw new AppError("validation_failed", { field: "testType" });
    return { blueprint: await saveBlueprint(ctx, await loadSession(ctx, params.id), body) };
  });
  route(
    app,
    authoringGenerate,
    async ({ params }) => {
      await startGeneration(ctx, await loadSession(ctx, params.id));
      return detail(ctx, params.id);
    },
    modelCallLimit(ctx),
  );

  route(app, authoringGenerateCancel, async ({ params }) => {
    await cancelGeneration(ctx, (await loadSession(ctx, params.id)).id);
    return detail(ctx, params.id);
  });

  route(
    app,
    authoringBatchRetry,
    async ({ params }) => {
      await retryBatch(ctx, params.id);
      return { batch: await batchViewById(ctx, params.id) };
    },
    modelCallLimit(ctx),
  );

  route(app, authoringEvents, async ({ params, query, request, reply }) => {
    await loadSession(ctx, params.id);
    return streamState(
      ctx.events,
      sessionTopic(params.id),
      request,
      reply,
      async () => sessionProgress(ctx, await loadSession(ctx, params.id)),
      query.once === "true",
    );
  });

  route(
    app,
    authoringRevise,
    async ({ params, body }) => {
      await reviseSession(ctx, await loadSession(ctx, params.id), body.questions);
      return detail(ctx, params.id);
    },
    modelCallLimit(ctx),
  );

  route(app, authoringRevalidate, async ({ params }) => {
    await revalidateSession(ctx, await loadSession(ctx, params.id));
    return detail(ctx, params.id);
  });

  route(app, authoringPublish, async ({ params, body, user, request }) =>
    publishSession(ctx, await loadSession(ctx, params.id), body, user.userId, requestMeta(request)),
  );

  route(
    app,
    authoringQuestionPatch,
    async ({ params, body, user }) => {
      const draft = await loadDraft(ctx, params.id);
      const row = body.edit
        ? await editDraft(ctx, draft, body.edit, user.userId)
        : await setStatus(ctx, draft, body.status as NonNullable<typeof body.status>, user.userId, body.note);
      return { question: await draftView(ctx, row) };
    },
    modelCallLimit(ctx),
  );

  route(app, authoringQuestionValidate, async ({ params }) => {
    const draft = await loadDraft(ctx, params.id);
    await revalidateLocal(ctx, draft.id);
    return { question: await draftView(ctx, await loadDraft(ctx, params.id)) };
  });

  route(
    app,
    authoringQuestionVerify,
    async ({ params }) => ({ question: await draftView(ctx, await rerunL7(ctx, await loadDraft(ctx, params.id))) }),
    modelCallLimit(ctx),
  );

  route(
    app,
    authoringQuestionAcceptFix,
    async ({ params, body, user }) => {
      if (!body.confirm) throw new AppError("validation_failed", { field: "confirm" });
      const row = await acceptFix(ctx, await loadDraft(ctx, params.id), user.userId, body.note);
      return { question: await draftView(ctx, row) };
    },
    modelCallLimit(ctx),
  );

  route(app, authoringQuestionChooseProgram, async ({ params, body, user }) => {
    const row = await chooseProgram(ctx, await loadDraft(ctx, params.id), body.which, user.userId, body.note);
    return { question: await draftView(ctx, row) };
  });

  route(app, authoringQuestionReclassify, async ({ params, body, user }) => {
    const row = await reclassify(ctx, await loadDraft(ctx, params.id), user.userId, body.note);
    return { question: await draftView(ctx, row) };
  });

  route(app, authoringQuestionHistory, async ({ params }) => questionHistory(ctx, await loadDraft(ctx, params.id)));
}
