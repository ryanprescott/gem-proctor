import { createAnthropic } from "@ai-sdk/anthropic";
import type { Provider, ProviderContext } from "./types.ts";
import { fetchWithParams } from "./types.ts";

function client(ctx: ProviderContext, params: Record<string, unknown>) {
  return createAnthropic({
    apiKey: ctx.apiKey ?? "",
    ...(ctx.baseUrl ? { baseURL: ctx.baseUrl } : {}),
    fetch: fetchWithParams(params),
  });
}

export const anthropic: Provider = {
  id: "anthropic",
  chatModel: (ctx, model, params) => client(ctx, params).languageModel(model),
  async discoverModels(ctx, signal) {
    const base = (ctx.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/, "");
    const res = await fetch(`${base}/models`, {
      signal,
      headers: { "x-api-key": ctx.apiKey ?? "", "anthropic-version": "2023-06-01" },
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw Object.assign(new Error("request failed"), { statusCode: res.status });
    const body = (await res.json()) as { data?: { id: string; max_input_tokens?: number }[] };
    return body.data?.map((m) => ({ id: m.id, contextLength: m.max_input_tokens ?? null }));
  },
};
