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
 * P0 tables (P0.md §4) and P1's practice tables (P1.md §4), from SPEC §10. Postgres names are snake_case; TypeScript names follow SPEC §10.
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
