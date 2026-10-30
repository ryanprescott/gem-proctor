import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { LlmError } from "../errors.ts";
import type { DiscoveredModel, Provider, ProviderContext } from "./types.ts";
import { fetchWithParams } from "./types.ts";

function client(ctx: ProviderContext, params: Record<string, unknown>) {
  if (!ctx.baseUrl) throw new LlmError("llm_endpoint_error", { reason: "no_base_url" });
  return createOpenAICompatible({
    name: "gem",
    baseURL: ctx.baseUrl,
    apiKey: ctx.apiKey,
    supportsStructuredOutputs: true,
    fetch: fetchWithParams(params),
  });
}

async function getJson(url: string, ctx: ProviderContext, signal: AbortSignal, init?: RequestInit): Promise<unknown> {
  const headers: Record<string, string> = { ...(ctx.apiKey ? { authorization: `Bearer ${ctx.apiKey}` } : {}) };
  const res = await fetch(url, { ...init, signal, headers: { ...headers, ...(init?.headers as object) } });
  if (res.status === 404) return undefined;
  if (!res.ok) throw Object.assign(new Error("request failed"), { statusCode: res.status });
  return res.json();
}

/** The server's root: `baseUrl` without its `/v1`. */
const rootOf = (baseUrl: string) => baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");

const positiveInt = (v: unknown): number | null => (typeof v === "number" && v > 0 ? Math.floor(v) : null);

/** Per-`server` context reports (P1.5.md §5). Model behaviour is never a quirk: it lives in `params`. */
async function serverContext(ctx: ProviderContext, model: string, signal: AbortSignal): Promise<number | null> {
  const root = rootOf(ctx.baseUrl as string);
  if (ctx.server === "ollama") {
    const show = (await getJson(`${root}/api/show`, ctx, signal, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    })) as { parameters?: string; model_info?: Record<string, unknown> } | undefined;
    const fromParams = /^\s*num_ctx\s+(\d+)\s*$/m.exec(show?.parameters ?? "")?.[1];
    if (fromParams) return Number(fromParams);
    const info = Object.entries(show?.model_info ?? {}).find(([k]) => k.endsWith(".context_length"));
    return positiveInt(info?.[1]);
  }
  if (ctx.server === "llamacpp") {
    const props = (await getJson(`${root}/props`, ctx, signal)) as
      | { n_ctx?: number; default_generation_settings?: { n_ctx?: number } }
      | undefined;
    return positiveInt(props?.default_generation_settings?.n_ctx ?? props?.n_ctx);
  }
  if (ctx.server === "vllm") {
    const models = (await getJson(`${rootOf(ctx.baseUrl as string)}/v1/models`, ctx, signal)) as
      | { data?: { id: string; max_model_len?: number }[] }
      | undefined;
    return positiveInt(models?.data?.find((m) => m.id === model)?.max_model_len);
  }
  return null;
}

export const openaiCompatible: Provider = {
  id: "openai-compatible",
  chatModel: (ctx, model, params) => client(ctx, params).chatModel(model),
  embeddingModel: (ctx, model, params) => client(ctx, params).embeddingModel(model),
  reportedContext: serverContext,
  async discoverModels(ctx, signal) {
    const url = `${(ctx.baseUrl as string).replace(/\/+$/, "")}/models`;
    const body = (await getJson(url, ctx, signal)) as { data?: { id: string; max_model_len?: number }[] } | undefined;
    if (!Array.isArray(body?.data)) return undefined;
    return body.data.map((m): DiscoveredModel => ({ id: m.id, contextLength: positiveInt(m.max_model_len) }));
  },
};
