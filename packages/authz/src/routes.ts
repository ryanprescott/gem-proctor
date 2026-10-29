import type { ContractId } from "@gem/shared/contracts";

/**
 * Per-route permission declarations (SPEC §5.2). Every API route must have one; a route without a
 * declaration fails the startup check. `resource` names how the preHandler finds the caller's
 * relationship to the target (`owner` / `none`).
 */
export type ObjType = "session" | "import" | "test" | "user" | "settings" | "audit_log" | "practice_attempt";
export type Act = "read" | "delete" | "preview" | "create" | "list" | "update" | "export" | "submit";

/**
 * `resource: "practice_attempt"` loads the attempt by `(id, userId = caller)` (P1.md §5): someone else's
 * attempt is not found, for every caller, admins included.
 */
export type RoutePermission = { public: true } | { objType: ObjType; act: Act; resource?: "test" | "practice_attempt" };

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
} as const satisfies Record<ContractId, RoutePermission>;

export function permissionFor(id: string): RoutePermission | undefined {
  return (ROUTE_PERMISSIONS as Record<string, RoutePermission>)[id];
}
