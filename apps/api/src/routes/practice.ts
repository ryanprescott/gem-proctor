import { AppError } from "@gem/shared";
import {
  practiceDiscard,
  practiceExport,
  practiceGet,
  practiceList,
  practiceSaveResponse,
  practiceSelfGrade,
  practiceStart,
  practiceSubmit,
} from "@gem/shared/contracts";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { route } from "../http/route.ts";

/**
 * Practice routes (P1.md §6). F2 registers them with their contracts and permission declarations, so the
 * startup checks and the authz matrix cover them; the handlers are built in F3.
 */
export function practiceRoutes(app: FastifyInstance, _ctx: AppContext) {
  const notBuilt = async (): Promise<never> => {
    throw new AppError("service_unavailable", { service: "practice" });
  };
  route(app, practiceStart, notBuilt);
  route(app, practiceList, notBuilt);
  route(app, practiceGet, notBuilt);
  route(app, practiceSaveResponse, notBuilt);
  route(app, practiceSelfGrade, notBuilt);
  route(app, practiceSubmit, notBuilt);
  route(app, practiceDiscard, notBuilt);
  route(app, practiceExport, notBuilt);
}
