import { permissionFor, type RoutePermission } from "@gem/authz";
import { Test } from "@gem/db";
import { AppError } from "@gem/shared";
import type { Contract, Role } from "@gem/shared/contracts";
import { eq } from "drizzle-orm";
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
  rateLimit?: { max: number; timeWindow: number };
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
  const rows = await ctx.db.select({ ownerId: Test.ownerId }).from(Test).where(eq(Test.id, id)).limit(1);
  const row = rows[0];
  if (!row) return { rel: "none" as const, found: false };
  return { rel: row.ownerId === user.userId ? ("owner" as const) : ("none" as const), found: true };
}

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
      throw new AppError(couldOwn ? "test_not_found" : "forbidden");
    }
    if (!(await ctx.authz.can(user.userId, permission.objType, permission.act, rel))) {
      throw new AppError("forbidden");
    }
  });
}
