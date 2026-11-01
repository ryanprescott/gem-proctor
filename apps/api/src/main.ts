import { join } from "node:path";
import { Authz } from "@gem/authz";
import { createDb, createPool, runMigrations } from "@gem/db";
import { createLlmRuntime, dbStore } from "@gem/llm";
import { buildApp } from "./app.ts";
import { SessionStore } from "./auth/sessions.ts";
import { startGenerateWorker } from "./authoring/generate.ts";
import { startL7Worker } from "./authoring/l7.ts";
import { ConfigError, loadConfig } from "./config.ts";
import type { AppContext } from "./context.ts";
import { EventHub } from "./events.ts";
import { startEvalWorker } from "./llm-evals.ts";
import { seedDevLlm } from "./llm-seed.ts";
import { Queue } from "./queue.ts";
import { bootstrapEnvAdmin } from "./routes/auth.ts";
import { getSettings } from "./settings.ts";
import { startSourceWorker } from "./sources.ts";
import { startVerifyWorker } from "./verification.ts";
import { SocketVerifyClient } from "./verify-client.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig(process.env, process.env.ENV_FILE ?? join(ROOT, ".env"));
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

if (config.MIGRATE_ON_START === "true") await runMigrations(config.DATABASE_URL_OWNER);

const pool = createPool(config.DATABASE_URL);
const db = createDb(pool);
const ctx: AppContext = {
  config,
  db,
  authz: await Authz.create(db),
  sessions: new SessionStore(db),
  queue: null,
  verify: new SocketVerifyClient(config.VERIFY_SOCKET, {
    recycleEvery: async () => (await getSettings(db)).verify.recycleEvery,
  }),
  llm: createLlmRuntime({ store: dbStore(db), secretKey: config.ENDPOINT_SECRET_KEY }),
  events: new EventHub(),
  now: () => new Date(),
};

const app = await buildApp(ctx, { logger: { level: config.NODE_ENV === "development" ? "debug" : "info" } });
ctx.queue = await Queue.start(config.DATABASE_URL, (msg, err) => app.log.error({ err }, msg));
await startEvalWorker(ctx);
await startVerifyWorker(ctx);
await startSourceWorker(ctx);
await startGenerateWorker(ctx);
await startL7Worker(ctx);
await bootstrapEnvAdmin(ctx);
// A key that can't be read makes that endpoint `llm_endpoint_auth`, not the API fail to start (P1.5.md §5).
const unreadable = await ctx.llm.unreadableEndpoints();
if (unreadable.length > 0) app.log.error({ endpointIds: unreadable }, "endpoint keys can't be decrypted");
if (config.NODE_ENV === "development") await seedDevLlm(ctx, (msg) => app.log.info(msg));
await app.listen({ host: config.API_HOST, port: config.API_PORT });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    await ctx.queue?.stop();
    await pool.end();
    process.exit(0);
  });
}
