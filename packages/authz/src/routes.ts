import type { ContractId } from "@gem/shared/contracts";

/**
 * Per-route permission declarations (SPEC §5.2). Every API route must have one; a route without a
 * declaration fails the startup check. `resource` names how the preHandler finds the caller's
 * relationship to the target (`owner` / `none`).
 */
export type ObjType =
  | "session"
  | "import"
  | "test"
  | "user"
  | "settings"
  | "audit_log"
  | "practice_attempt"
  | "llm_endpoint"
  | "llm_role"
  | "llm_eval"
  | "llm_stats"
  | "llm_status"
  | "verification_job"
  | "source";
export type Act = "read" | "delete" | "preview" | "create" | "list" | "update" | "export" | "submit" | "run";

/**
 * `resource: "practice_attempt"` loads the attempt by `(id, userId = caller)` (P1.md §5): someone else's
 * attempt is not found, for every caller, admins included. `resource: "source"` is private the same way, except
 * that an admin may reach any (P2.md §5): another proctor gets 404, not 403.
 */
export type RoutePermission =
  | { public: true }
  | { objType: ObjType; act: Act; resource?: "test" | "practice_attempt" | "verification_job" | "source" };

export const ROUTE_PERMISSIONS = {
  health: { public: true },
  "auth.register": { public: true },
  "auth.login": { public: true },
  "schema.quiz": { public: true },
  "schema.result": { public: true },

  "auth.logout": { objType: "session", act: "delete" },
  "auth.me": { objType: "session", act: "read" },

  "imports.preview": { objType: "import", act: "preview" },
  "imports.create": { objType: "import", act: "create" },
  "imports.verify.start": { objType: "verification_job", act: "create" },
  "imports.verify.get": { objType: "verification_job", act: "read", resource: "verification_job" },
  "sources.preview": { objType: "source", act: "preview" },
  "sources.create": { objType: "source", act: "create" },
  "sources.list": { objType: "source", act: "list" },
  "sources.get": { objType: "source", act: "read", resource: "source" },
  "sources.update": { objType: "source", act: "update", resource: "source" },
  "sources.delete": { objType: "source", act: "delete", resource: "source" },
  "sources.revision": { objType: "source", act: "read", resource: "source" },
  "sources.sections": { objType: "source", act: "read", resource: "source" },
  "sources.chunks": { objType: "source", act: "read", resource: "source" },
  "sources.embedRetry": { objType: "source", act: "update", resource: "source" },
  "sources.events": { objType: "source", act: "read", resource: "source" },
  "tests.list": { objType: "test", act: "list" },
  "tests.get": { objType: "test", act: "read", resource: "test" },
  "tests.update": { objType: "test", act: "update", resource: "test" },
  "tests.versions": { objType: "test", act: "read", resource: "test" },
  "tests.export": { objType: "test", act: "export", resource: "test" },

  "admin.users": { objType: "user", act: "list" },
  "admin.users.roles": { objType: "user", act: "update" },
  "admin.users.resetPassword": { objType: "user", act: "update" },
  "admin.users.disable": { objType: "user", act: "update" },
  "admin.settings.get": { objType: "settings", act: "read" },
  "admin.settings.put": { objType: "settings", act: "update" },
  "admin.auditLog": { objType: "audit_log", act: "list" },
  "admin.auditLog.csv": { objType: "audit_log", act: "export" },

  // Starting also checks `test` / `practice` on the test in the body (its owner, or an admin).
  "practice.start": { objType: "practice_attempt", act: "create" },
  "practice.list": { objType: "practice_attempt", act: "list" },
  "practice.get": { objType: "practice_attempt", act: "read", resource: "practice_attempt" },
  "practice.saveResponse": { objType: "practice_attempt", act: "update", resource: "practice_attempt" },
  "practice.selfGrade": { objType: "practice_attempt", act: "update", resource: "practice_attempt" },
  "practice.submit": { objType: "practice_attempt", act: "submit", resource: "practice_attempt" },
  "practice.discard": { objType: "practice_attempt", act: "delete", resource: "practice_attempt" },
  "practice.export": { objType: "practice_attempt", act: "export", resource: "practice_attempt" },

  // Admin only, through the `*` policy line (P1.5.md §6).
  "admin.llm.endpoints.list": { objType: "llm_endpoint", act: "list" },
  "admin.llm.endpoints.create": { objType: "llm_endpoint", act: "create" },
  "admin.llm.endpoints.get": { objType: "llm_endpoint", act: "read" },
  "admin.llm.endpoints.update": { objType: "llm_endpoint", act: "update" },
  "admin.llm.endpoints.delete": { objType: "llm_endpoint", act: "delete" },
  "admin.llm.endpoints.models": { objType: "llm_endpoint", act: "read" },
  "admin.llm.endpoints.probe": { objType: "llm_endpoint", act: "run" },
  "admin.llm.roles.list": { objType: "llm_role", act: "list" },
  "admin.llm.roles.put": { objType: "llm_role", act: "update" },
  "admin.llm.roles.delete": { objType: "llm_role", act: "delete" },
  "admin.llm.stats": { objType: "llm_stats", act: "read" },
  "admin.llm.evals.run": { objType: "llm_eval", act: "run" },
  "admin.llm.evals.list": { objType: "llm_eval", act: "list" },
  "admin.llm.evals.get": { objType: "llm_eval", act: "read" },

  // Any signed-in user: which roles are assigned, for hiding features and the cloud notice (SPEC §8.1).
  "llm.roles": { objType: "llm_status", act: "read" },
} as const satisfies Record<ContractId, RoutePermission>;

export function permissionFor(id: string): RoutePermission | undefined {
  return (ROUTE_PERMISSIONS as Record<string, RoutePermission>)[id];
}
