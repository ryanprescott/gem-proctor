import { LlmError } from "../errors.ts";
import { anthropic } from "./anthropic.ts";
import { openaiCompatible } from "./openai-compatible.ts";
import type { Provider } from "./types.ts";

/** The provider registry: adding a provider is one file and one line here (P1.5.md §5). */
export const PROVIDERS: readonly Provider[] = [openaiCompatible, anthropic];

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

export function providerFor(id: string): Provider {
  const provider = PROVIDERS.find((p) => p.id === id);
  if (!provider) throw new LlmError("llm_endpoint_error", { provider: id });
  return provider;
}
