import { AppError } from "@gem/shared";
import { CONTRACTS } from "@gem/shared/contracts";
import type { FastifyInstance } from "fastify";
import { route } from "../http/route.ts";

/** Registered so the startup checks and the authz matrix cover the LLM routes from F1; F3 adds the handlers. */
export function llmRoutes(app: FastifyInstance) {
  for (const contract of CONTRACTS) {
    if (!contract.id.startsWith("admin.llm.") && contract.id !== "llm.roles") continue;
    route(app, contract, async () => {
      throw new AppError("service_unavailable");
    });
  }
}
