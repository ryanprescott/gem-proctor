import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

/**
 * P0 tables (P0.md §4), P1's practice tables (P1.md §4), P1.5's LLM tables (P1.5.md §4), P2.1's verification
 * tables (P2.1.md §4) and P2's knowledge base and authoring tables (P2.md §4), from SPEC §10.
 * Postgres names are snake_case; TypeScript names follow SPEC §10.
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
    /** Set for tests published from authoring (P2). */
    authoringSessionId: uuid("authoring_session_id"),
  },
  (t) => [
    index("test_owner_idx").on(t.ownerId),
    foreignKey({
      columns: [t.authoringSessionId],
      foreignColumns: [AuthoringSession.id],
      name: "test_authoring_session_fk",
    }),
  ],
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
 * text as the runner serialized it, stored and shown, never evaluated.
 */
export const VerificationRun = pgTable(
  "verification_run",
  {
    id: uuid("id").primaryKey(),
    jobId: uuid("job_id").references(() => VerificationJob.id),
    testVersionId: uuid("test_version_id").references(() => TestVersion.id),
    draftQuestionId: uuid("draft_question_id").references(() => DraftQuestion.id),
    /** The question's `id` within its quiz (SPEC §2.3), or a draft's position in its session. */
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
    index("verification_run_draft_idx").on(t.draftQuestionId),
    check("verification_run_kind_check", sql`${t.programKind} IN ('author', 'blind')`),
    check(
      "verification_run_status_check",
      sql`${t.status} IN ('ok', 'program_error', 'timeout', 'sandbox_denial', 'invalid_output')`,
    ),
  ],
);

// ── Sources and knowledge base (P2.md §4) ────────────────────────────

/** Fixed to the reference embedding model (SPEC §3C.2). A role with other dimensions fails `knowledge_dimension_mismatch`. */
export const EMBEDDING_DIMENSIONS = 768;

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

/** Private to its owner (SPEC §13 Q6). Soft-deleted: published tests keep citing its chunks. */
export const Source = pgTable(
  "source",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => User.id),
    title: text("title").notNull(),
    citationLabel: text("citation_label").notNull(),
    author: text("author"),
    edition: text("edition"),
    url: text("url"),
    visibility: text("visibility", { enum: ["private"] })
      .notNull()
      .default("private"),
    createdAt: ts("created_at").notNull().defaultNow(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    index("source_owner_idx").on(t.ownerId, t.createdAt),
    check("source_visibility_check", sql`${t.visibility} IN ('private')`),
  ],
);

export const SourceRevision = pgTable(
  "source_revision",
  {
    id: uuid("id").primaryKey(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => Source.id),
    number: integer("number").notNull(),
    markdown: text("markdown").notNull(),
    format: text("format", { enum: ["markdown", "text"] }).notNull(),
    contentHash: text("content_hash").notNull(),
    embedStatus: text("embed_status", { enum: ["pending", "embedding", "ready", "failed"] }).notNull(),
    /** `{ code, params }`, as the API sends it. */
    embedError: jsonValue("embed_error"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => User.id),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("source_revision_number_unique").on(t.sourceId, t.number),
    check("source_revision_status_check", sql`${t.embedStatus} IN ('pending', 'embedding', 'ready', 'failed')`),
    check("source_revision_format_check", sql`${t.format} IN ('markdown', 'text')`),
  ],
);

export const SourceSection = pgTable(
  "source_section",
  {
    id: uuid("id").primaryKey(),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => SourceRevision.id),
    parentId: uuid("parent_id"),
    level: integer("level").notNull(),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    order: integer("order").notNull(),
    /** Heading titles from the top, for citations. */
    headingPath: text("heading_path").array().notNull(),
    charStart: integer("char_start").notNull(),
    charEnd: integer("char_end").notNull(),
  },
  (t) => [
    uniqueIndex("source_section_order_unique").on(t.revisionId, t.order),
    foreignKey({ columns: [t.parentId], foreignColumns: [t.id], name: "source_section_parent_fk" }),
  ],
);

/**
 * One chunk: a provenance record, immutable (SPEC §3C.2). `gem_app` may only `UPDATE` the embedding and flag columns,
 * by column grant. `tsv` indexes the stored text in both configs: `english` stems words, `simple` keeps notation.
 */
export const SourceChunk = pgTable(
  "source_chunk",
  {
    id: uuid("id").primaryKey(),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => SourceRevision.id),
    sectionId: uuid("section_id")
      .notNull()
      .references(() => SourceSection.id),
    chunkKey: text("chunk_key").notNull(),
    charStart: integer("char_start").notNull(),
    charEnd: integer("char_end").notNull(),
    contentHash: text("content_hash").notNull(),
    text: text("text").notNull(),
    /** An estimate at ingest; the embedding endpoint's own count once embedded (P2.md §5). */
    tokenCount: integer("token_count").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    embeddingModel: text("embedding_model"),
    tsv: tsvector("tsv").notNull().generatedAlwaysAs(sql`to_tsvector('english', text) || to_tsvector('simple', text)`),
    flaggedAt: ts("flagged_at"),
    flagReason: text("flag_reason"),
  },
  (t) => [
    uniqueIndex("source_chunk_key_unique").on(t.revisionId, t.chunkKey),
    index("source_chunk_section_idx").on(t.sectionId),
    index("source_chunk_hash_idx").on(t.contentHash, t.embeddingModel),
    index("source_chunk_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("source_chunk_tsv_idx").using("gin", t.tsv),
    check("source_chunk_offsets_check", sql`${t.charStart} >= 0 AND ${t.charEnd} > ${t.charStart}`),
  ],
);

// ── Authoring (P2.md §4) ─────────────────────────────────────────────

/**
 * One authoring session. Soft-deleted: `RetrievalLog`, `QuestionEvent` and `ValidationResult` are append-only, so
 * their rows can't go, and a published version's frozen trail doesn't need them (SPEC §3A.1).
 */
export const AuthoringSession = pgTable(
  "authoring_session",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => User.id),
    title: text("title").notNull(),
    status: text("status", { enum: ["draft", "generating", "review", "published"] }).notNull(),
    model: text("model"),
    testType: text("test_type", {
      enum: ["chapter_quiz", "homework", "unit_test", "midterm", "final", "custom"],
    }).notNull(),
    blueprint: jsonValue("blueprint"),
    /** Value sets and source values used so far, so each is used once per test (SPEC §3A.3.1). */
    usedValues: jsonValue("used_values").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    index("authoring_session_owner_idx").on(t.ownerId, t.createdAt),
    check("authoring_session_status_check", sql`${t.status} IN ('draft', 'generating', 'review', 'published')`),
  ],
);

/** A session's scope: which revision of a source, and which of its sections (null: all of them). */
export const AuthoringSessionSource = pgTable(
  "authoring_session_source",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => AuthoringSession.id),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => Source.id),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => SourceRevision.id),
    sectionIds: uuid("section_ids").array(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.sourceId] })],
);

export const Objective = pgTable(
  "objective",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => AuthoringSession.id),
    label: text("label").notNull(),
    description: text("description").notNull().default(""),
    /** The chunks it comes from: `{ chunkId }[]`. */
    evidence: jsonValue("evidence").notNull(),
    origin: text("origin", { enum: ["llm", "human", "heading"] }).notNull(),
    order: integer("order").notNull(),
    sectionIds: uuid("section_ids").array().notNull(),
  },
  (t) => [
    index("objective_session_idx").on(t.sessionId, t.order),
    check("objective_origin_check", sql`${t.origin} IN ('llm', 'human', 'heading')`),
  ],
);

/** One numbered round of a session (SPEC §3A.1). */
export const Revision = pgTable(
  "revision",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => AuthoringSession.id),
    number: integer("number").notNull(),
    trigger: text("trigger", { enum: ["generate", "revise"] }).notNull(),
    request: jsonValue("request").notNull(),
    usage: jsonValue("usage"),
    /** Seeds inputs, distractors and option order (P2.md §5). */
    seed: text("seed").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("revision_number_unique").on(t.sessionId, t.number),
    check("revision_trigger_check", sql`${t.trigger} IN ('generate', 'revise')`),
  ],
);

/** One generation call. A failure stays here, with its code, until it's retried (SPEC §3A.2). */
export const AuthoringBatch = pgTable(
  "authoring_batch",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => AuthoringSession.id),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => Revision.id),
    status: text("status", { enum: ["queued", "running", "done", "failed", "cancelled"] }).notNull(),
    plan: jsonValue("plan").notNull(),
    errorCode: text("error_code"),
    /** Items the salvage kept out, and partials the truncation path dropped. */
    failedItems: jsonValue("failed_items").notNull(),
    callLogId: uuid("call_log_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    index("authoring_batch_session_idx").on(t.sessionId),
    check("authoring_batch_status_check", sql`${t.status} IN ('queued', 'running', 'done', 'failed', 'cancelled')`),
  ],
);

/** What retrieval gave the model, per call: append-only (SPEC §3C.3). */
export const RetrievalLog = pgTable(
  "retrieval_log",
  {
    id: uuid("id").primaryKey(),
    revisionId: uuid("revision_id").references(() => Revision.id),
    /** No FK, like `audit_log.actor_id`: a creator can remove an objective, and this row stays. */
    objectiveId: uuid("objective_id"),
    query: text("query").notNull(),
    scope: jsonValue("scope").notNull(),
    results: jsonValue("results").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [index("retrieval_log_revision_idx").on(t.revisionId)],
);

export const DraftQuestion = pgTable(
  "draft_question",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => AuthoringSession.id),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => Revision.id),
    batchId: uuid("batch_id").references(() => AuthoringBatch.id),
    tempId: text("temp_id").notNull(),
    /** Its place in the session; `VerificationRun.questionId` for runs before there's a quiz id. */
    position: integer("position").notNull(),
    content: jsonValue("content").notNull(),
    status: text("status", { enum: ["proposed", "accepted", "rejected", "locked"] }).notNull(),
    creatorNote: text("creator_note"),
    supersedesId: uuid("supersedes_id"),
    editedBy: uuid("edited_by").references(() => User.id),
    editedAt: ts("edited_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("draft_question_session_idx").on(t.sessionId, t.position),
    uniqueIndex("draft_question_position_unique").on(t.sessionId, t.position),
    foreignKey({ columns: [t.supersedesId], foreignColumns: [t.id], name: "draft_question_supersedes_fk" }),
    check("draft_question_status_check", sql`${t.status} IN ('proposed', 'accepted', 'rejected', 'locked')`),
  ],
);

/** The provenance trail: append-only (SPEC §3A.1). `actor_id` has no FK, like `audit_log`. */
export const QuestionEvent = pgTable(
  "question_event",
  {
    id: uuid("id").primaryKey(),
    draftQuestionId: uuid("draft_question_id")
      .notNull()
      .references(() => DraftQuestion.id),
    kind: text("kind", {
      enum: [
        "generated",
        "regenerated",
        "edited",
        "accepted",
        "rejected",
        "locked",
        "fix_accepted",
        "answer_computed",
        "reclassified",
      ],
    }).notNull(),
    actorId: uuid("actor_id"),
    revisionId: uuid("revision_id").references(() => Revision.id),
    before: jsonValue("before"),
    after: jsonValue("after"),
    note: text("note"),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [
    index("question_event_question_idx").on(t.draftQuestionId, t.at),
    check(
      "question_event_kind_check",
      sql`${t.kind} IN ('generated', 'regenerated', 'edited', 'accepted', 'rejected', 'locked', 'fix_accepted', 'answer_computed', 'reclassified')`,
    ),
  ],
);

/** One layer's result, per question per revision: append-only, the newest row is the current one (SPEC §3A.3). */
export const ValidationResult = pgTable(
  "validation_result",
  {
    id: uuid("id").primaryKey(),
    draftQuestionId: uuid("draft_question_id")
      .notNull()
      .references(() => DraftQuestion.id),
    revisionId: uuid("revision_id").references(() => Revision.id),
    layer: text("layer", { enum: ["L1", "L2", "L3", "L7"] }).notNull(),
    outcome: text("outcome", { enum: ["pass", "warn", "fail"] }).notNull(),
    detail: jsonValue("detail").notNull(),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [
    index("validation_result_question_idx").on(t.draftQuestionId, t.at),
    check("validation_result_layer_check", sql`${t.layer} IN ('L1', 'L2', 'L3', 'L7')`),
    check("validation_result_outcome_check", sql`${t.outcome} IN ('pass', 'warn', 'fail')`),
  ],
);
