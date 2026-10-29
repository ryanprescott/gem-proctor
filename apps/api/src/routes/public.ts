import { quizJsonSchema, resultJsonSchema } from "@gem/shared";
import { health, quizSchema, resultSchema } from "@gem/shared/contracts";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { route } from "../http/route.ts";

export function publicRoutes(app: FastifyInstance, ctx: AppContext) {
  route(app, health, async ({ reply }) => {
    let dbOk = false;
    try {
      await ctx.db.execute(sql`SELECT 1`);
      dbOk = true;
    } catch {}
    const queue = ctx.queue?.status(ctx.now()) ?? { ok: false, lastHeartbeatAt: null };
    const v = await ctx.verify.health();
    const body = {
      ok: dbOk && queue.ok && v !== null,
      db: { ok: dbOk },
      queue,
      verify: v ? { ok: true, sympy: v.sympy, numpy: v.numpy } : { ok: false },
    };
    if (!body.ok) reply.status(503);
    return body;
  });

  const quiz = quizJsonSchema();
  const result = resultJsonSchema();
  route(app, quizSchema, async ({ reply }) => {
    reply.header("cache-control", "public, max-age=300");
    return quiz;
  });
  route(app, resultSchema, async ({ reply }) => {
    reply.header("cache-control", "public, max-age=300");
    return result;
  });
}
