// bun run dev:pg [start|stop|status|setup]
// `setup` starts the local cluster, creates the dev database with the Compose init script and migrates it.
import { bootstrapDatabase, runMigrations, withDatabase } from "@gem/db";
import { adminUrl, isRunning, PG_PORT, startLocalPg, stopLocalPg } from "./pg-local.ts";

const cmd = process.argv[2] ?? "setup";
const db = process.env.POSTGRES_DB ?? "gem_proctor";
const ownerPw = process.env.GEM_OWNER_PASSWORD ?? "change-me";
const appPw = process.env.GEM_APP_PASSWORD ?? "change-me";

if (cmd === "stop") {
  await stopLocalPg();
} else if (cmd === "status") {
  console.log((await isRunning()) ? `running on 127.0.0.1:${PG_PORT}` : "stopped");
} else {
  await startLocalPg();
  if (cmd === "setup") {
    await bootstrapDatabase({ adminUrl: adminUrl(), dbname: db, ownerPassword: ownerPw, appPassword: appPw });
    const owner = withDatabase(`postgres://gem_owner:${encodeURIComponent(ownerPw)}@127.0.0.1:${PG_PORT}/`, db);
    await runMigrations(owner);
    console.log(`DATABASE_URL_OWNER=${owner}`);
    console.log(
      `DATABASE_URL=${withDatabase(`postgres://gem_app:${encodeURIComponent(appPw)}@127.0.0.1:${PG_PORT}/`, db)}`,
    );
  }
}
