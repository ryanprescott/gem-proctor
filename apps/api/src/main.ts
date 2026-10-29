import { join } from "node:path";
import { Authz } from "@gem/authz";
import { createDb, createPool, runMigrations } from "@gem/db";
import { buildApp } from "./app.ts";
import { SessionStore } from "./auth/sessions.ts";
import { ConfigError, loadConfig } from "./config.ts";
import type { AppContext } from "./context.ts";
import { Queue } from "./queue.ts";
import { bootstrapEnvAdmin } from "./routes/auth.ts";
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
  verify: new SocketVerifyClient(config.VERIFY_SOCKET),
  now: () => new Date(),
};

const app = await buildApp(ctx, { logger: { level: config.NODE_ENV === "development" ? "debug" : "info" } });
ctx.queue = await Queue.start(config.DATABASE_URL, (msg, err) => app.log.error({ err }, msg));
await bootstrapEnvAdmin(ctx);
await app.listen({ host: config.API_HOST, port: config.API_PORT });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    await ctx.queue?.stop();
    await pool.end();
    process.exit(0);
  });
}
