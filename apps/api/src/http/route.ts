import { permissionFor, type RoutePermission } from "@gem/authz";
import {
  AuthoringBatch,
  AuthoringSession,
  DraftQuestion,
  PracticeAttempt,
  Source,
  Test,
  VerificationJob,
} from "@gem/db";
import { AppError, type ErrorCode } from "@gem/shared";
import type { Contract, Role } from "@gem/shared/contracts";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import type { z } from "zod";
import type { SessionUser } from "../auth/sessions.ts";
import type { AppContext } from "../context.ts";

export const API_PREFIX = "/api/v1";

export interface CurrentUser extends SessionUser {
  role: Role;
}

declare module "fastify" {
  interface FastifyContextConfig {
    /** Every route declares one (SPEC §5.2); routes without it fail the startup check. */
    permission?: RoutePermission;
    contractId?: string;
  }
  interface FastifyRequest {
    user: CurrentUser | null;
  }
}

type Out<T> = T extends z.ZodType ? z.output<T> : never;

export interface HandlerArgs<C extends Contract> {
  params: Out<NonNullable<C["params"]>>;
  query: Out<NonNullable<C["query"]>>;
  body: Out<NonNullable<C["body"]>>;
  /** Non-null on every route that isn't public. */
  user: CurrentUser;
  request: FastifyRequest;
  reply: FastifyReply;
}

export type Handler<C extends Contract> = (args: HandlerArgs<C>) => Promise<Out<C["response"]>>;

export interface RouteOptions {
  rateLimit?: {
    max: number;
    timeWindow: number;
    /** `preHandler`: after the session is resolved, so the limit can be per user. */
    hook?: "preHandler";
    keyGenerator?: (request: FastifyRequest) => string;
  };
  bodyLimit?: number;
  preValidation?: RouteShorthandOptions["preValidation"];
}

/** Register a route from its shared contract, with the permission declared in packages/authz. */
export function route<C extends Contract>(
  app: FastifyInstance,
  contract: C,
  handler: Handler<C>,
  opts: RouteOptions = {},
) {
  const permission = permissionFor(contract.id);
  const schema: Record<string, unknown> = {};
  if (contract.params) schema.params = contract.params;
  if (contract.query) schema.querystring = contract.query;
  if (contract.body) schema.body = contract.body;
  if (contract.responseKind !== "text") schema.response = { 200: contract.response };

  app.route({
    method: contract.method,
    url: `${API_PREFIX}${contract.path}`,
    schema,
    bodyLimit: opts.bodyLimit,
    preValidation: opts.preValidation,
    config: {
      // Left undefined when packages/authz has no declaration: the startup check then fails.
      ...(permission ? { permission } : {}),
      contractId: contract.id,
      ...(opts.rateLimit ? { rateLimit: opts.rateLimit } : {}),
    },
    handler: async (request, reply) => {
      const result = await handler({
        params: request.params as never,
        query: request.query as never,
        body: request.body as never,
        user: request.user as CurrentUser,
        request,
        reply,
      });
      return result;
    },
  });
}

/** Find the caller's relationship to the target resource, for ownership conditions. */
async function relationship(ctx: AppContext, permission: RoutePermission, request: FastifyRequest, user: CurrentUser) {
  if (!("resource" in permission) || permission.resource === undefined) return { rel: "none" as const, found: true };
  const id = (request.params as { id?: string }).id;
  if (!id) return { rel: "none" as const, found: false };
  if (permission.resource === "practice_attempt") {
    // Private to the user (P1.md §5): looked up by (id, caller), so anyone else's attempt is not found.
    const rows = await ctx.db
      .select({ id: PracticeAttempt.id })
      .from(PracticeAttempt)
      .where(and(eq(PracticeAttempt.id, id), eq(PracticeAttempt.userId, user.userId)))
      .limit(1);
    return rows[0] ? { rel: "owner" as const, found: true } : { rel: "none" as const, found: false };
  }
  if (permission.resource === "source") {
    const rows = await ctx.db
      .select({ ownerId: Source.ownerId })
      .from(Source)
      .where(and(eq(Source.id, id), isNull(Source.deletedAt)))
      .limit(1);
    return privateTo(rows[0]?.ownerId, user);
  }
  if (permission.resource === "authoring_session") {
    const rows = await ctx.db
      .select({ ownerId: AuthoringSession.ownerId })
      .from(AuthoringSession)
      .where(and(eq(AuthoringSession.id, id), isNull(AuthoringSession.deletedAt)))
      .limit(1);
    return privateTo(rows[0]?.ownerId, user);
  }
  if (permission.resource === "authoring_batch" || permission.resource === "draft_question") {
    // These belong to their session: its owner is theirs.
    const table = permission.resource === "authoring_batch" ? AuthoringBatch : DraftQuestion;
    const rows = await ctx.db
      .select({ ownerId: AuthoringSession.ownerId })
      .from(table)
      .innerJoin(AuthoringSession, eq(AuthoringSession.id, table.sessionId))
      .where(and(eq(table.id, id), isNull(AuthoringSession.deletedAt)))
      .limit(1);
    return privateTo(rows[0]?.ownerId, user);
  }
  const table = permission.resource === "verification_job" ? VerificationJob : Test;
  const rows = await ctx.db.select({ ownerId: table.ownerId }).from(table).where(eq(table.id, id)).limit(1);
  const row = rows[0];
  if (!row) return { rel: "none" as const, found: false };
  return { rel: row.ownerId === user.userId ? ("owner" as const) : ("none" as const), found: true };
}

/** Sources and sessions: someone else's doesn't exist, except to an admin, who may read any (P2.md §5). */
function privateTo(ownerId: string | undefined, user: CurrentUser) {
  if (ownerId === user.userId) return { rel: "owner" as const, found: true };
  return { rel: "none" as const, found: ownerId !== undefined && user.role === "admin" };
}

const NOT_FOUND: Record<NonNullable<Extract<RoutePermission, { objType: string }>["resource"]>, ErrorCode> = {
  test: "test_not_found",
  practice_attempt: "not_found",
  verification_job: "verify_job_not_found",
  source: "source_not_found",
  authoring_session: "authoring_session_not_found",
  authoring_batch: "authoring_batch_not_found",
  draft_question: "authoring_question_not_found",
};

/**
 * Session resolution + Casbin enforcement in a preHandler on every route (SPEC §5.2), and the startup
 * check: a route without a permission declaration makes `ready()` fail.
 */
export function installAuthz(app: FastifyInstance, ctx: AppContext, cookieName: string) {
  app.decorateRequest("user", null);

  const undeclared: string[] = [];
  app.addHook("onRoute", (opts) => {
    if (!opts.config?.permission) undeclared.push(`${opts.method} ${opts.url}`);
  });
  app.addHook("onReady", async () => {
    if (undeclared.length > 0) {
      throw new Error(`routes without a permission declaration (SPEC §5.2): ${[...new Set(undeclared)].join(", ")}`);
    }
  });

  app.addHook("preHandler", async (request) => {
    if (request.is404) return;
    const permission = request.routeOptions.config.permission;
    if (!permission) throw new AppError("forbidden");

    const token = request.cookies[cookieName];
    const unsigned = token ? request.unsignCookie(token) : null;
    const session = unsigned?.valid && unsigned.value ? await ctx.sessions.resolve(unsigned.value) : null;
    if (session) request.user = { ...session, role: await ctx.authz.roleOf(session.userId) };

    if ("public" in permission) return;
    const user = request.user;
    if (!user) throw new AppError("unauthenticated");

    const { rel, found } = await relationship(ctx, permission, request, user);
    if (!found) {
      // Only reveal that a resource doesn't exist to callers who could act on it if it did.
      const couldOwn = await ctx.authz.can(user.userId, permission.objType, permission.act, "owner");
      const resource = "resource" in permission && permission.resource ? permission.resource : "test";
      throw new AppError(couldOwn ? NOT_FOUND[resource] : "forbidden");
    }
    if (!(await ctx.authz.can(user.userId, permission.objType, permission.act, rel))) {
      throw new AppError("forbidden");
    }
  });
}
