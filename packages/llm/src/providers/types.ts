import type { EndpointServer, ModelParams } from "@gem/shared";
import type { EmbeddingModel, LanguageModel } from "ai";

/** What an adapter needs from an endpoint. The key is decrypted just for the call and never logged. */
export interface ProviderEndpoint {
  baseUrl: string | null;
  server: EndpointServer | null;
}

export interface ProviderContext extends ProviderEndpoint {
  apiKey: string | undefined;
}

export interface DiscoveredModel {
  id: string;
  contextLength: number | null;
}

/** A provider is one file in the registry (P1.5.md §5). */
export interface Provider {
  id: string;
  /** `params` are merged into every request body unchanged. */
  chatModel(ctx: ProviderContext, model: string, params: ModelParams): LanguageModel;
  embeddingModel?(ctx: ProviderContext, model: string, params: ModelParams): EmbeddingModel;
  /** Undefined where the provider can't list models. */
  discoverModels?(ctx: ProviderContext, signal: AbortSignal): Promise<DiscoveredModel[] | undefined>;
  reportedContext?(ctx: ProviderContext, model: string, signal: AbortSignal): Promise<number | null>;
}

/** The adapters' common request hook: merges `params` into the JSON body, unchanged. */
export function fetchWithParams(params: ModelParams): typeof fetch {
  const wrapped = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (typeof init?.body !== "string" || Object.keys(params).length === 0) return fetch(input, init);
    return fetch(input, { ...init, body: JSON.stringify({ ...JSON.parse(init.body), ...params }) });
  };
  return wrapped as typeof fetch;
}
