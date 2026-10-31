import { z } from "zod";
import { ErrorCode } from "../errors.ts";
import { ImportReport } from "../import.ts";
import {
  EndpointCreate,
  EndpointPatch,
  EvalRunDetail,
  EvalRunRequest,
  EvalRunSummary,
  LlmEndpoint,
  LlmRoleStatus,
  ModelInfo,
  ModelRole,
  ProbeRequest,
  ProbeResult,
  RoleAssignmentBody,
  RoleAssignmentView,
  StatsRow,
} from "../llm.ts";
import { QuestionShape, QuizShape, TestType } from "../quiz.ts";
import { GRADE_OUTCOMES } from "../result.ts";
import { AuthoringSettings, EmbedError, SourceEmbedStatus, SourceFormat, SourcePreview } from "../sources.ts";
import { ProctorBlocker, VerificationItem, VerificationSummary, VerifySettings } from "../verification.ts";

/**
 * API contracts for every route (P0 §6, P1 §6, P1.5 §6). The server registers routes from these, the web client
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
    /** The job whose results go on the saved questions (P2.1.md §5). */
    verificationJobId: Uuid.optional(),
    /** Suggested fixes the creator confirmed. Nothing else ever applies one. */
    acceptedFixes: z.array(z.object({ questionId: z.number().int(), correctAnswer: z.string() })).optional(),
  }),
  response: z.object({ testId: Uuid, versionId: Uuid }),
});

/** How many questions one verification job may hold: each costs model calls. */
export const VERIFY_MAX_QUESTIONS = 200;

export const VERIFICATION_JOB_STATUSES = ["queued", "running", "done", "failed"] as const;
export const VerificationJobStatus = z.enum(VERIFICATION_JOB_STATUSES);

export const importVerifyStart = contract({
  id: "imports.verify.start",
  method: "POST",
  path: "/imports/verify",
  /** The normalized value: questions that failed `Quiz` validation are checked too (SPEC §3D.1 step 4). */
  body: z.object({ value: z.looseObject({ questions: z.array(z.unknown()).min(1).max(VERIFY_MAX_QUESTIONS) }) }),
  response: z.object({ job: z.object({ id: Uuid, status: VerificationJobStatus }) }),
});

export const VerificationJobView = z.object({
  id: Uuid,
  status: VerificationJobStatus,
  items: z.array(VerificationItem),
  summary: VerificationSummary.nullable(),
  errorCode: ErrorCode.nullable(),
  createdAt: Iso,
  startedAt: Iso.nullable(),
  finishedAt: Iso.nullable(),
});
export type VerificationJobView = z.infer<typeof VerificationJobView>;

export const importVerifyGet = contract({
  id: "imports.verify.get",
  method: "GET",
  path: "/imports/verify/:id",
  params: IdParams,
  response: z.object({ job: VerificationJobView }),
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
  /** Whether a proctored assignment could use this version (SPEC §3A.3.1; P3 enforces it). */
  proctorReady: z.boolean(),
  blockers: z.array(ProctorBlocker),
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
  /** While on, no role may use a `cloud` endpoint (SPEC §3B.2). */
  localEndpointsOnly: z.boolean(),
  verify: VerifySettings,
  authoring: AuthoringSettings,
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
  /** A setting left out keeps its value. */
  body: InstanceSettings.partial({ localEndpointsOnly: true, verify: true, authoring: true }).extend({
    verify: VerifySettings.partial().optional(),
    authoring: AuthoringSettings.partial().optional(),
  }),
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
  "llm.endpoint.create",
  "llm.endpoint.update",
  "llm.endpoint.delete",
  "llm.endpoint.secret_change",
  "llm.role.assign",
  "llm.role.unassign",
  "verify.sandbox_denial",
  "source.create",
  "source.delete",
  "authoring_session.create",
  "authoring_session.delete",
] as const;
export const AuditAction = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof AuditAction>;

export const AUDIT_TARGETS = [
  "user",
  "settings",
  "llm_endpoint",
  "llm_role",
  "verification_job",
  "question",
  "source",
  "authoring_session",
] as const;

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

// ── Practice (proctor+, own attempts only; P1 §6) ────────────────────

export const PRACTICE_KINDS = ["full", "retake_missed"] as const;
export const PracticeKind = z.enum(PRACTICE_KINDS);
export type PracticeKind = z.infer<typeof PracticeKind>;

export const GradeOutcome = z.enum(GRADE_OUTCOMES);

/** Upper bounds keep a single response small; real answers are far shorter. */
export const PRACTICE_ANSWER_MAX_LENGTH = 10_000;
export const PracticeAnswer = z.union([
  z.string().max(PRACTICE_ANSWER_MAX_LENGTH),
  z.array(z.string().max(PRACTICE_ANSWER_MAX_LENGTH)).max(100),
]);
export type PracticeAnswer = z.infer<typeof PracticeAnswer>;

export const PracticeAttemptSummary = z.object({
  id: Uuid,
  testId: Uuid,
  testTitle: z.string(),
  testVersionId: Uuid,
  versionNumber: z.number().int(),
  kind: PracticeKind,
  status: z.enum(["in_progress", "submitted"]),
  startedAt: Iso,
  submittedAt: Iso.nullable(),
  durationMs: z.number().int().nullable(),
  /** Null until submit. Includes self-graded points. */
  score: z.number().nullable(),
  maxScore: z.number(),
  questionCount: z.number().int(),
});
export type PracticeAttemptSummary = z.infer<typeof PracticeAttemptSummary>;

export const PracticeResponse = z.object({
  questionId: z.number().int(),
  answer: PracticeAnswer.nullable(),
  /** Null until the answer is checked (or graded at submit); a checked answer is locked. */
  autoResult: GradeOutcome.nullable(),
  pointsAwarded: z.number(),
  maxPoints: z.number(),
  selfGraded: z.boolean(),
  flagged: z.boolean(),
  answeredAt: Iso.nullable(),
  timeSpentMs: z.number().int(),
});
export type PracticeResponse = z.infer<typeof PracticeResponse>;

/** The server's grade for a checked answer, with what the feedback shows (SPEC §6). */
export const PracticeFeedback = z.object({
  outcome: GradeOutcome,
  pointsAwarded: z.number(),
  maxPoints: z.number(),
  correctAnswer: z.string(),
  correctAnswers: z.array(z.string()).optional(),
  explanation: z.string().optional(),
});
export type PracticeFeedback = z.infer<typeof PracticeFeedback>;

export const PracticeAttemptDetail = z.object({
  attempt: PracticeAttemptSummary,
  quiz: z.object({
    title: z.string(),
    course: z.string().optional(),
    chapter: z.number().int().optional(),
    topicsCovered: z.array(z.string()),
  }),
  /** In display (seeded) order, options shuffled; practice includes answers and explanations (SPEC §6). */
  questions: z.array(QuestionShape),
  /** The same question ids in the test's own order (for the topic breakdown and the export). */
  quizOrder: z.array(z.number().int()),
  /** One per question of the attempt, in display order. */
  responses: z.array(PracticeResponse),
});
export type PracticeAttemptDetail = z.infer<typeof PracticeAttemptDetail>;

const AttemptParams = z.object({ id: Uuid });
const ResponseParams = z.object({ id: Uuid, questionId: z.coerce.number().int().positive() });

export const practiceStart = contract({
  id: "practice.start",
  method: "POST",
  path: "/practice/attempts",
  body: z.object({ testId: Uuid, kind: PracticeKind }),
  response: z.object({ attempt: PracticeAttemptSummary }),
});

export const practiceList = contract({
  id: "practice.list",
  method: "GET",
  path: "/practice/attempts",
  query: z.object({
    testId: Uuid.optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  }),
  response: z.object({
    /** Newest first. */
    attempts: z.array(PracticeAttemptSummary),
    /**
     * With `testId`: how many questions "Retake missed" would include (from the most recent submitted
     * attempt); null when there is no submitted attempt.
     */
    missedCount: z.number().int().nullable(),
  }),
});

export const practiceGet = contract({
  id: "practice.get",
  method: "GET",
  path: "/practice/attempts/:id",
  params: AttemptParams,
  response: PracticeAttemptDetail,
});

export const practiceSaveResponse = contract({
  id: "practice.saveResponse",
  method: "PUT",
  path: "/practice/attempts/:id/responses/:questionId",
  params: ResponseParams,
  body: z
    .object({
      answer: PracticeAnswer.optional(),
      /** Grade the answer now and lock it (immediate feedback). */
      check: z.literal(true).optional(),
      flagged: z.boolean().optional(),
      /** Cumulative time on this question; the server keeps the maximum, capped at the time since start. */
      timeSpentMs: z.number().int().min(0).optional(),
    })
    .refine((b) => Object.keys(b).length > 0),
  response: z.object({ response: PracticeResponse, feedback: PracticeFeedback.nullable() }),
});

export const practiceSelfGrade = contract({
  id: "practice.selfGrade",
  method: "POST",
  path: "/practice/attempts/:id/responses/:questionId/self-grade",
  params: ResponseParams,
  body: z.object({ right: z.boolean() }),
  response: z.object({ response: PracticeResponse, attempt: PracticeAttemptSummary }),
});

export const practiceSubmit = contract({
  id: "practice.submit",
  method: "POST",
  path: "/practice/attempts/:id/submit",
  params: AttemptParams,
  response: z.object({ attempt: PracticeAttemptSummary }),
});

export const practiceDiscard = contract({
  id: "practice.discard",
  method: "DELETE",
  path: "/practice/attempts/:id",
  params: AttemptParams,
  response: Ok,
});

export const practiceExport = contract({
  id: "practice.export",
  method: "GET",
  path: "/practice/attempts/:id/export",
  params: AttemptParams,
  response: z.string(),
  responseKind: "text",
});

// ── LLM (admin only, except role status; P1.5 §6) ────────────────────

const EndpointResponse = z.object({ endpoint: LlmEndpoint });

export const adminLlmEndpointsList = contract({
  id: "admin.llm.endpoints.list",
  method: "GET",
  path: "/admin/llm/endpoints",
  response: z.object({
    endpoints: z.array(LlmEndpoint),
    /** The registered provider adapters. */
    providers: z.array(z.string()),
  }),
});

export const adminLlmEndpointsCreate = contract({
  id: "admin.llm.endpoints.create",
  method: "POST",
  path: "/admin/llm/endpoints",
  body: EndpointCreate,
  response: EndpointResponse,
});

export const adminLlmEndpointsGet = contract({
  id: "admin.llm.endpoints.get",
  method: "GET",
  path: "/admin/llm/endpoints/:id",
  params: IdParams,
  response: EndpointResponse,
});

export const adminLlmEndpointsUpdate = contract({
  id: "admin.llm.endpoints.update",
  method: "PATCH",
  path: "/admin/llm/endpoints/:id",
  params: IdParams,
  body: EndpointPatch,
  response: EndpointResponse,
});

export const adminLlmEndpointsDelete = contract({
  id: "admin.llm.endpoints.delete",
  method: "DELETE",
  path: "/admin/llm/endpoints/:id",
  params: IdParams,
  response: Ok,
});

export const adminLlmEndpointsModels = contract({
  id: "admin.llm.endpoints.models",
  method: "GET",
  path: "/admin/llm/endpoints/:id/models",
  params: IdParams,
  response: z.object({ models: z.array(ModelInfo) }),
});

export const adminLlmEndpointsProbe = contract({
  id: "admin.llm.endpoints.probe",
  method: "POST",
  path: "/admin/llm/endpoints/:id/probe",
  params: IdParams,
  body: ProbeRequest,
  response: ProbeResult,
});

const RoleParams = z.object({ role: ModelRole });

export const adminLlmRolesList = contract({
  id: "admin.llm.roles.list",
  method: "GET",
  path: "/admin/llm/roles",
  response: z.object({ roles: z.array(RoleAssignmentView) }),
});

export const adminLlmRolesPut = contract({
  id: "admin.llm.roles.put",
  method: "PUT",
  path: "/admin/llm/roles/:role",
  params: RoleParams,
  body: RoleAssignmentBody,
  response: z.object({ role: RoleAssignmentView }),
});

export const adminLlmRolesDelete = contract({
  id: "admin.llm.roles.delete",
  method: "DELETE",
  path: "/admin/llm/roles/:role",
  params: RoleParams,
  response: Ok,
});

export const adminLlmStats = contract({
  id: "admin.llm.stats",
  method: "GET",
  path: "/admin/llm/stats",
  query: z.object({ since: Iso.optional() }),
  response: z.object({ rows: z.array(StatsRow) }),
});

export const adminLlmEvalsRun = contract({
  id: "admin.llm.evals.run",
  method: "POST",
  path: "/admin/llm/evals/run",
  body: EvalRunRequest,
  response: z.object({ run: EvalRunSummary }),
});

export const adminLlmEvalsList = contract({
  id: "admin.llm.evals.list",
  method: "GET",
  path: "/admin/llm/evals",
  query: z.object({ role: ModelRole.optional() }),
  response: z.object({
    /** Newest first. */
    runs: z.array(EvalRunSummary),
    /** The eval sets that can be run. */
    evalSets: z.array(z.string()),
  }),
});

export const adminLlmEvalsGet = contract({
  id: "admin.llm.evals.get",
  method: "GET",
  path: "/admin/llm/evals/:id",
  params: IdParams,
  response: z.object({ run: EvalRunDetail }),
});

export const llmRoles = contract({
  id: "llm.roles",
  method: "GET",
  path: "/llm/roles",
  response: z.object({ roles: z.array(LlmRoleStatus) }),
});

// ── Sources (proctor+, owner or admin; P2 §6) ────────────────────────

export const SOURCE_TITLE_MAX = 300;
export const SOURCE_LABEL_MAX = 60;

const SourceMeta = z.object({
  title: z.string().trim().min(1).max(SOURCE_TITLE_MAX),
  /** Short, e.g. "VMLS": shown in citations, and it fills `course` on generated quizzes. */
  citationLabel: z.string().trim().min(1).max(SOURCE_LABEL_MAX),
  author: z.string().trim().max(300).optional(),
  edition: z.string().trim().max(100).optional(),
  url: z.url().max(2000).optional(),
});

/** `text` is pasted, or read from an upload (`filename` says which kind it is). Checked against the instance cap. */
const SourceText = z.object({
  text: z.string(),
  filename: z.string().max(255).optional(),
  format: SourceFormat.optional(),
});

export const SourceRevisionView = z.object({
  id: Uuid,
  number: z.number().int(),
  format: SourceFormat,
  embedStatus: SourceEmbedStatus,
  embedError: EmbedError.nullable(),
  chunks: z.number().int(),
  embedded: z.number().int(),
  tokens: z.number().int(),
  flagged: z.number().int(),
  createdAt: Iso,
});
export type SourceRevisionView = z.infer<typeof SourceRevisionView>;

export const SourceSummary = z.object({
  id: Uuid,
  title: z.string(),
  citationLabel: z.string(),
  author: z.string().nullable(),
  edition: z.string().nullable(),
  url: z.string().nullable(),
  ownerId: Uuid,
  createdAt: Iso,
  latest: SourceRevisionView,
  /** Its latest revision is `ready` (P2.md §4). */
  usable: z.boolean(),
});
export type SourceSummary = z.infer<typeof SourceSummary>;

export const SourceSectionView = z.object({
  id: Uuid,
  parentId: Uuid.nullable(),
  level: z.number().int(),
  title: z.string(),
  order: z.number().int(),
  headingPath: z.array(z.string()),
  chunks: z.number().int(),
  tokens: z.number().int(),
});
export type SourceSectionView = z.infer<typeof SourceSectionView>;

export const SourceChunkView = z.object({
  id: Uuid,
  chunkKey: z.string(),
  sectionId: Uuid,
  headingPath: z.array(z.string()),
  charStart: z.number().int(),
  charEnd: z.number().int(),
  text: z.string(),
  tokenCount: z.number().int(),
  embedded: z.boolean(),
  flaggedAt: Iso.nullable(),
  flagReason: z.string().nullable(),
});
export type SourceChunkView = z.infer<typeof SourceChunkView>;

const RevisionQuery = z.object({ revision: z.coerce.number().int().positive().optional() });

export const sourcesPreview = contract({
  id: "sources.preview",
  method: "POST",
  path: "/sources/preview",
  body: SourceText.extend({ title: z.string().max(SOURCE_TITLE_MAX).optional() }),
  response: SourcePreview,
});

export const sourcesCreate = contract({
  id: "sources.create",
  method: "POST",
  path: "/sources",
  body: SourceMeta.extend(SourceText.shape),
  response: z.object({ source: SourceSummary }),
});

export const sourcesList = contract({
  id: "sources.list",
  method: "GET",
  path: "/sources",
  response: z.object({ sources: z.array(SourceSummary) }),
});

export const sourcesGet = contract({
  id: "sources.get",
  method: "GET",
  path: "/sources/:id",
  params: IdParams,
  response: z.object({ source: SourceSummary, revisions: z.array(SourceRevisionView) }),
});

export const sourcesUpdate = contract({
  id: "sources.update",
  method: "PUT",
  path: "/sources/:id",
  params: IdParams,
  body: SourceMeta.partial().extend(SourceText.shape),
  response: z.object({ source: SourceSummary }),
});

export const sourcesDelete = contract({
  id: "sources.delete",
  method: "DELETE",
  path: "/sources/:id",
  params: IdParams,
  response: Ok,
});

export const sourcesRevision = contract({
  id: "sources.revision",
  method: "GET",
  path: "/sources/:id/revisions/:n",
  params: z.object({ id: Uuid, n: z.coerce.number().int().positive() }),
  response: z.object({ revision: SourceRevisionView, markdown: z.string() }),
});

export const sourcesSections = contract({
  id: "sources.sections",
  method: "GET",
  path: "/sources/:id/sections",
  params: IdParams,
  query: RevisionQuery,
  response: z.object({ sections: z.array(SourceSectionView) }),
});

export const sourcesChunks = contract({
  id: "sources.chunks",
  method: "GET",
  path: "/sources/:id/chunks",
  params: IdParams,
  query: RevisionQuery.extend({
    /** Comma-separated. */
    sectionIds: z.string().max(40_000).optional(),
    flagged: z.enum(["true", "false"]).optional(),
  }),
  response: z.object({ chunks: z.array(SourceChunkView) }),
});

export const sourcesEmbedRetry = contract({
  id: "sources.embedRetry",
  method: "POST",
  path: "/sources/:id/embed:retry",
  params: IdParams,
  response: z.object({ source: SourceSummary }),
});

/** `once`: send the current state and close, for a client that can't hold a stream. */
export const EventsQuery = z.object({ once: z.enum(["true"]).optional() });

/** Server-sent events: the source's state at once, and again on every change. */
export const sourcesEvents = contract({
  id: "sources.events",
  method: "GET",
  path: "/sources/:id/events",
  params: IdParams,
  query: EventsQuery,
  response: z.string(),
  responseKind: "text",
});

export const CONTRACTS = [
  sourcesPreview,
  sourcesCreate,
  sourcesList,
  sourcesGet,
  sourcesUpdate,
  sourcesDelete,
  sourcesRevision,
  sourcesSections,
  sourcesChunks,
  sourcesEmbedRetry,
  sourcesEvents,
  health,
  register,
  login,
  quizSchema,
  resultSchema,
  logout,
  me,
  importPreview,
  importCreate,
  importVerifyStart,
  importVerifyGet,
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
  practiceStart,
  practiceList,
  practiceGet,
  practiceSaveResponse,
  practiceSelfGrade,
  practiceSubmit,
  practiceDiscard,
  practiceExport,
  adminLlmEndpointsList,
  adminLlmEndpointsCreate,
  adminLlmEndpointsGet,
  adminLlmEndpointsUpdate,
  adminLlmEndpointsDelete,
  adminLlmEndpointsModels,
  adminLlmEndpointsProbe,
  adminLlmRolesList,
  adminLlmRolesPut,
  adminLlmRolesDelete,
  adminLlmStats,
  adminLlmEvalsRun,
  adminLlmEvalsList,
  adminLlmEvalsGet,
  llmRoles,
] as const;

export type AnyContract = (typeof CONTRACTS)[number];
export type ContractId = AnyContract["id"];
