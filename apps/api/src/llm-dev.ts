import { randomBytes } from "node:crypto";
import { encryptSecret } from "@gem/db";
import { createLlmRuntime, type LlmStore, type Target } from "@gem/llm";
import type { ModelRole } from "@gem/shared";
import type { Config } from "./config.ts";
import { devAssignments } from "./llm-seed.ts";

/** The `LLM_DEV_*` settings as a runtime that touches no database, for `llm:eval --dev` and `llm:live`. */

/** The dev key is encrypted like a stored one, under a key that lives for this run. */
const runKey = randomBytes(32).toString("base64");

function devStore(config: Config): LlmStore {
  const now = new Date();
  const targets = devAssignments(config).map(
    (a): Target => ({
      role: a.role,
      endpoint: {
        id: a.role,
        label: a.endpoint.label,
        provider: a.endpoint.provider,
        baseUrl: a.endpoint.baseUrl,
        apiKeyCiphertext: config.LLM_DEV_API_KEY ? encryptSecret(config.LLM_DEV_API_KEY, runKey, a.role) : null,
        location: a.endpoint.location,
        server: a.endpoint.server,
        concurrency: a.endpoint.concurrency,
        timeoutMs: a.endpoint.timeoutMs,
        createdBy: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
      model: a.model,
      capabilities: a.capabilities,
      embedding: a.embedding ?? null,
      params: a.params ?? {},
    }),
  );
  return {
    target: async (role: ModelRole) => targets.find((t) => t.role === role),
    localEndpointsOnly: async () => false,
    endpointsWithKeys: async () => [],
    log: async () => {},
  };
}

export function devRuntime(config: Config) {
  return createLlmRuntime({ store: devStore(config), secretKey: runKey });
}
