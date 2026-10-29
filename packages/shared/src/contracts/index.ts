import { z } from "zod";
import { ImportReport } from "../import.ts";
import { QuizShape, TestType } from "../quiz.ts";

/**
 * API contracts for every P0 route (P0 §6). The server registers routes from these, the web client
 * calls them through `api.call(contract, input)`. All paths are under `/api/v1`.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ResponseKind = "json" | "text";

export interface Contract<
  Id extends string = string,
  P extends z.ZodType = z.ZodType,
  Q extends z.ZodType = z.ZodType,
  B extends z.ZodType = z.ZodType,
  R extends z.ZodType = z.ZodType,
> {
  id: Id;
  method: HttpMethod;
  path: string;
  params?: P;
  query?: Q;
  body?: B;
  response: R;
  /** `text` responses (CSV, exported JSON files) are returned verbatim. */
  responseKind?: ResponseKind;
}

function contract<
  const Id extends string,
  P extends z.ZodType = z.ZodNever,
  Q extends z.ZodType = z.ZodNever,
  B extends z.ZodType = z.ZodNever,
  R extends z.ZodType = z.ZodType,
>(c: Contract<Id, P, Q, B, R>): Contract<Id, P, Q, B, R> {
  return c;
}

export type ContractInput<C> =
  C extends Contract<string, infer P, infer Q, infer B, z.ZodType>
    ? ([P] extends [z.ZodNever] ? unknown : { params: z.input<P> }) &
        ([Q] extends [z.ZodNever] ? unknown : { query?: z.input<Q> }) &
        ([B] extends [z.ZodNever] ? unknown : { body: z.input<B> })
    : never;

export type ContractOutput<C> =
  C extends Contract<string, z.ZodType, z.ZodType, z.ZodType, infer R> ? z.output<R> : never;

// ── Shared shapes ────────────────────────────────────────────────────

export const ROLES = ["student", "proctor", "admin"] as const;
export const Role = z.enum(ROLES);
export type Role = z.infer<typeof Role>;

/** The highest role a user holds (roles form a hierarchy, SPEC §5.1). */
export function highestRole(roles: readonly Role[]): Role {
  if (roles.includes("admin")) return "admin";
  if (roles.includes("proctor")) return "proctor";
  return "student";
}

export const Uuid = z.uuid();
const IdParams = z.object({ id: Uuid });

/** bcrypt's input limit is 72 bytes; longer inputs are rejected, never truncated (SPEC §5.3). */
export const PASSWORD_MAX_BYTES = 72;
export const PASSWORD_MIN_LENGTH = 8;
export const Email = z.email().max(254);
export const Password = z.string();

export const Me = z.object({
  id: Uuid,
  email: z.string(),
  displayName: z.string(),
  role: Role,
});
export type Me = z.infer<typeof Me>;

export const Ok = z.object({ ok: z.literal(true) });

const Iso = z.iso.datetime({ offset: true });

// ── Public ───────────────────────────────────────────────────────────

export const Health = z.object({
  ok: z.boolean(),
  db: z.object({ ok: z.boolean() }),
  queue: z.object({ ok: z.boolean(), lastHeartbeatAt: Iso.nullable() }),
  verify: z.object({ ok: z.boolean(), sympy: z.string().optional(), numpy: z.string().optional() }),
});
export type Health = z.infer<typeof Health>;

export const health = contract({ id: "health", method: "GET", path: "/health", response: Health });

export const register = contract({
  id: "auth.register",
  method: "POST",
  path: "/auth/register",
  body: z.object({ email: Email, password: Password, displayName: z.string().trim().min(1).max(100) }),
  response: z.object({ user: Me }),
});

export const login = contract({
  id: "auth.login",
  method: "POST",
  path: "/auth/login",
  body: z.object({ email: z.string().max(254), password: Password }),
  response: z.object({ user: Me }),
});

export const quizSchema = contract({
  id: "schema.quiz",
  method: "GET",
  path: "/schema/quiz.json",
  response: z.record(z.string(), z.unknown()),
});

export const resultSchema = contract({
  id: "schema.result",
  method: "GET",
  path: "/schema/result.json",
  response: z.record(z.string(), z.unknown()),
});

// ── Any signed-in user ───────────────────────────────────────────────

export const logout = contract({ id: "auth.logout", method: "POST", path: "/auth/logout", response: Ok });

export const me = contract({
  id: "auth.me",
  method: "GET",
  path: "/auth/me",
  response: z.object({ user: Me }),
});

// ── Imports (proctor+) ───────────────────────────────────────────────

/** Default import size limit (SPEC §3D.1): 2 MB. */
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;

export const ImportText = z.object({
  text: z.string(),
  filename: z.string().max(255).optional(),
});

export const ImportPreview = z.object({
  /** Normalized value, pretty-printed, for the editor. Null when no JSON could be recovered. */
  normalizedText: z.string().nullable(),
  quiz: QuizShape.nullable(),
  report: ImportReport,
});
export type ImportPreview = z.infer<typeof ImportPreview>;

export const importPreview = contract({
  id: "imports.preview",
  method: "POST",
  path: "/imports/preview",
  body: ImportText,
  response: ImportPreview,
});

export const importCreate = contract({
  id: "imports.create",
  method: "POST",
  path: "/imports",
  body: z.object({
    /** The text the user uploaded or pasted, kept for debugging (SPEC §3D.1 step 7). */
    originalText: z.string(),
    /** The (possibly edited) quiz text to save; normalized and validated again on the server. */
    text: z.string(),
    filename: z.string().max(255).optional(),
  }),
  response: z.object({ testId: Uuid, versionId: Uuid }),
});

// ── Tests (proctor+, owner or admin) ─────────────────────────────────

export const TestSummary = z.object({
  id: Uuid,
  title: z.string(),
  description: z.string().nullable(),
  tags: z.array(z.string()),
  ownerId: Uuid,
  ownerName: z.string(),
  createdAt: Iso,
  archivedAt: Iso.nullable(),
  questionCount: z.number().int(),
  latestVersion: z.number().int(),
});
export type TestSummary = z.infer<typeof TestSummary>;

export const TestVersionSummary = z.object({
  id: Uuid,
  versionNumber: z.number().int(),
  createdAt: Iso,
  publishedAt: Iso.nullable(),
  imported: z.boolean(),
});

export const testsList = contract({
  id: "tests.list",
  method: "GET",
  path: "/tests",
  query: z.object({ archived: z.enum(["include", "exclude", "only"]).default("exclude") }),
  response: z.object({ tests: z.array(TestSummary) }),
});

export const testsGet = contract({
  id: "tests.get",
  method: "GET",
  path: "/tests/:id",
  params: IdParams,
  response: z.object({
    test: TestSummary.extend({ testType: TestType.nullable() }),
    version: TestVersionSummary,
    content: QuizShape,
  }),
});

export const testsUpdate = contract({
  id: "tests.update",
  method: "PATCH",
  path: "/tests/:id",
  params: IdParams,
  body: z
    .object({
      title: z.string().trim().min(1).max(300).optional(),
      description: z.string().max(5000).nullable().optional(),
      tags: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
      archived: z.boolean().optional(),
    })
    .refine((b) => Object.keys(b).length > 0),
  response: z.object({ test: TestSummary }),
});

export const testsVersions = contract({
  id: "tests.versions",
  method: "GET",
  path: "/tests/:id/versions",
  params: IdParams,
  response: z.object({ versions: z.array(TestVersionSummary) }),
});

export const testsExport = contract({
  id: "tests.export",
  method: "GET",
  path: "/tests/:id/export",
  params: IdParams,
  query: z.object({ version: z.coerce.number().int().positive().optional() }),
  response: z.string(),
  responseKind: "text",
});

// ── Admin ────────────────────────────────────────────────────────────

export const AdminUser = z.object({
  id: Uuid,
  email: z.string(),
  displayName: z.string(),
  role: Role,
  createdAt: Iso,
  disabledAt: Iso.nullable(),
  lockedUntil: Iso.nullable(),
  failedLoginCount: z.number().int(),
});
export type AdminUser = z.infer<typeof AdminUser>;

export const adminUsers = contract({
  id: "admin.users",
  method: "GET",
  path: "/admin/users",
  response: z.object({ users: z.array(AdminUser) }),
});

export const adminSetRoles = contract({
  id: "admin.users.roles",
  method: "PUT",
  path: "/admin/users/:id/roles",
  params: IdParams,
  body: z.object({ role: Role }),
  response: z.object({ user: AdminUser }),
});

export const adminResetPassword = contract({
  id: "admin.users.resetPassword",
  method: "POST",
  path: "/admin/users/:id/reset-password",
  params: IdParams,
  body: z.object({ password: Password }),
  response: z.object({ user: AdminUser }),
});

export const adminDisableUser = contract({
  id: "admin.users.disable",
  method: "POST",
  path: "/admin/users/:id/disable",
  params: IdParams,
  body: z.object({ disabled: z.boolean() }),
  response: z.object({ user: AdminUser }),
});

export const InstanceSettings = z.object({
  selfRegistration: z.boolean(),
});
export type InstanceSettings = z.infer<typeof InstanceSettings>;

export const adminGetSettings = contract({
  id: "admin.settings.get",
  method: "GET",
  path: "/admin/settings",
  response: z.object({ settings: InstanceSettings }),
});

export const adminPutSettings = contract({
  id: "admin.settings.put",
  method: "PUT",
  path: "/admin/settings",
  body: InstanceSettings,
  response: z.object({ settings: InstanceSettings }),
});

export const AUDIT_ACTIONS = [
  "user.create",
  "role.grant",
  "role.revoke",
  "user.password_reset",
  "user.disable",
  "user.enable",
  "settings.update",
] as const;
export const AuditAction = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof AuditAction>;

export const AuditEntry = z.object({
  id: Uuid,
  at: Iso,
  actorId: Uuid.nullable(),
  actorEmail: z.string().nullable(),
  action: AuditAction,
  targetType: z.string(),
  targetId: z.string().nullable(),
  before: z.unknown(),
  after: z.unknown(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const AuditQuery = z.object({
  actorId: Uuid.optional(),
  action: AuditAction.optional(),
  from: Iso.optional(),
  to: Iso.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type AuditQuery = z.input<typeof AuditQuery>;

export const adminAuditLog = contract({
  id: "admin.auditLog",
  method: "GET",
  path: "/admin/audit-log",
  query: AuditQuery,
  response: z.object({ entries: z.array(AuditEntry), total: z.number().int() }),
});

export const adminAuditLogCsv = contract({
  id: "admin.auditLog.csv",
  method: "GET",
  path: "/admin/audit-log.csv",
  query: AuditQuery.omit({ limit: true, offset: true }),
  response: z.string(),
  responseKind: "text",
});

export const CONTRACTS = [
  health,
  register,
  login,
  quizSchema,
  resultSchema,
  logout,
  me,
  importPreview,
  importCreate,
  testsList,
  testsGet,
  testsUpdate,
  testsVersions,
  testsExport,
  adminUsers,
  adminSetRoles,
  adminResetPassword,
  adminDisableUser,
  adminGetSettings,
  adminPutSettings,
  adminAuditLog,
  adminAuditLogCsv,
] as const;

export type AnyContract = (typeof CONTRACTS)[number];
export type ContractId = AnyContract["id"];
