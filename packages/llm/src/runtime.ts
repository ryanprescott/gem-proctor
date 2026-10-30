import { type Db, decryptSecret, Endpoint, InstanceSettings, LlmCallLog, newId, RoleAssignment } from "@gem/db";
import {
  type Capabilities,
  type EmbeddingConfig,
  jsonSchemaOf,
  type ModelParams,
  type ModelRole,
  type NormalizationFix,
  type StructuredMode,
} from "@gem/shared";
import { embedMany, generateText, type ModelMessage, parsePartialJson, streamText } from "ai";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { LlmError, toLlmError } from "./errors.ts";
import { DEFAULT_PROMPTS, type LoadedPrompt, loadPrompt, type PromptSource, renderPrompt } from "./prompts.ts";
import { providerFor } from "./providers/index.ts";
import type { Provider, ProviderContext } from "./providers/types.ts";
import { QueueRegistry } from "./queue.ts";
import {
  exampleFromSchema,
  type FailedItem,
  type OutputIssue,
  parseOutput,
  promptOnlySystem,
  salvage,
} from "./structured.ts";
import type {
  CallOptions,
  EmbedOptions,
  EmbedResult,
  GenerateOptions,
  LlmResult,
  LlmRuntime,
  LlmStream,
  LlmUsage,
  PromptInput,
} from "./types.ts";

// The SDK's warnings would go to stdout; ours are in the call log.
(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

const DEFAULT_MAX_REPAIRS = 2;
const REPAIR_PROMPT = "output-repair";
const EMBED_BATCH = 32;
const CHARS_PER_TOKEN = 3;

/** Roles whose full bodies are the provenance record (SPEC §3B.4). `analysis` carries student data: metadata only. */
const logsBodies = (role: ModelRole) => role.startsWith("authoring.") || role === "verify.solve";

const estimateTokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);

export interface RuntimeDeps {
  db: Db;
  /** `ENDPOINT_SECRET_KEY`. */
  secretKey?: string;
  prompts?: PromptSource;
}

/** A role resolved to what a call needs. */
export interface Target {
  role: ModelRole | null;
  endpoint: typeof Endpoint.$inferSelect;
  model: string;
  capabilities: Capabilities;
  embedding: EmbeddingConfig | null;
  params: ModelParams;
}

interface Exchange {
  text: string;
  finishReason: string | null;
  usage: LlmUsage;
  queuedMs: number;
  latencyMs: number;
}

interface LogEntry {
  target: Target;
  opts: CallOptions;
  mode: string;
  outcome: "ok" | "salvaged" | "failed";
  error?: unknown;
  prompt?: LoadedPrompt;
  finishReason?: string | null;
  repairAttempts?: number;
  fixes?: NormalizationFix[];
  usage?: LlmUsage;
  queuedMs?: number;
  latencyMs?: number;
  requestBody?: unknown;
  responseBody?: unknown;
}

const NO_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0 };

class Totals {
  usage = { ...NO_USAGE };
  queuedMs = 0;
  latencyMs = 0;
  finishReason: string | null = null;

  add(x: Exchange) {
    this.usage.inputTokens += x.usage.inputTokens;
    this.usage.outputTokens += x.usage.outputTokens;
    this.queuedMs += x.queuedMs;
    this.latencyMs += x.latencyMs;
    this.finishReason = x.finishReason;
  }
}

function errorCodeOf(err: unknown): string | null {
  if (err === undefined) return null;
  if (err instanceof LlmError) return err.code;
  return err instanceof Error && err.name === "AbortError" ? "aborted" : "internal";
}

export class Runtime implements LlmRuntime {
  private readonly db: Db;
  private readonly secretKey: string | undefined;
  private readonly prompts: PromptSource;
  private readonly queues = new QueueRegistry();

  constructor(deps: RuntimeDeps) {
    this.db = deps.db;
    this.secretKey = deps.secretKey;
    this.prompts = deps.prompts ?? DEFAULT_PROMPTS;
  }

  // ── Resolution ─────────────────────────────────────────────────────

  async resolve(role: ModelRole): Promise<Target> {
    const rows = await this.db
      .select({ assignment: RoleAssignment, endpoint: Endpoint })
      .from(RoleAssignment)
      .innerJoin(Endpoint, eq(Endpoint.id, RoleAssignment.endpointId))
      .where(eq(RoleAssignment.role, role))
      .limit(1);
    const row = rows[0];
    if (!row) throw new LlmError("llm_role_unassigned", { role });
    return {
      role,
      endpoint: row.endpoint,
      model: row.assignment.model,
      capabilities: row.assignment.capabilities as Capabilities,
      embedding: row.assignment.embedding as EmbeddingConfig | null,
      params: (row.assignment.params ?? {}) as ModelParams,
    };
  }

  private async localOnly(): Promise<boolean> {
    const rows = await this.db
      .select({ value: InstanceSettings.value })
      .from(InstanceSettings)
      .where(eq(InstanceSettings.key, "localEndpointsOnly"))
      .limit(1);
    return rows[0]?.value === true;
  }

  private async checkLocation(target: Target) {
    if (target.endpoint.location === "cloud" && (await this.localOnly())) {
      throw new LlmError("llm_cloud_blocked", { role: target.role ?? "" });
    }
  }

  /** The provider and its request context; a key that can't be read is `llm_endpoint_auth` (P1.5.md §5). */
  private context(endpoint: Target["endpoint"]): { provider: Provider; ctx: ProviderContext } {
    let apiKey: string | undefined;
    if (endpoint.apiKeyCiphertext) {
      if (!this.secretKey) throw new LlmError("llm_endpoint_auth");
      try {
        apiKey = decryptSecret(endpoint.apiKeyCiphertext, this.secretKey, endpoint.id);
      } catch {
        throw new LlmError("llm_endpoint_auth");
      }
    }
    return {
      provider: providerFor(endpoint.provider),
      ctx: { baseUrl: endpoint.baseUrl, server: endpoint.server, apiKey },
    };
  }

  // ── Queue + timeout ────────────────────────────────────────────────

  /** One request: waits for a slot (cancellable), then runs with `timeoutMs` counted from dispatch. */
  private async dispatch<R>(
    endpoint: Target["endpoint"],
    opts: CallOptions,
    fn: (signal: AbortSignal) => Promise<R>,
  ): Promise<{ result: R; queuedMs: number; latencyMs: number }> {
    const queued = Date.now();
    const queue = this.queues.for(endpoint.id, endpoint.concurrency);
    return queue.run(opts.userId ?? "system", opts.signal, async () => {
      const started = Date.now();
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), endpoint.timeoutMs);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout.signal]) : timeout.signal;
      try {
        const result = await fn(signal);
        return { result, queuedMs: started - queued, latencyMs: Date.now() - started };
      } catch (err) {
        if (timeout.signal.aborted) throw new LlmError("llm_endpoint_timeout", { timeoutMs: endpoint.timeoutMs });
        if (opts.signal?.aborted) throw opts.signal.reason;
        throw toLlmError(err);
      } finally {
        clearTimeout(timer);
      }
    });
  }

  private usageOf(u: { inputTokens?: number; outputTokens?: number }): LlmUsage {
    return { inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0 };
  }

  private responseFormat(mode: StructuredMode, schema: Record<string, unknown>) {
    return {
      name: "structured",
      responseFormat: Promise.resolve(
        mode === "native_schema" ? { type: "json" as const, schema, name: "out" } : undefined,
      ),
      parseCompleteOutput: async ({ text }: { text: string }) => text,
      // The SDK holds text deltas back until this returns something.
      parsePartialOutput: async ({ text }: { text: string }) => ({ partial: text }),
      createElementStreamTransform: () => undefined,
    };
  }

  private providerOptions() {
    // Not `strict`: it adds nothing on local servers and a cloud API refuses optional fields under it.
    return { gem: { strictJsonSchema: false } };
  }

  private async exchange(
    target: Target,
    opts: CallOptions,
    request: Request,
    onDelta?: (text: string) => void,
  ): Promise<Exchange> {
    this.checkContext(target, request);
    const { provider, ctx } = this.context(target.endpoint);
    const model = provider.chatModel(ctx, target.model, target.params);
    const common = {
      model,
      system: request.system,
      messages: request.messages as ModelMessage[],
      maxOutputTokens: target.capabilities.maxOutputTokens,
      maxRetries: 0,
      providerOptions: this.providerOptions(),
      output: this.responseFormat(request.mode, request.schema),
    };
    const { result, queuedMs, latencyMs } = await this.dispatch(target.endpoint, opts, async (signal) => {
      if (!onDelta) {
        const r = await generateText({ ...common, abortSignal: signal });
        return { text: r.text, finishReason: r.finishReason as string, usage: this.usageOf(r.usage) };
      }
      return this.consumeStream(streamText({ ...common, abortSignal: signal, onError: () => {} }), onDelta);
    });
    return { ...result, queuedMs, latencyMs };
  }

  private async consumeStream(stream: ReturnType<typeof streamText>, onDelta: (text: string) => void) {
    let text = "";
    let finishReason: string | null = null;
    let usage = NO_USAGE;
    for await (const part of stream.fullStream) {
      if (part.type === "text-delta") {
        text += part.text;
        onDelta(text);
      } else if (part.type === "finish") {
        finishReason = part.finishReason;
        usage = this.usageOf(part.totalUsage);
      } else if (part.type === "error") {
        throw part.error;
      } else if (part.type === "abort") {
        throw new Error("aborted");
      }
    }
    return { text, finishReason, usage };
  }

  private checkContext(target: Target, request: Request) {
    const chars = request.system.length + request.messages.reduce((n, m) => n + m.content.length, 0);
    const budget = target.capabilities.contextWindow - target.capabilities.maxOutputTokens;
    const estimate = Math.ceil(chars / CHARS_PER_TOKEN);
    if (estimate > budget) throw new LlmError("llm_context_exceeded", { estimate, budget });
  }

  // ── Structured output ──────────────────────────────────────────────

  private buildRequest(target: Target, input: PromptInput, schema: Record<string, unknown>, example: unknown) {
    const prompt = loadPrompt(input.promptId, target.model, this.prompts);
    const { system, user } = renderPrompt(prompt, input.vars);
    const mode = target.capabilities.structuredOutput;
    const messages = [...(user ? [{ role: "user" as const, content: user }] : []), ...(input.messages ?? [])];
    return {
      prompt,
      request: {
        mode,
        schema,
        system: mode === "prompt_only" ? promptOnlySystem(system, schema, example) : system,
        messages,
      } satisfies Request,
    };
  }

  private repairRequest(
    target: Target,
    schema: Record<string, unknown>,
    example: unknown,
    output: string,
    issues: OutputIssue[],
  ): Request {
    const prompt = loadPrompt(REPAIR_PROMPT, target.model, this.prompts);
    const { system, user } = renderPrompt(prompt, {
      issues: issues.map((i) => `- ${i.path || "(root)"}: ${i.message}`).join("\n"),
      output,
      schema: JSON.stringify(schema, null, 2),
    });
    const mode = target.capabilities.structuredOutput;
    return {
      mode,
      schema,
      system: mode === "prompt_only" ? promptOnlySystem(system, schema, example) : system,
      messages: [{ role: "user", content: user }],
    };
  }

  /** The repair loop (SPEC §3B.3), shared by `generateObject` and `streamObject`'s `final`. */
  private async structured<T>(
    role: ModelRole,
    schema: z.ZodType<T>,
    input: PromptInput,
    opts: GenerateOptions,
    onDelta?: (text: string) => void,
  ): Promise<LlmResult<T>> {
    const target = await this.resolve(role);
    const totals = new Totals();
    const fixes: NormalizationFix[] = [];
    const attempts: { text: string; finishReason: string | null }[] = [];
    const jsonSchema = jsonSchemaOf(schema);
    const example = opts.example ?? exampleFromSchema(jsonSchema);
    const mode = target.capabilities.structuredOutput;
    let prompt: LoadedPrompt | undefined;
    let requestBody: unknown;
    let repairAttempts = 0;

    const log = (entry: Partial<LogEntry> & Pick<LogEntry, "outcome">, value?: unknown) =>
      this.writeLog({
        target,
        opts,
        mode,
        prompt,
        finishReason: totals.finishReason,
        repairAttempts,
        fixes,
        usage: totals.usage,
        queuedMs: totals.queuedMs,
        latencyMs: totals.latencyMs,
        requestBody,
        responseBody: { attempts, ...(value === undefined ? {} : { value }) },
        ...entry,
      });

    const finish = async (value: T, failedItems?: FailedItem[]): Promise<LlmResult<T>> => {
      const logged = { value, ...(failedItems ? { failedItems } : {}) };
      const callLogId = await log({ outcome: failedItems ? "salvaged" : "ok" }, logged);
      return {
        value,
        endpointId: target.endpoint.id,
        model: target.model,
        finishReason: totals.finishReason,
        usage: totals.usage,
        repairAttempts,
        latencyMs: totals.latencyMs,
        callLogId,
        promptVersion: (prompt as LoadedPrompt).version,
        mode,
        normalizationFixes: fixes,
        queuedMs: totals.queuedMs,
        ...(failedItems ? { failedItems } : {}),
      };
    };

    try {
      await this.checkLocation(target);
      const built = this.buildRequest(target, input, jsonSchema, example);
      prompt = built.prompt;
      requestBody = { ...built.request, params: target.params, promptFile: prompt.file };
      const maxRepairs = opts.maxRepairs ?? DEFAULT_MAX_REPAIRS;
      let request: Request = built.request;
      let lastParsed: unknown;
      for (;;) {
        const reply = await this.exchange(target, opts, request, repairAttempts === 0 ? onDelta : undefined);
        totals.add(reply);
        attempts.push({ text: reply.text, finishReason: reply.finishReason });
        const parsed = parseOutput(reply.text, schema);
        fixes.push(...parsed.fixes);
        if (parsed.ok) return await finish(parsed.value);
        if (parsed.parsed !== undefined) lastParsed = parsed.parsed;
        if (repairAttempts >= maxRepairs) {
          const saved = opts.salvage && salvage(lastParsed, schema, opts.salvage);
          if (saved) return await finish(saved.value, saved.failedItems);
          throw new LlmError("llm_output_invalid", { repairAttempts });
        }
        repairAttempts++;
        request = this.repairRequest(target, jsonSchema, example, reply.text, parsed.issues);
      }
    } catch (err) {
      await log({ outcome: "failed", error: err });
      throw err;
    }
  }

  generateObject<T>(
    role: ModelRole,
    schema: z.ZodType<T>,
    input: PromptInput,
    opts: GenerateOptions = {},
  ): Promise<LlmResult<T>> {
    return this.structured(role, schema, input, opts);
  }

  streamObject<T>(role: ModelRole, schema: z.ZodType<T>, input: PromptInput, opts: GenerateOptions = {}): LlmStream<T> {
    const partials: Partial<T>[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    let last = "";
    let parsing = Promise.resolve();

    const notify = () => {
      wake?.();
      wake = undefined;
    };
    const onDelta = (text: string) => {
      parsing = parsing.then(async () => {
        const json = jsonPart(text);
        if (json === undefined) return;
        const { value } = await parsePartialJson(json);
        if (typeof value !== "object" || value === null) return;
        const serialized = JSON.stringify(value);
        if (serialized === last) return;
        last = serialized;
        partials.push(value as Partial<T>);
        notify();
      });
    };

    const final = this.structured(role, schema, input, opts, onDelta).finally(async () => {
      await parsing;
      done = true;
      notify();
    });
    // A caller that only iterates still sees the failure through `final`, never as an unhandled rejection.
    final.catch(() => {});

    async function* iterate() {
      for (;;) {
        const next = partials.shift();
        if (next !== undefined) yield next;
        else if (done) return;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    }
    return Object.assign(iterate(), { final });
  }

  // ── Embeddings ─────────────────────────────────────────────────────

  async embed(texts: string[], opts: EmbedOptions): Promise<EmbedResult> {
    const target = await this.resolve("embeddings");
    const totals = new Totals();
    try {
      await this.checkLocation(target);
      const out = await this.embedAll(target, texts, opts, totals);
      await this.writeLog({
        target,
        opts,
        mode: "embeddings",
        outcome: "ok",
        usage: totals.usage,
        queuedMs: totals.queuedMs,
        latencyMs: totals.latencyMs,
      });
      return out;
    } catch (err) {
      await this.writeLog({
        target,
        opts,
        mode: "embeddings",
        outcome: "failed",
        error: err,
        usage: totals.usage,
        queuedMs: totals.queuedMs,
        latencyMs: totals.latencyMs,
      });
      throw err;
    }
  }

  private async embedAll(target: Target, texts: string[], opts: EmbedOptions, totals: Totals): Promise<EmbedResult> {
    const embedding = target.embedding as EmbeddingConfig;
    const prefix = opts.kind === "query" ? embedding.queryPrefix : embedding.documentPrefix;
    const maxInputTokens = target.capabilities.maxInputTokens as number;
    const sent = texts.map((t) => prefix + t);

    // Over half the cap by estimate: alone, so its `prompt_tokens` is exact. The rest go in batches.
    const alone: number[] = [];
    const batches: number[][] = [];
    let batch: number[] = [];
    for (const [i, text] of sent.entries()) {
      if (estimateTokens(text) > maxInputTokens / 2) {
        alone.push(i);
        continue;
      }
      batch.push(i);
      if (batch.length === EMBED_BATCH) {
        batches.push(batch);
        batch = [];
      }
    }
    if (batch.length > 0) batches.push(batch);

    const vectors: number[][] = new Array(texts.length);
    const tokens: number[] = new Array(texts.length).fill(0);
    const run = async (indexes: number[]) => {
      const values = indexes.map((i) => sent[i] as string);
      const reply = await this.embedRequest(target, opts, values);
      totals.add(reply);
      const chars = values.reduce((n, v) => n + v.length, 0);
      for (const [n, i] of indexes.entries()) {
        const vector = reply.embeddings[n];
        if (vector?.length !== embedding.dimensions) {
          throw new LlmError("llm_endpoint_error", { dimensions: vector?.length ?? 0 });
        }
        vectors[i] = vector;
        tokens[i] = Math.round((reply.usage.inputTokens * (values[n] as string).length) / (chars || 1));
      }
    };
    for (const i of alone) {
      await run([i]);
      if ((tokens[i] as number) >= maxInputTokens) throw new LlmError("llm_embedding_truncated", { index: i });
    }
    await Promise.all(batches.map(run));
    return { vectors, tokens };
  }

  private async embedRequest(target: Target, opts: CallOptions, values: string[]) {
    const { provider, ctx } = this.context(target.endpoint);
    if (!provider.embeddingModel) throw new LlmError("llm_endpoint_error", { provider: provider.id });
    const model = provider.embeddingModel(ctx, target.model, target.params);
    const { result, queuedMs, latencyMs } = await this.dispatch(target.endpoint, opts, (signal) =>
      embedMany({ model, values, maxRetries: 0, abortSignal: signal }),
    );
    return {
      embeddings: result.embeddings,
      text: "",
      finishReason: null,
      usage: { inputTokens: result.usage.tokens, outputTokens: 0 },
      queuedMs,
      latencyMs,
    };
  }

  // ── Call log ───────────────────────────────────────────────────────

  /** One row per call (repairs counted in it). `failed` rows record why; the key is never in `target`'s log fields. */
  private async writeLog(e: LogEntry): Promise<string> {
    const id = newId();
    const bodies = e.target.role !== null && logsBodies(e.target.role);
    await this.db.insert(LlmCallLog).values({
      id,
      endpointId: e.target.endpoint.id,
      model: e.target.model,
      role: e.target.role,
      kind: e.opts.evalRunId ? "eval" : "call",
      promptId: e.prompt?.promptId ?? null,
      promptVersion: e.prompt?.version ?? null,
      promptFile: e.prompt?.file ?? null,
      mode: e.mode,
      finishReason: e.finishReason ?? null,
      outcome: e.outcome,
      errorCode: errorCodeOf(e.error),
      repairAttempts: e.repairAttempts ?? 0,
      normalizationFixes: e.fixes ?? [],
      usage: e.usage ?? NO_USAGE,
      queuedMs: e.queuedMs ?? 0,
      latencyMs: e.latencyMs ?? 0,
      actorId: e.opts.userId ?? null,
      evalRunId: e.opts.evalRunId ?? null,
      requestBody: bodies ? (e.requestBody ?? null) : null,
      responseBody: bodies ? (e.responseBody ?? null) : null,
    });
    return id;
  }
}

/** A request to the model: what's sent, in the form the log stores too. */
interface Request {
  mode: StructuredMode;
  schema: Record<string, unknown>;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
}

/** The JSON part of a streamed reply so far: after any `<think>` block, from the first bracket. */
function jsonPart(text: string): string | undefined {
  const body = text.replace(/<think>[\s\S]*?(<\/think>|$)/i, "");
  const start = body.search(/[{[]/);
  return start === -1 ? undefined : body.slice(start);
}

export function createLlmRuntime(deps: RuntimeDeps): Runtime {
  return new Runtime(deps);
}
