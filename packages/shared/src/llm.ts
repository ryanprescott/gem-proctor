import { z } from "zod";
import { ERROR_CODES } from "./errors.ts";

/** The LLM layer's shared shapes (SPEC §3B.2, P1.5.md §4–§6). Keys are write-only: no response shape holds one. */

export const MODEL_ROLES = [
  "authoring.objectives",
  "authoring.generate",
  "authoring.judge",
  "verify.solve",
  "analysis",
  "embeddings",
] as const;
export const ModelRole = z.enum(MODEL_ROLES);
export type ModelRole = z.infer<typeof ModelRole>;

export const ENDPOINT_LOCATIONS = ["local", "cloud"] as const;
export const EndpointLocation = z.enum(ENDPOINT_LOCATIONS);
export type EndpointLocation = z.infer<typeof EndpointLocation>;

export const ENDPOINT_SERVERS = ["vllm", "llamacpp", "ollama", "lmstudio", "gateway", "other"] as const;
export const EndpointServer = z.enum(ENDPOINT_SERVERS);
export type EndpointServer = z.infer<typeof EndpointServer>;

export const STRUCTURED_MODES = ["native_schema", "prompt_only"] as const;
export const StructuredMode = z.enum(STRUCTURED_MODES);
export type StructuredMode = z.infer<typeof StructuredMode>;

export const DEFAULT_ENDPOINT_CONCURRENCY = 1;
export const DEFAULT_ENDPOINT_TIMEOUT_MS = 300_000;

const Iso = z.iso.datetime({ offset: true });
const LABEL_MAX = 200;

/** `http:` or `https:` with no credentials in it (P1.5.md §5, SSRF). */
export const EndpointBaseUrl = z
  .url()
  .max(2000)
  .refine(
    (s) => {
      const u = new URL(s);
      return (u.protocol === "http:" || u.protocol === "https:") && u.username === "" && u.password === "";
    },
    { message: "must be http(s) without credentials" },
  );

export const Capabilities = z
  .object({
    structuredOutput: StructuredMode,
    /** The context we budget against; for local servers, what the server was launched with. */
    contextWindow: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    /** Embeddings: longest input embedded *without truncation* (measured by the probe). */
    maxInputTokens: z.number().int().positive().optional(),
  })
  .refine((c) => c.maxOutputTokens < c.contextWindow, {
    path: ["maxOutputTokens"],
    message: "must be less than contextWindow",
  });
export type Capabilities = z.infer<typeof Capabilities>;

export const EmbeddingConfig = z.object({
  /** Fixes the pgvector column size (P2). */
  dimensions: z.number().int().positive(),
  queryPrefix: z.string().max(500).default(""),
  documentPrefix: z.string().max(500).default(""),
});
export type EmbeddingConfig = z.infer<typeof EmbeddingConfig>;

/** Sampling settings and provider-specific options; merged into the request body by the adapter. */
export const ModelParams = z.record(z.string(), z.unknown());
export type ModelParams = z.infer<typeof ModelParams>;

export const RoleAssignmentBody = z.object({
  endpointId: z.uuid(),
  model: z.string().trim().min(1).max(500),
  capabilities: Capabilities,
  embedding: EmbeddingConfig.optional(),
  params: ModelParams.optional(),
});
export type RoleAssignmentBody = z.infer<typeof RoleAssignmentBody>;

/** A complete assignment: `embedding` and `maxInputTokens` are required for `embeddings`; `embedding` only there. */
export const RoleAssignment = RoleAssignmentBody.extend({ role: ModelRole }).superRefine((a, ctx) => {
  if (a.role === "embeddings") {
    if (!a.embedding) ctx.addIssue({ code: "custom", path: ["embedding"], message: "required for embeddings" });
    if (a.capabilities.maxInputTokens === undefined) {
      ctx.addIssue({ code: "custom", path: ["capabilities", "maxInputTokens"], message: "required for embeddings" });
    }
  } else if (a.embedding) {
    ctx.addIssue({ code: "custom", path: ["embedding"], message: "only for embeddings" });
  }
});
export type RoleAssignment = z.infer<typeof RoleAssignment>;

/** An endpoint as the API returns it: `hasKey` says a key is stored, nothing else about it ever leaves. */
export const LlmEndpoint = z.object({
  id: z.uuid(),
  label: z.string(),
  provider: z.string(),
  baseUrl: z.string().nullable(),
  hasKey: z.boolean(),
  location: EndpointLocation,
  server: EndpointServer.nullable(),
  concurrency: z.number().int(),
  timeoutMs: z.number().int(),
  createdAt: Iso,
  updatedAt: Iso,
});
export type LlmEndpoint = z.infer<typeof LlmEndpoint>;

const EndpointFields = {
  label: z.string().trim().min(1).max(LABEL_MAX),
  /** Any registered adapter; checked against the registry by the API. */
  provider: z.string().trim().min(1).max(100),
  baseUrl: EndpointBaseUrl,
  apiKey: z.string().min(1).max(5000),
  location: EndpointLocation,
  server: EndpointServer,
  concurrency: z.number().int().min(1).max(100),
  timeoutMs: z.number().int().min(1000).max(3_600_000),
};

export const EndpointCreate = z
  .object({
    label: EndpointFields.label,
    provider: EndpointFields.provider.default("openai-compatible"),
    baseUrl: EndpointFields.baseUrl.optional(),
    apiKey: EndpointFields.apiKey.optional(),
    location: EndpointFields.location,
    server: EndpointFields.server.optional(),
    concurrency: EndpointFields.concurrency.default(DEFAULT_ENDPOINT_CONCURRENCY),
    timeoutMs: EndpointFields.timeoutMs.default(DEFAULT_ENDPOINT_TIMEOUT_MS),
  })
  .superRefine((b, ctx) => {
    if (b.provider === "openai-compatible" && !b.baseUrl) {
      ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "required for openai-compatible" });
    }
  });
export type EndpointCreate = z.input<typeof EndpointCreate>;

/** `apiKey`: a string sets it, null clears it, absent keeps it. Null clears the other nullable fields too. */
export const EndpointPatch = z
  .object({
    label: EndpointFields.label.optional(),
    provider: EndpointFields.provider.optional(),
    baseUrl: EndpointFields.baseUrl.nullable().optional(),
    apiKey: EndpointFields.apiKey.nullable().optional(),
    location: EndpointFields.location.optional(),
    server: EndpointFields.server.nullable().optional(),
    concurrency: EndpointFields.concurrency.optional(),
    timeoutMs: EndpointFields.timeoutMs.optional(),
  })
  .refine((b) => Object.keys(b).length > 0);
export type EndpointPatch = z.input<typeof EndpointPatch>;

export const ModelInfo = z.object({
  id: z.string(),
  /** The context the server reports for this model, where it reports one. */
  contextLength: z.number().int().nullable(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

export const ProbeKind = z.enum(["chat", "embeddings"]);
export type ProbeKind = z.infer<typeof ProbeKind>;

export const ProbeRequest = z.object({
  model: z.string().trim().min(1).max(500),
  kind: ProbeKind,
  /** As in `RoleAssignment.params`: e.g. thinking off, for a model that would otherwise reason first. */
  params: ModelParams.optional(),
});

export const ProbeMode = z.object({
  mode: StructuredMode,
  latencyMs: z.number().int(),
  /** Null: the reply hit the output budget before it was complete, so this says nothing about the mode. */
  schemaRespected: z.boolean().nullable(),
  finishReason: z.string().nullable(),
  errorCode: z.enum(ERROR_CODES).nullable(),
});
export type ProbeMode = z.infer<typeof ProbeMode>;

export const ChatProbeResult = z.object({
  kind: z.literal("chat"),
  /** `native_schema` first; `prompt_only` is tried if the schema wasn't respected, not if the reply was cut off. */
  modes: z.array(ProbeMode),
  reportedContext: z.number().int().nullable(),
});

export const EmbeddingsProbeResult = z.object({
  kind: z.literal("embeddings"),
  dimensions: z.number().int(),
  latencyMs: z.number().int(),
  /** Largest input length, in tokens, that still changed the vector. */
  maxInputTokens: z.number().int(),
  requests: z.number().int(),
  reportedContext: z.number().int().nullable(),
});

export const ProbeResult = z.discriminatedUnion("kind", [ChatProbeResult, EmbeddingsProbeResult]);
export type ProbeResult = z.infer<typeof ProbeResult>;

export const RoleAssignmentView = z.object({
  role: ModelRole,
  /** Null while unassigned. */
  assignment: RoleAssignmentBody.extend({
    endpointLabel: z.string(),
    location: EndpointLocation,
    updatedAt: Iso,
  }).nullable(),
});
export type RoleAssignmentView = z.infer<typeof RoleAssignmentView>;

/** What any signed-in user may know about a role (SPEC §8.1): no URLs, no model ids. */
export const LlmRoleStatus = z.object({
  role: ModelRole,
  assigned: z.boolean(),
  location: EndpointLocation.optional(),
  /** For `cloud` endpoints only, for the notice naming them. */
  endpointLabel: z.string().optional(),
});
export type LlmRoleStatus = z.infer<typeof LlmRoleStatus>;

export const StatsRow = z.object({
  role: z.string().nullable(),
  endpointId: z.uuid(),
  endpointLabel: z.string(),
  model: z.string(),
  calls: z.number().int(),
  failures: z.record(z.string(), z.number().int()),
  /** Share of calls that needed at least one repair. */
  repairRate: z.number(),
  /** Share of calls that returned a salvaged batch. */
  salvageRate: z.number(),
  latencyP50Ms: z.number(),
  latencyP95Ms: z.number(),
  queueP95Ms: z.number(),
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
});
export type StatsRow = z.infer<typeof StatsRow>;

export const EVAL_STATUSES = ["queued", "running", "done", "failed"] as const;
export const EvalStatus = z.enum(EVAL_STATUSES);
export type EvalStatus = z.infer<typeof EvalStatus>;

export const EVAL_TRIALS_MAX = 100;

export const EvalRunRequest = z.object({
  evalSet: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .max(100),
  trials: z.number().int().min(1).max(EVAL_TRIALS_MAX).optional(),
});

/** Every metric an eval set can report; a new one needs a catalog label too. */
export const EVAL_METRICS = [
  "trials",
  "validFirstTry",
  "repairsPerCall",
  "validAfterRepairs",
  "evidenceVerbatim",
  "secondsPerQuestion",
  "queries",
  "top1",
  "mrr",
  "top1NoPrefix",
  "mrrNoPrefix",
  "blindValid",
  "agreement",
  "repairRate",
  "classification",
  "q7Outcome",
  "l1Pass",
  "l2Pass",
  "l3Pass",
  "top1Pgvector",
  "mrrPgvector",
  "top1Hybrid",
  "mrrHybrid",
] as const;
export type EvalMetric = (typeof EVAL_METRICS)[number];

/** Metric name → value; which metrics exist depends on the eval set. */
export const EvalSummary = z.record(z.string(), z.number().nullable());
export type EvalSummary = z.infer<typeof EvalSummary>;

export const EvalRunSummary = z.object({
  id: z.uuid(),
  evalSet: z.string(),
  role: ModelRole,
  endpointId: z.uuid(),
  endpointLabel: z.string(),
  model: z.string(),
  promptVersion: z.string(),
  status: EvalStatus,
  trials: z.number().int(),
  summary: EvalSummary.nullable(),
  errorCode: z.enum(ERROR_CODES).nullable(),
  createdAt: Iso,
  startedAt: Iso.nullable(),
  finishedAt: Iso.nullable(),
});
export type EvalRunSummary = z.infer<typeof EvalRunSummary>;

export const EvalRunDetail = EvalRunSummary.extend({
  items: z.array(z.record(z.string(), z.unknown())).nullable(),
});
export type EvalRunDetail = z.infer<typeof EvalRunDetail>;
