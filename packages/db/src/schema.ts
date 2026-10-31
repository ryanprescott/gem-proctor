import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * P0 tables (P0.md §4), P1's practice tables (P1.md §4), P1.5's LLM tables (P1.5.md §4) and P2.1's verification
 * tables (P2.1.md §4), from SPEC §10. Postgres names are snake_case; TypeScript names follow SPEC §10.
 * Ids are UUID v7, generated in the app.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const User = pgTable(
  "user",
  {
    id: uuid("id").primaryKey(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    disabledAt: ts("disabled_at"),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: ts("locked_until"),
  },
  (t) => [uniqueIndex("user_email_unique").on(sql`lower(${t.email})`)],
);

export const UserSession = pgTable(
  "user_session",
  {
    /** sha256 of the cookie token; the token itself is never stored. */
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => User.id, { onDelete: "cascade" }),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    userAgent: text("user_agent"),
  },
  (t) => [index("user_session_user_idx").on(t.userId)],
);

/** Casbin adapter table. Only `g` lines (user → role grants) live here; the policy is a file (SPEC §5.2). */
export const casbinRule = pgTable(
  "casbin_rule",
  {
    id: serial("id").primaryKey(),
    ptype: text("ptype").notNull(),
    v0: text("v0"),
    v1: text("v1"),
    v2: text("v2"),
    v3: text("v3"),
    v4: text("v4"),
    v5: text("v5"),
  },
  (t) => [uniqueIndex("casbin_rule_unique").on(t.ptype, t.v0, t.v1)],
);

export const InstanceSettings = pgTable("instance_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: uuid("updated_by").references(() => User.id),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const Test = pgTable(
  "test",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => User.id),
    title: text("title").notNull(),
    description: text("description"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    createdAt: ts("created_at").notNull().defaultNow(),
    archivedAt: ts("archived_at"),
    /** Set for tests published from authoring (P2). No FK yet: that table doesn't exist in P0. */
    authoringSessionId: uuid("authoring_session_id"),
  },
  (t) => [index("test_owner_idx").on(t.ownerId)],
);

export const TestVersion = pgTable(
  "test_version",
  {
    id: uuid("id").primaryKey(),
    testId: uuid("test_id")
      .notNull()
      .references(() => Test.id),
    versionNumber: integer("version_number").notNull(),
    /** Extended Quiz (SPEC §4). Source of truth for the questions. */
    content: jsonb("content").notNull(),
    /** Frozen authoring trail (SPEC §3A.1). Null for imports. */
    provenance: jsonb("provenance"),
    publishedAt: ts("published_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("test_version_number_unique").on(t.testId, t.versionNumber)],
);

export const TestImportRecord = pgTable("test_import_record", {
  id: uuid("id").primaryKey(),
  testVersionId: uuid("test_version_id")
    .notNull()
    .unique()
    .references(() => TestVersion.id),
  originalFilename: text("original_filename"),
  sourceRaw: text("source_raw").notNull(),
  /** The import report, including the normalization fixes. */
  report: jsonb("report").notNull(),
});

/**
 * Append-only (SPEC §1.3). The app's DB user has only INSERT/SELECT on this table (grants migration).
 * `actor_id` has no FK, so no referential action could ever need to update a row.
 */
export const AuditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey(),
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_at_idx").on(t.at),
    index("audit_log_actor_idx").on(t.actorId),
    index("audit_log_action_idx").on(t.action),
  ],
);

// ── Practice (P1.md §4) ──────────────────────────────────────────────

/** Points are stored as numeric(10,2), so they round-trip exactly at two decimals (the same rounding as `toResult`). */
const points = (name: string) => numeric(name, { precision: 10, scale: 2, mode: "number" });
const ms = (name: string) => bigint(name, { mode: "number" });

/**
 * jsonb without drizzle's second parse: its `jsonb` runs `JSON.parse` on any string it reads back, so a
 * stored answer `"3.505"` would come back as the number 3.505. pg already parses jsonb.
 */
const jsonValue = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => "jsonb",
  toDriver: (value) => JSON.stringify(value),
  fromDriver: (value) => value,
});

/** One practice attempt. Private to its user: every lookup is scoped by `user_id` (P1.md §5). */
export const PracticeAttempt = pgTable(
  "practice_attempt",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => User.id, { onDelete: "cascade" }),
    testVersionId: uuid("test_version_id")
      .notNull()
      .references(() => TestVersion.id),
    kind: text("kind", { enum: ["full", "retake_missed"] }).notNull(),
    /** 128 random bits as 32 hex digits (`shuffleAttempt`). */
    shuffleSeed: text("shuffle_seed").notNull(),
    /** Null for `full`; the question ids of a `retake_missed` attempt. */
    questionIds: integer("question_ids").array(),
    startedAt: ts("started_at").notNull().defaultNow(),
    submittedAt: ts("submitted_at"),
    durationMs: ms("duration_ms"),
    /** Null until submit. */
    score: points("score"),
    /** Sum of `points ?? 1` over the attempt's questions, set at start. */
    maxScore: points("max_score").notNull(),
  },
  (t) => [
    index("practice_attempt_user_idx").on(t.userId, t.startedAt),
    index("practice_attempt_version_idx").on(t.testVersionId),
    // At most one in-progress attempt per user per test version.
    uniqueIndex("practice_attempt_in_progress_unique")
      .on(t.userId, t.testVersionId)
      .where(sql`${t.submittedAt} IS NULL`),
    check("practice_attempt_kind_check", sql`${t.kind} IN ('full', 'retake_missed')`),
    check("practice_attempt_seed_check", sql`${t.shuffleSeed} ~ '^[0-9a-f]{32}$'`),
    check("practice_attempt_question_ids_check", sql`(${t.kind} = 'full') = (${t.questionIds} IS NULL)`),
    check(
      "practice_attempt_submitted_check",
      sql`(${t.submittedAt} IS NULL) = (${t.score} IS NULL) AND (${t.submittedAt} IS NULL) = (${t.durationMs} IS NULL)`,
    ),
  ],
);

/**
 * One answer to one question of an attempt (SPEC §10). P3 adds `submission_id` (and makes `attempt_id`
 * nullable, with a check that exactly one is set) and `needs_review`.
 */
export const Response = pgTable(
  "response",
  {
    id: uuid("id").primaryKey(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => PracticeAttempt.id, { onDelete: "cascade" }),
    /** The question's `id` within the attempt's test version (SPEC §2.3). */
    questionId: integer("question_id").notNull(),
    /** A string, or a string array for `multi_choice`; null while only flagged or visited. */
    answer: jsonValue("answer"),
    /** Set when the answer is checked (or graded at submit); the answer is then locked. */
    autoResult: text("auto_result", { enum: ["correct", "partial", "incorrect"] }),
    pointsAwarded: points("points_awarded").notNull().default(0),
    selfGraded: boolean("self_graded").notNull().default(false),
    flagged: boolean("flagged").notNull().default(false),
    answeredAt: ts("answered_at"),
    timeSpentMs: ms("time_spent_ms").notNull().default(0),
  },
  (t) => [
    unique("response_attempt_question_unique").on(t.attemptId, t.questionId),
    check("response_auto_result_check", sql`${t.autoResult} IN ('correct', 'partial', 'incorrect')`),
    check("response_time_spent_check", sql`${t.timeSpentMs} >= 0`),
  ],
);

// ── LLM layer (P1.5.md §4) ───────────────────────────────────────────

/** Soft-deleted, so call logs and eval runs keep a valid `endpoint_id`. The API refuses deleted endpoints. */
export const Endpoint = pgTable(
  "endpoint",
  {
    id: uuid("id").primaryKey(),
    label: text("label").notNull(),
    provider: text("provider").notNull(),
    baseUrl: text("base_url"),
    /** `base64(iv ‖ ciphertext ‖ tag)`, AES-256-GCM with the endpoint id as associated data (`secrets.ts`). */
    apiKeyCiphertext: text("api_key_ciphertext"),
    location: text("location", { enum: ["local", "cloud"] }).notNull(),
    server: text("server", { enum: ["vllm", "llamacpp", "ollama", "lmstudio", "gateway", "other"] }),
    concurrency: integer("concurrency").notNull().default(1),
    timeoutMs: integer("timeout_ms").notNull().default(300_000),
    /** Null for the dev seed. */
    createdBy: uuid("created_by").references(() => User.id),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    check("endpoint_location_check", sql`${t.location} IN ('local', 'cloud')`),
    check("endpoint_server_check", sql`${t.server} IN ('vllm', 'llamacpp', 'ollama', 'lmstudio', 'gateway', 'other')`),
    check("endpoint_concurrency_check", sql`${t.concurrency} >= 1`),
    check("endpoint_timeout_check", sql`${t.timeoutMs} >= 1`),
  ],
);

/** One row per assigned role. `embedding` is set for the `embeddings` role and only for it. */
export const RoleAssignment = pgTable(
  "role_assignment",
  {
    role: text("role", {
      enum: ["authoring.objectives", "authoring.generate", "authoring.judge", "verify.solve", "analysis", "embeddings"],
    }).primaryKey(),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => Endpoint.id),
    model: text("model").notNull(),
    capabilities: jsonValue("capabilities").notNull(),
    embedding: jsonValue("embedding"),
    params: jsonValue("params"),
    /** Null for the dev seed. */
    updatedBy: uuid("updated_by").references(() => User.id),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "role_assignment_role_check",
      sql`${t.role} IN ('authoring.objectives', 'authoring.generate', 'authoring.judge', 'verify.solve', 'analysis', 'embeddings')`,
    ),
    check("role_assignment_embedding_check", sql`(${t.role} = 'embeddings') = (${t.embedding} IS NOT NULL)`),
  ],
);

export const LlmEvalRun = pgTable(
  "llm_eval_run",
  {
    id: uuid("id").primaryKey(),
    evalSet: text("eval_set").notNull(),
    role: text("role").notNull(),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => Endpoint.id),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    status: text("status", { enum: ["queued", "running", "done", "failed"] }).notNull(),
    trials: integer("trials").notNull(),
    summary: jsonValue("summary"),
    items: jsonValue("items"),
    errorCode: text("error_code"),
    /** Null for runs from the CLI. */
    startedBy: uuid("started_by").references(() => User.id),
    createdAt: ts("created_at").notNull().defaultNow(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    index("llm_eval_run_created_idx").on(t.createdAt),
    // One run at a time per role (`llm_eval_running`).
    uniqueIndex("llm_eval_run_active_unique").on(t.role).where(sql`${t.status} IN ('queued', 'running')`),
    check("llm_eval_run_status_check", sql`${t.status} IN ('queued', 'running', 'done', 'failed')`),
  ],
);

/**
 * Append-only like `AuditLog` (the provenance record, SPEC §3B.4): the app's DB user has only INSERT/SELECT
 * (grants migration). `actor_id` has no FK, like `audit_log`. The bodies never hold headers or keys.
 */
export const LlmCallLog = pgTable(
  "llm_call_log",
  {
    id: uuid("id").primaryKey(),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => Endpoint.id),
    model: text("model").notNull(),
    role: text("role"),
    kind: text("kind", { enum: ["call", "probe", "eval"] }).notNull(),
    promptId: text("prompt_id"),
    promptVersion: text("prompt_version"),
    /** The template file used; differs from `<version>.md` when a per-model variant was chosen. */
    promptFile: text("prompt_file"),
    mode: text("mode").notNull(),
    finishReason: text("finish_reason"),
    outcome: text("outcome", { enum: ["ok", "salvaged", "failed"] }).notNull(),
    errorCode: text("error_code"),
    repairAttempts: integer("repair_attempts").notNull().default(0),
    normalizationFixes: jsonValue("normalization_fixes").notNull(),
    usage: jsonValue("usage").notNull(),
    queuedMs: integer("queued_ms").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    actorId: uuid("actor_id"),
    evalRunId: uuid("eval_run_id").references(() => LlmEvalRun.id),
    at: ts("at").notNull().defaultNow(),
    requestBody: jsonValue("request_body"),
    responseBody: jsonValue("response_body"),
  },
  (t) => [
    index("llm_call_log_at_idx").on(t.at),
    index("llm_call_log_stats_idx").on(t.role, t.endpointId, t.model, t.at),
    check("llm_call_log_kind_check", sql`${t.kind} IN ('call', 'probe', 'eval')`),
    check("llm_call_log_outcome_check", sql`${t.outcome} IN ('ok', 'salvaged', 'failed')`),
  ],
);

// ── Verification (P2.1.md §4) ────────────────────────────────────────

/**
 * One L7 run over an imported quiz. Import preview saves nothing, so a run needs something to hang from before
 * a `TestVersion` exists. Private to its owner (and admins).
 */
export const VerificationJob = pgTable(
  "verification_job",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => User.id),
    status: text("status", { enum: ["queued", "running", "done", "failed"] }).notNull(),
    /** The normalized quiz value: questions that failed `Quiz` validation are checked too. */
    input: jsonValue("input").notNull(),
    inputHash: text("input_hash").notNull(),
    items: jsonValue("items"),
    summary: jsonValue("summary"),
    errorCode: text("error_code"),
    createdAt: ts("created_at").notNull().defaultNow(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    index("verification_job_owner_idx").on(t.ownerId, t.createdAt),
    check("verification_job_status_check", sql`${t.status} IN ('queued', 'running', 'done', 'failed')`),
  ],
);

/**
 * One program run in the sandbox: provenance, append-only for the app's DB user (grants migration). `result` is
 * text as the runner serialized it, stored and shown, never evaluated. P2 adds `draft_question_id`.
 */
export const VerificationRun = pgTable(
  "verification_run",
  {
    id: uuid("id").primaryKey(),
    jobId: uuid("job_id").references(() => VerificationJob.id),
    testVersionId: uuid("test_version_id").references(() => TestVersion.id),
    /** The question's `id` within its quiz (SPEC §2.3). */
    questionId: integer("question_id").notNull(),
    programKind: text("program_kind", { enum: ["author", "blind"] }).notNull(),
    program: text("program").notNull(),
    status: text("status", {
      enum: ["ok", "program_error", "timeout", "sandbox_denial", "invalid_output"],
    }).notNull(),
    result: jsonValue("result"),
    matchedOption: text("matched_option"),
    durationMs: integer("duration_ms").notNull(),
    sandboxVersion: text("sandbox_version").notNull(),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [
    index("verification_run_job_idx").on(t.jobId),
    index("verification_run_version_idx").on(t.testVersionId),
    check("verification_run_kind_check", sql`${t.programKind} IN ('author', 'blind')`),
    check(
      "verification_run_status_check",
      sql`${t.status} IN ('ok', 'program_error', 'timeout', 'sandbox_denial', 'invalid_output')`,
    ),
  ],
);
