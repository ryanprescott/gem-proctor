import type { ModelRole, NormalizationFix, StructuredMode } from "@gem/shared";
import type { z } from "zod";
import type { FailedItem, SalvageOption } from "./structured.ts";

export interface PromptMessage {
  role: "user" | "assistant";
  content: string;
}

/** `messages` follow the template's own messages (P1.5.md §5). */
export interface PromptInput {
  promptId: string;
  vars: Record<string, string>;
  messages?: PromptMessage[];
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResult<T> {
  value: T;
  endpointId: string;
  model: string;
  finishReason: string | null;
  usage: LlmUsage;
  repairAttempts: number;
  latencyMs: number;
  callLogId: string;
  promptVersion: string;
  mode: StructuredMode;
  normalizationFixes: NormalizationFix[];
  queuedMs: number;
  /** Set when salvage applied. */
  failedItems?: FailedItem[];
}

export interface CallOptions {
  /** Fair-queue key and the log's actor: the user, or nothing for jobs (`system`). */
  userId?: string;
  signal?: AbortSignal;
  /** Set by eval runs: the log's `kind` becomes `eval`. */
  evalRunId?: string;
}

export interface GenerateOptions extends CallOptions {
  /** Re-asks after invalid output; default 2. */
  maxRepairs?: number;
  salvage?: SalvageOption;
  /** The example shown to `prompt_only` models; by default one is derived from the schema. */
  example?: unknown;
}

export interface EmbedOptions extends CallOptions {
  kind: "query" | "document";
}

export interface EmbedResult {
  vectors: number[][];
  /** Tokens per input: exact for a text sent alone, otherwise its share of its batch. */
  tokens: number[];
}

export type LlmStream<T> = AsyncIterable<Partial<T>> & { final: Promise<LlmResult<T>> };

export interface LlmRuntime {
  generateObject<T>(
    role: ModelRole,
    schema: z.ZodType<T>,
    input: PromptInput,
    opts?: GenerateOptions,
  ): Promise<LlmResult<T>>;
  streamObject<T>(role: ModelRole, schema: z.ZodType<T>, input: PromptInput, opts?: GenerateOptions): LlmStream<T>;
  embed(texts: string[], opts: EmbedOptions): Promise<EmbedResult>;
}
