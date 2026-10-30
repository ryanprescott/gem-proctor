import { type Db, Endpoint, encryptSecret, newId, RoleAssignment } from "@gem/db";
import type { EndpointLocation, EndpointServer, ModelParams, ModelRole, StructuredMode } from "@gem/shared";
import { MODEL_ROLES } from "@gem/shared";
import { and, eq, isNull } from "drizzle-orm";
import { writeAudit } from "./audit.ts";
import type { Config } from "./config.ts";

/**
 * The dev seed (P1.5.md §5): the `LLM_DEV_*` endpoint, a second one for embeddings if its URL differs, and
 * role assignments for roles that have none. Idempotent, and never overwrites an assignment. Audited with a
 * null actor.
 */

const DEFAULT_LABEL = "Dev LLM";
const DEFAULT_CONTEXT = 8192;
const MAX_OUTPUT_SHARE = 4;

const serverOf = (server: Config["LLM_DEV_SERVER"]): EndpointServer | null =>
  server === undefined ? null : server === "llama.cpp" ? "llamacpp" : server;

interface EndpointSpec {
  label: string;
  provider: string;
  baseUrl: string;
  location: EndpointLocation;
}

async function ensureEndpoint(db: Db, config: Config, spec: EndpointSpec): Promise<string> {
  const existing = await db
    .select({ id: Endpoint.id })
    .from(Endpoint)
    .where(and(eq(Endpoint.label, spec.label), eq(Endpoint.baseUrl, spec.baseUrl), isNull(Endpoint.deletedAt)))
    .limit(1);
  if (existing[0]) return existing[0].id;
  const id = newId();
  const { LLM_DEV_API_KEY: apiKey, ENDPOINT_SECRET_KEY: secretKey } = config;
  const apiKeyCiphertext = apiKey && secretKey ? encryptSecret(apiKey, secretKey, id) : null;
  const server = serverOf(config.LLM_DEV_SERVER);
  const concurrency = config.LLM_DEV_CONCURRENCY ?? 1;
  const timeoutMs = config.LLM_DEV_TIMEOUT_MS ?? 120_000;
  await db.transaction(async (tx) => {
    await tx.insert(Endpoint).values({ id, ...spec, apiKeyCiphertext, server, concurrency, timeoutMs });
    const meta = { actorId: null, targetType: "llm_endpoint", targetId: id };
    await writeAudit(tx, {
      ...meta,
      action: "llm.endpoint.create",
      after: { ...spec, server, concurrency, timeoutMs, hasKey: apiKeyCiphertext !== null },
    });
    if (apiKeyCiphertext) await writeAudit(tx, { ...meta, action: "llm.endpoint.secret_change", after: { set: true } });
  });
  return id;
}

async function assignIfFree(db: Db, role: ModelRole, values: Omit<typeof RoleAssignment.$inferInsert, "role">) {
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(RoleAssignment)
      .values({ role, ...values })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) return;
    const { endpointId, model, capabilities, embedding, params } = values;
    await writeAudit(tx, {
      actorId: null,
      action: "llm.role.assign",
      targetType: "llm_role",
      targetId: role,
      after: { endpointId, model, capabilities, embedding, params },
    });
  });
}

export async function seedDevLlm(
  { config, db }: { config: Config; db: Db },
  log: (message: string) => void = () => {},
): Promise<void> {
  const baseUrl = config.LLM_DEV_BASE_URL;
  const model = config.LLM_DEV_MODEL;
  if (!baseUrl || !model) {
    log("llm seed: LLM_DEV_BASE_URL or LLM_DEV_MODEL not set, nothing to do");
    return;
  }
  const provider = config.LLM_DEV_PROVIDER ?? "openai-compatible";
  const location: EndpointLocation = provider === "openai-compatible" ? "local" : "cloud";
  const label = config.LLM_DEV_LABEL ?? DEFAULT_LABEL;
  const endpointId = await ensureEndpoint(db, config, { label, provider, baseUrl, location });

  const contextWindow = config.LLM_DEV_CONTEXT ?? DEFAULT_CONTEXT;
  const capabilities = {
    structuredOutput: (config.LLM_DEV_STRUCTURED_MODE ?? "native_schema") as StructuredMode,
    contextWindow,
    maxOutputTokens: Math.floor(contextWindow / MAX_OUTPUT_SHARE),
  };
  const params = config.LLM_DEV_PARAMS ? (JSON.parse(config.LLM_DEV_PARAMS) as ModelParams) : null;
  const roles = (config.LLM_DEV_ROLES ?? "")
    .split(",")
    .filter((r): r is ModelRole => (MODEL_ROLES as readonly string[]).includes(r));
  for (const role of roles) {
    if (role !== "embeddings") await assignIfFree(db, role, { endpointId, model, capabilities, params });
  }

  const embedModel = config.LLM_DEV_EMBED_MODEL;
  const dimensions = config.LLM_DEV_EMBED_DIM;
  const maxInputTokens = config.LLM_DEV_EMBED_MAX_INPUT_TOKENS;
  if (!embedModel || !dimensions || !maxInputTokens) return;
  const embedUrl = config.LLM_DEV_EMBED_BASE_URL ?? baseUrl;
  const embedEndpoint =
    embedUrl === baseUrl
      ? endpointId
      : await ensureEndpoint(db, config, { label: `${label} embeddings`, provider, baseUrl: embedUrl, location });
  await assignIfFree(db, "embeddings", {
    endpointId: embedEndpoint,
    model: embedModel,
    capabilities: { ...capabilities, contextWindow: maxInputTokens, maxInputTokens },
    embedding: {
      dimensions,
      queryPrefix: config.LLM_DEV_EMBED_QUERY_PREFIX ?? "",
      documentPrefix: config.LLM_DEV_EMBED_DOCUMENT_PREFIX ?? "",
    },
  });
}
