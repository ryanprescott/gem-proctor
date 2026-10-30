import { randomBytes } from "node:crypto";
import { Authz } from "@gem/authz";
import { bootstrapDatabase, createDb, createPool, type Db, runMigrations, withDatabase } from "@gem/db";
import { createLlmRuntime } from "@gem/llm";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import pg from "pg";
import { type BuildOptions, buildApp } from "../src/app.ts";
import { SessionStore } from "../src/auth/sessions.ts";
import { type Config, loadConfig } from "../src/config.ts";
import type { AppContext } from "../src/context.ts";
import type { VerifyClient } from "../src/verify-client.ts";

/**
 * Integration tests run against a real Postgres 17 + pgvector: `TEST_PG_ADMIN_URL` is a superuser URL
 * (set by `bun run ci`, by CI, or by hand after `bun run dev:pg`). Each test file gets a fresh database,
 * set up with the Compose init script and the migrations, and connects as gem_app like the API does.
 */
export const ADMIN_URL = process.env.TEST_PG_ADMIN_URL;
if (!ADMIN_URL && process.env.REQUIRE_DB_TESTS === "1") {
  throw new Error("REQUIRE_DB_TESTS=1 but TEST_PG_ADMIN_URL is not set");
}
export const hasDb = !!ADMIN_URL;

const OWNER_PW = process.env.GEM_OWNER_PASSWORD ?? "change-me";
const APP_PW = process.env.GEM_APP_PASSWORD ?? "change-me";

function roleUrl(role: "gem_owner" | "gem_app", password: string, db: string): string {
  const u = new URL(ADMIN_URL as string);
  u.username = role;
  u.password = password;
  return withDatabase(u.toString(), db);
}

export interface TestDatabase {
  name: string;
  ownerUrl: string;
  appUrl: string;
  drop(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `gem_test_${randomBytes(6).toString("hex")}`;
  await bootstrapDatabase({
    adminUrl: ADMIN_URL as string,
    dbname: name,
    ownerPassword: OWNER_PW,
    appPassword: APP_PW,
  });
  const ownerUrl = roleUrl("gem_owner", OWNER_PW, name);
  await runMigrations(ownerUrl);
  return {
    name,
    ownerUrl,
    appUrl: roleUrl("gem_app", APP_PW, name),
    async drop() {
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await c.end();
    },
  };
}

export class FakeVerify implements VerifyClient {
  reply: Awaited<ReturnType<VerifyClient["health"]>> = { ok: true, sympy: "1.13.3", numpy: "2.1.3" };
  async health() {
    return this.reply;
  }
}

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  db: Db;
  database: TestDatabase;
  verify: FakeVerify;
  close(): Promise<void>;
}

export function testConfig(database: TestDatabase, env: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: database.appUrl,
    DATABASE_URL_OWNER: database.ownerUrl,
    SESSION_SECRET: randomBytes(32).toString("base64"),
    AUTH_RATE_LIMIT_MAX: "1000",
    ...env,
  });
}

export async function createTestApp(
  opts: { env?: Record<string, string>; build?: BuildOptions; database?: TestDatabase } = {},
): Promise<TestApp> {
  const database = opts.database ?? (await createTestDatabase());
  const config = testConfig(database, opts.env);
  const pool = createPool(config.DATABASE_URL, 5);
  const db = createDb(pool);
  const verify = new FakeVerify();
  const ctx: AppContext = {
    config,
    db,
    authz: await Authz.create(db),
    sessions: new SessionStore(db),
    queue: null,
    verify,
    llm: createLlmRuntime({ db, secretKey: config.ENDPOINT_SECRET_KEY }),
    now: () => new Date(),
  };
  const app = await buildApp(ctx, opts.build);
  try {
    await app.ready();
  } catch (err) {
    // A failed startup (e.g. the A16 check) must not leak the database.
    await app.close().catch(() => undefined);
    await pool.end();
    if (!opts.database) await database.drop();
    throw err;
  }
  return {
    app,
    ctx,
    db,
    database,
    verify,
    async close() {
      await app.close();
      await pool.end();
      if (!opts.database) await database.drop();
    },
  };
}

/** A signed-in client: keeps the session cookie between requests. */
export class Client {
  cookie: string | undefined;
  constructor(private readonly app: FastifyInstance) {}

  async request(opts: InjectOptions): Promise<LightMyRequestResponse> {
    const headers = { ...(opts.headers ?? {}), ...(this.cookie ? { cookie: this.cookie } : {}) };
    const res = await this.app.inject({ ...opts, headers });
    const set = res.cookies.find((c) => c.name === "gem_session");
    if (set) this.cookie = set.value === "" ? undefined : `gem_session=${set.value}`;
    return res;
  }

  get(url: string) {
    return this.request({ method: "GET", url });
  }
  post(url: string, payload?: unknown) {
    return this.request({ method: "POST", url, payload: payload as InjectOptions["payload"] });
  }
  put(url: string, payload?: unknown) {
    return this.request({ method: "PUT", url, payload: payload as InjectOptions["payload"] });
  }
  patch(url: string, payload?: unknown) {
    return this.request({ method: "PATCH", url, payload: payload as InjectOptions["payload"] });
  }
  delete(url: string) {
    return this.request({ method: "DELETE", url });
  }
}

export const API = "/api/v1";
export const PASSWORD = "correct horse battery";

export async function registerUser(app: FastifyInstance, email: string, displayName = email.split("@")[0] ?? email) {
  const c = new Client(app);
  const res = await c.post(`${API}/auth/register`, { email, password: PASSWORD, displayName });
  if (res.statusCode !== 200) throw new Error(`register ${email}: ${res.statusCode} ${res.body}`);
  return { client: c, user: res.json().user as { id: string; role: string } };
}

export async function signIn(app: FastifyInstance, email: string, password = PASSWORD) {
  const c = new Client(app);
  const res = await c.post(`${API}/auth/login`, { email, password });
  return { client: c, res };
}
