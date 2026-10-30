import { Endpoint, encryptSecret, LlmCallLog, newId, RoleAssignment as RoleTable } from "@gem/db";
import { type EndpointRow, listEvalSets, PROVIDER_IDS, providerFor } from "@gem/llm";
import {
  AppError,
  type Capabilities,
  type EmbeddingConfig,
  type LlmEndpoint,
  MODEL_ROLES,
  type ModelParams,
  type ModelRole,
  RoleAssignment,
  type RoleAssignmentView,
  type StatsRow,
} from "@gem/shared";
import {
  adminLlmEndpointsCreate,
  adminLlmEndpointsDelete,
  adminLlmEndpointsGet,
  adminLlmEndpointsList,
  adminLlmEndpointsModels,
  adminLlmEndpointsProbe,
  adminLlmEndpointsUpdate,
  adminLlmEvalsGet,
  adminLlmEvalsList,
  adminLlmEvalsRun,
  adminLlmRolesDelete,
  adminLlmRolesList,
  adminLlmRolesPut,
  adminLlmStats,
  llmRoles,
} from "@gem/shared/contracts";
import { and, asc, eq, gte, isNull, ne, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { writeAudit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { type RouteOptions, route } from "../http/route.ts";
import { createEvalRun, EVAL_QUEUE, evalDetail, evalRuns, evalSummary } from "../llm-evals.ts";
import { getSettings } from "../settings.ts";
import { requestMeta } from "./auth.ts";

const DEFAULT_RATE_LIMIT = 30;

function toEndpoint(row: EndpointRow): LlmEndpoint {
  return {
    id: row.id,
    label: row.label,
    provider: row.provider,
    baseUrl: row.baseUrl,
    hasKey: row.apiKeyCiphertext !== null,
    location: row.location,
    server: row.server,
    concurrency: row.concurrency,
    timeoutMs: row.timeoutMs,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** What the audit log keeps of an endpoint: never the key or its ciphertext (P1.5.md §5). */
function auditable({ id: _id, createdAt: _c, updatedAt: _u, ...rest }: LlmEndpoint) {
  return rest;
}

async function loadEndpoint(ctx: Pick<AppContext, "db">, id: string): Promise<EndpointRow> {
  const rows = await ctx.db
    .select()
    .from(Endpoint)
    .where(and(eq(Endpoint.id, id), isNull(Endpoint.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new AppError("not_found");
  return row;
}

function encryptKey(ctx: AppContext, apiKey: string, endpointId: string): string {
  const secretKey = ctx.config.ENDPOINT_SECRET_KEY;
  if (!secretKey) throw new AppError("llm_secret_key_missing");
  return encryptSecret(apiKey, secretKey, endpointId);
}

function checkProvider(provider: string, baseUrl: string | null | undefined) {
  if (!PROVIDER_IDS.includes(provider)) throw new AppError("validation_failed", { field: "provider" });
  if (provider === "openai-compatible" && !baseUrl) throw new AppError("validation_failed", { field: "baseUrl" });
}

async function rolesOnEndpoint(ctx: Pick<AppContext, "db">, endpointId: string): Promise<string[]> {
  const rows = await ctx.db
    .select({ role: RoleTable.role })
    .from(RoleTable)
    .where(eq(RoleTable.endpointId, endpointId))
    .orderBy(asc(RoleTable.role));
  return rows.map((r) => r.role);
}

/** Turning "local endpoints only" on with a role on a cloud endpoint is refused, with the roles listed. */
export async function assertNoCloudRoles(ctx: Pick<AppContext, "db">) {
  const rows = await ctx.db
    .select({ role: RoleTable.role })
    .from(RoleTable)
    .innerJoin(Endpoint, eq(Endpoint.id, RoleTable.endpointId))
    .where(eq(Endpoint.location, "cloud"))
    .orderBy(asc(RoleTable.role));
  if (rows.length > 0) throw new AppError("llm_cloud_roles_assigned", { roles: rows.map((r) => r.role).join(", ") });
}

type RoleRow = typeof RoleTable.$inferSelect;

function toView(role: ModelRole, row: RoleRow | undefined, endpoint: EndpointRow | undefined): RoleAssignmentView {
  if (!row || !endpoint) return { role, assignment: null };
  return {
    role,
    assignment: {
      endpointId: row.endpointId,
      model: row.model,
      capabilities: row.capabilities as Capabilities,
      ...(row.embedding ? { embedding: row.embedding as EmbeddingConfig } : {}),
      ...(row.params ? { params: row.params as ModelParams } : {}),
      endpointLabel: endpoint.label,
      location: endpoint.location,
      updatedAt: row.updatedAt.toISOString(),
    },
  };
}

async function allRoles(ctx: AppContext): Promise<RoleAssignmentView[]> {
  const rows = await ctx.db
    .select({ role: RoleTable, endpoint: Endpoint })
    .from(RoleTable)
    .innerJoin(Endpoint, eq(Endpoint.id, RoleTable.endpointId));
  return MODEL_ROLES.map((role) => {
    const row = rows.find((r) => r.role.role === role);
    return toView(role, row?.role, row?.endpoint);
  });
}

function auditableRole(row: RoleRow | undefined) {
  if (!row) return null;
  const { endpointId, model, capabilities, embedding, params } = row;
  return { endpointId, model, capabilities, embedding, params };
}

/** Probe, discovery and eval runs call models: limited per admin (SPEC §11.2). */
function modelCallLimit(ctx: AppContext): RouteOptions {
  return {
    rateLimit: {
      max: ctx.config.LLM_RATE_LIMIT_MAX ?? DEFAULT_RATE_LIMIT,
      timeWindow: 60_000,
      hook: "preHandler",
      keyGenerator: (request: FastifyRequest) => request.user?.userId ?? request.ip,
    },
  };
}

async function stats(ctx: AppContext, since: string | undefined): Promise<StatsRow[]> {
  const conds = [ne(LlmCallLog.kind, "probe")];
  if (since) conds.push(gte(LlmCallLog.at, new Date(since)));
  const where = and(...conds);
  const percentile = (p: number, column: typeof LlmCallLog.latencyMs | typeof LlmCallLog.queuedMs) =>
    sql<number>`coalesce(percentile_cont(${sql.raw(String(p))}) WITHIN GROUP (ORDER BY ${column}), 0)::float8`;
  const keys = { role: LlmCallLog.role, endpointId: LlmCallLog.endpointId, model: LlmCallLog.model };
  const rows = await ctx.db
    .select({
      ...keys,
      endpointLabel: Endpoint.label,
      calls: sql<number>`count(*)::int`,
      repaired: sql<number>`(count(*) FILTER (WHERE ${LlmCallLog.repairAttempts} > 0))::int`,
      salvaged: sql<number>`(count(*) FILTER (WHERE ${LlmCallLog.outcome} = 'salvaged'))::int`,
      latencyP50Ms: percentile(0.5, LlmCallLog.latencyMs),
      latencyP95Ms: percentile(0.95, LlmCallLog.latencyMs),
      queueP95Ms: percentile(0.95, LlmCallLog.queuedMs),
      tokensIn: sql<number>`coalesce(sum((${LlmCallLog.usage}->>'inputTokens')::bigint), 0)::int`,
      tokensOut: sql<number>`coalesce(sum((${LlmCallLog.usage}->>'outputTokens')::bigint), 0)::int`,
    })
    .from(LlmCallLog)
    .innerJoin(Endpoint, eq(Endpoint.id, LlmCallLog.endpointId))
    .where(where)
    .groupBy(LlmCallLog.role, LlmCallLog.endpointId, LlmCallLog.model, Endpoint.label)
    .orderBy(asc(LlmCallLog.role), asc(Endpoint.label), asc(LlmCallLog.model));
  const failures = await ctx.db
    .select({ ...keys, errorCode: LlmCallLog.errorCode, n: sql<number>`count(*)::int` })
    .from(LlmCallLog)
    .where(and(where, eq(LlmCallLog.outcome, "failed")))
    .groupBy(LlmCallLog.role, LlmCallLog.endpointId, LlmCallLog.model, LlmCallLog.errorCode);
  return rows.map(({ repaired, salvaged, ...r }) => ({
    ...r,
    failures: Object.fromEntries(
      failures
        .filter((f) => f.role === r.role && f.endpointId === r.endpointId && f.model === r.model)
        .map((f) => [f.errorCode ?? "unknown", f.n]),
    ),
    repairRate: repaired / r.calls,
    salvageRate: salvaged / r.calls,
  }));
}

export function llmRoutes(app: FastifyInstance, ctx: AppContext) {
  route(app, adminLlmEndpointsList, async () => {
    const rows = await ctx.db
      .select()
      .from(Endpoint)
      .where(isNull(Endpoint.deletedAt))
      .orderBy(asc(Endpoint.createdAt));
    return { endpoints: rows.map(toEndpoint), providers: PROVIDER_IDS };
  });

  route(app, adminLlmEndpointsCreate, async ({ body, user, request }) => {
    checkProvider(body.provider, body.baseUrl);
    const id = newId();
    const apiKeyCiphertext = body.apiKey ? encryptKey(ctx, body.apiKey, id) : null;
    const [row] = await ctx.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(Endpoint)
        .values({
          id,
          label: body.label,
          provider: body.provider,
          baseUrl: body.baseUrl ?? null,
          apiKeyCiphertext,
          location: body.location,
          server: body.server ?? null,
          concurrency: body.concurrency,
          timeoutMs: body.timeoutMs,
          createdBy: user.userId,
        })
        .returning();
      const meta = { actorId: user.userId, targetType: "llm_endpoint", targetId: id, ...requestMeta(request) };
      await writeAudit(tx, {
        ...meta,
        action: "llm.endpoint.create",
        after: auditable(toEndpoint(inserted[0] as EndpointRow)),
      });
      if (apiKeyCiphertext)
        await writeAudit(tx, { ...meta, action: "llm.endpoint.secret_change", after: { set: true } });
      return inserted;
    });
    return { endpoint: toEndpoint(row as EndpointRow) };
  });

  route(app, adminLlmEndpointsGet, async ({ params }) => ({
    endpoint: toEndpoint(await loadEndpoint(ctx, params.id)),
  }));

  route(app, adminLlmEndpointsUpdate, async ({ params, body, user, request }) => {
    const before = await loadEndpoint(ctx, params.id);
    const { apiKey, ...fields } = body;
    checkProvider(fields.provider ?? before.provider, fields.baseUrl === undefined ? before.baseUrl : fields.baseUrl);
    if (fields.location === "cloud" && before.location !== "cloud") {
      const settings = await getSettings(ctx.db);
      if (settings.localEndpointsOnly && (await rolesOnEndpoint(ctx, before.id)).length > 0) {
        throw new AppError("llm_cloud_blocked");
      }
    }
    const secret =
      apiKey === undefined ? {} : { apiKeyCiphertext: apiKey === null ? null : encryptKey(ctx, apiKey, before.id) };
    const row = await ctx.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(Endpoint)
        .set({ ...fields, ...secret, updatedAt: ctx.now() })
        .where(eq(Endpoint.id, before.id))
        .returning();
      const after = updated as EndpointRow;
      const meta = { actorId: user.userId, targetType: "llm_endpoint", targetId: before.id, ...requestMeta(request) };
      if (Object.keys(fields).length > 0) {
        const { hasKey: _b, ...was } = auditable(toEndpoint(before));
        const { hasKey: _a, ...now } = auditable(toEndpoint(after));
        await writeAudit(tx, { ...meta, action: "llm.endpoint.update", before: was, after: now });
      }
      if (apiKey !== undefined) {
        await writeAudit(tx, {
          ...meta,
          action: "llm.endpoint.secret_change",
          after: apiKey === null ? { cleared: true } : { set: true },
        });
      }
      return after;
    });
    return { endpoint: toEndpoint(row) };
  });

  route(app, adminLlmEndpointsDelete, async ({ params, user, request }) => {
    await ctx.db.transaction(async (tx) => {
      // The lock orders this against a concurrent role assignment.
      const rows = await tx
        .select()
        .from(Endpoint)
        .where(and(eq(Endpoint.id, params.id), isNull(Endpoint.deletedAt)))
        .for("update");
      const row = rows[0];
      if (!row) throw new AppError("not_found");
      const roles = await rolesOnEndpoint({ db: tx as unknown as AppContext["db"] }, row.id);
      if (roles.length > 0) throw new AppError("llm_endpoint_in_use", { roles: roles.join(", ") });
      // Call logs and eval runs keep the row; nothing needs its key any more.
      await tx.update(Endpoint).set({ deletedAt: ctx.now(), apiKeyCiphertext: null }).where(eq(Endpoint.id, row.id));
      await writeAudit(tx, {
        actorId: user.userId,
        action: "llm.endpoint.delete",
        targetType: "llm_endpoint",
        targetId: row.id,
        before: auditable(toEndpoint(row)),
        ...requestMeta(request),
      });
    });
    return { ok: true as const };
  });

  route(
    app,
    adminLlmEndpointsModels,
    async ({ params, user }) => {
      const endpoint = await loadEndpoint(ctx, params.id);
      const models = await ctx.llm.discoverModels(endpoint, { userId: user.userId });
      if (!models) throw new AppError("llm_models_unsupported");
      return { models };
    },
    modelCallLimit(ctx),
  );

  route(
    app,
    adminLlmEndpointsProbe,
    async ({ params, body, user }) => {
      const endpoint = await loadEndpoint(ctx, params.id);
      return ctx.llm.probe(endpoint, body, { userId: user.userId });
    },
    modelCallLimit(ctx),
  );

  route(app, adminLlmRolesList, async () => ({ roles: await allRoles(ctx) }));

  route(app, adminLlmRolesPut, async ({ params, body, user, request }) => {
    const { role } = params;
    const parsed = RoleAssignment.safeParse({ ...body, role });
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new AppError("validation_failed", { context: "body", field: first?.path.join(".") ?? "" });
    }
    const a = parsed.data;
    const { row, endpoint } = await ctx.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(Endpoint)
        .where(and(eq(Endpoint.id, a.endpointId), isNull(Endpoint.deletedAt)))
        .for("update");
      const endpoint = rows[0];
      if (!endpoint) throw new AppError("not_found");
      if (role === "embeddings" && !providerFor(endpoint.provider).embeddingModel) {
        throw new AppError("validation_failed", { context: "body", field: "endpointId" });
      }
      if (endpoint.location === "cloud" && (await getSettings(tx)).localEndpointsOnly) {
        throw new AppError("llm_cloud_blocked", { role });
      }
      const [before] = await tx.select().from(RoleTable).where(eq(RoleTable.role, role)).limit(1);
      const values = {
        endpointId: a.endpointId,
        model: a.model,
        capabilities: a.capabilities,
        embedding: a.embedding ?? null,
        params: a.params ?? null,
        updatedBy: user.userId,
        updatedAt: ctx.now(),
      };
      const [row] = await tx
        .insert(RoleTable)
        .values({ role, ...values })
        .onConflictDoUpdate({ target: RoleTable.role, set: values })
        .returning();
      await writeAudit(tx, {
        actorId: user.userId,
        action: "llm.role.assign",
        targetType: "llm_role",
        targetId: role,
        before: auditableRole(before),
        after: auditableRole(row),
        ...requestMeta(request),
      });
      return { row, endpoint };
    });
    return { role: toView(role, row, endpoint) };
  });

  route(app, adminLlmRolesDelete, async ({ params, user, request }) => {
    await ctx.db.transaction(async (tx) => {
      const [before] = await tx.delete(RoleTable).where(eq(RoleTable.role, params.role)).returning();
      if (!before) return;
      await writeAudit(tx, {
        actorId: user.userId,
        action: "llm.role.unassign",
        targetType: "llm_role",
        targetId: params.role,
        before: auditableRole(before),
        ...requestMeta(request),
      });
    });
    return { ok: true as const };
  });

  route(app, adminLlmStats, async ({ query }) => ({ rows: await stats(ctx, query.since) }));

  route(
    app,
    adminLlmEvalsRun,
    async ({ body, user }) => {
      if (!ctx.queue) throw new AppError("service_unavailable");
      const run = await createEvalRun(ctx, { evalSet: body.evalSet, trials: body.trials, startedBy: user.userId });
      await ctx.queue.send(EVAL_QUEUE, { runId: run.id });
      return { run: await evalSummary(ctx, run.id) };
    },
    modelCallLimit(ctx),
  );

  route(app, adminLlmEvalsList, async ({ query }) => ({
    runs: await evalRuns(ctx, query.role),
    evalSets: listEvalSets(),
  }));

  route(app, adminLlmEvalsGet, async ({ params }) => ({ run: await evalDetail(ctx, params.id) }));

  route(app, llmRoles, async () => {
    const roles = await allRoles(ctx);
    return {
      roles: roles.map(({ role, assignment: a }) =>
        a
          ? {
              role,
              assigned: true,
              location: a.location,
              ...(a.location === "cloud" ? { endpointLabel: a.endpointLabel } : {}),
            }
          : { role, assigned: false },
      ),
    };
  });
}
