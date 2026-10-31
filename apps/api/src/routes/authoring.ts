import { AuthoringSession } from "@gem/db";
import { AppError, type Blueprint } from "@gem/shared";
import {
  authoringBlueprint,
  authoringObjectivesPropose,
  authoringObjectivesPut,
  authoringScope,
  authoringSessionsCreate,
  authoringSessionsDelete,
  authoringSessionsGet,
  authoringSessionsList,
  type SessionDetail,
  type SessionSummary,
} from "@gem/shared/contracts";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  createSession,
  deleteSession,
  loadSession,
  objectiveViews,
  proposeObjectives,
  replaceObjectives,
  saveBlueprint,
  sessionSources,
  updateScope,
} from "../authoring/sessions.ts";
import type { AppContext } from "../context.ts";
import { route } from "../http/route.ts";
import { requestMeta } from "./auth.ts";
import { modelCallLimit } from "./llm.ts";

type SessionRow = typeof AuthoringSession.$inferSelect;

function toSummary(s: SessionRow): SessionSummary {
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    testType: s.testType,
    ownerId: s.ownerId,
    createdAt: s.createdAt.toISOString(),
    questionCount: 0,
  };
}

async function detail(ctx: AppContext, id: string): Promise<SessionDetail> {
  const session = await loadSession(ctx, id);
  return {
    session: toSummary(session),
    sources: await sessionSources(ctx, id),
    objectives: await objectiveViews(ctx, id),
    blueprint: (session.blueprint ?? null) as Blueprint | null,
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
    return { sessions: rows.map(toSummary) };
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
}
