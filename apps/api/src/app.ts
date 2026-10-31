import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import { CONTRACTS } from "@gem/shared/contracts";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { SESSION_COOKIE } from "./auth/sessions.ts";
import type { AppContext } from "./context.ts";
import { installErrorHandling } from "./http/errors.ts";
import { API_PREFIX, installAuthz } from "./http/route.ts";
import { adminRoutes } from "./routes/admin.ts";
import { authRoutes } from "./routes/auth.ts";
import { llmRoutes } from "./routes/llm.ts";
import { practiceRoutes } from "./routes/practice.ts";
import { publicRoutes } from "./routes/public.ts";
import { sourcesRoutes } from "./routes/sources.ts";
import { testRoutes } from "./routes/tests.ts";

export interface BuildOptions {
  logger?: FastifyServerOptions["logger"];
  /** Extra routes, registered like the real ones (used by the startup-check test). */
  extraRoutes?: (app: FastifyInstance) => void;
}

export async function buildApp(ctx: AppContext, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    // The audit log and the rate limit use the client IP: X-Forwarded-For is trusted only behind a proxy.
    trustProxy: ctx.config.TRUST_PROXY === "true",
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  installErrorHandling(app);
  installAuthz(app, ctx, SESSION_COOKIE);

  await app.register(cookie, { secret: ctx.config.SESSION_SECRET });
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      code: "rate_limited",
      params: { retryAfterMs: context.ttl },
    }),
  });
  await app.register(multipart, { limits: { files: 1 } });
  await app.register(swagger, {
    openapi: { info: { title: "gem-proctor API", version: "0.0.0" } },
    transform: jsonSchemaTransform,
  });

  // Every contract has a route.
  const registered = new Set<string>();
  app.addHook("onRoute", (r) => {
    if (r.config?.contractId) registered.add(r.config.contractId);
  });
  app.addHook("onReady", async () => {
    const missing = CONTRACTS.filter((c) => !registered.has(c.id)).map((c) => c.id);
    if (missing.length > 0) throw new Error(`contracts without a route: ${missing.join(", ")}`);
  });

  publicRoutes(app, ctx);
  authRoutes(app, ctx);
  testRoutes(app, ctx);
  adminRoutes(app, ctx);
  practiceRoutes(app, ctx);
  llmRoutes(app, ctx);
  sourcesRoutes(app, ctx);
  opts.extraRoutes?.(app);

  app.get("/api/openapi.json", { config: { permission: { public: true } } }, async () => app.swagger());

  // The built web app, served by the API in production (P0.md S2). SPA routes fall back to index.html.
  const webDist = ctx.config.WEB_DIST ? resolve(ctx.config.WEB_DIST) : undefined;
  if (webDist && existsSync(join(webDist, "index.html"))) {
    await app.register(fastifyStatic, { root: webDist, serve: false });
    app.get("/*", { config: { permission: { public: true } } }, async (request, reply) => {
      const path = (request.params as { "*": string })["*"];
      if (path.startsWith(API_PREFIX.slice(1))) return reply.callNotFound();
      const file = path && existsSync(join(webDist, path)) && !path.includes("..") ? path : "index.html";
      return reply.sendFile(file, {
        maxAge: file.startsWith("assets/") ? "1y" : 0,
        immutable: file.startsWith("assets/"),
      });
    });
  }

  return app;
}
