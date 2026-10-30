import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  bootstrapDatabase,
  createDb,
  createPool,
  type Db,
  Endpoint,
  encryptSecret,
  InstanceSettings,
  LlmCallLog,
  newId,
  RoleAssignment,
  runMigrations,
  withDatabase,
} from "@gem/db";
import type { Capabilities, EmbeddingConfig, ModelParams, ModelRole } from "@gem/shared";
import { desc, eq } from "drizzle-orm";
import pg from "pg";
import { createLlmRuntime, dbStore, type Runtime } from "../src/index.ts";

/** Real Postgres, like apps/api's tests: a fresh database per file, connected as gem_app. */
export const ADMIN_URL = process.env.TEST_PG_ADMIN_URL;
export const hasDb = !!ADMIN_URL;
if (!ADMIN_URL && process.env.REQUIRE_DB_TESTS === "1") throw new Error("TEST_PG_ADMIN_URL is not set");

const OWNER_PW = process.env.GEM_OWNER_PASSWORD ?? "change-me";
const APP_PW = process.env.GEM_APP_PASSWORD ?? "change-me";

export const SECRET_KEY = randomBytes(32).toString("base64");

export interface TestEnv {
  db: Db;
  runtime: Runtime;
  close(): Promise<void>;
}

const roleUrl = (role: string, password: string, db: string) => {
  const u = new URL(ADMIN_URL as string);
  u.username = role;
  u.password = password;
  return withDatabase(u.toString(), db);
};

export async function createEnv(): Promise<TestEnv> {
  const name = `gem_test_${randomBytes(6).toString("hex")}`;
  await bootstrapDatabase({
    adminUrl: ADMIN_URL as string,
    dbname: name,
    ownerPassword: OWNER_PW,
    appPassword: APP_PW,
  });
  await runMigrations(roleUrl("gem_owner", OWNER_PW, name));
  const pool = createPool(roleUrl("gem_app", APP_PW, name), 5);
  const db = createDb(pool);
  const runtime = createLlmRuntime({
    store: dbStore(db),
    secretKey: SECRET_KEY,
    prompts: {
      dir: join(import.meta.dir, "prompts"),
      active: { greet: "greet-v1", "output-repair": "output-repair-v1" },
    },
  });
  return {
    db,
    runtime,
    async close() {
      await pool.end();
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await c.end();
    },
  };
}

export const CAPABILITIES: Capabilities = {
  structuredOutput: "native_schema",
  contextWindow: 32768,
  maxOutputTokens: 1024,
};

export interface AssignOptions {
  url: string;
  provider?: string;
  apiKey?: string;
  location?: "local" | "cloud";
  concurrency?: number;
  timeoutMs?: number;
  model?: string;
  capabilities?: Partial<Capabilities>;
  embedding?: EmbeddingConfig;
  params?: ModelParams;
}

/** A fresh endpoint, assigned to `role` (replacing any assignment). */
export async function assign(db: Db, role: ModelRole, o: AssignOptions): Promise<string> {
  const id = newId();
  await db.insert(Endpoint).values({
    id,
    label: `E ${id.slice(-4)}`,
    provider: o.provider ?? "openai-compatible",
    baseUrl: o.url,
    apiKeyCiphertext: o.apiKey ? encryptSecret(o.apiKey, SECRET_KEY, id) : null,
    location: o.location ?? "local",
    concurrency: o.concurrency ?? 1,
    timeoutMs: o.timeoutMs ?? 5000,
  });
  await db.delete(RoleAssignment).where(eq(RoleAssignment.role, role));
  await db.insert(RoleAssignment).values({
    role,
    endpointId: id,
    model: o.model ?? "mock-model",
    capabilities: { ...CAPABILITIES, ...o.capabilities },
    embedding: o.embedding ?? null,
    params: o.params ?? null,
  });
  return id;
}

export async function setLocalOnly(db: Db, value: boolean) {
  await db
    .insert(InstanceSettings)
    .values({ key: "localEndpointsOnly", value })
    .onConflictDoUpdate({ target: InstanceSettings.key, set: { value } });
}

export async function lastLog(db: Db) {
  const [row] = await db.select().from(LlmCallLog).orderBy(desc(LlmCallLog.at), desc(LlmCallLog.id)).limit(1);
  return row;
}
