import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * P0 tables only (P0.md §4, SPEC §10). Postgres names are snake_case; TypeScript names follow SPEC §10.
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
