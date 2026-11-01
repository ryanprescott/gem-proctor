// bun run live:retrieval: `retrieval-mini` against the live embedding model (LLM_DEV_*), twice: in memory, as
// `llm:live` runs it, and through the database, as authoring retrieves (pgvector alone, and vector with full text).
// A throwaway database, nothing stored in yours. P2.md E52 and SPEC §13 Q4.
import { join } from "node:path";
import { RoleAssignment } from "@gem/db";
import { adminUrl, startLocalPg } from "./pg-local.ts";

const ROOT = join(import.meta.dir, "..");
if (!process.env.TEST_PG_ADMIN_URL) {
  await startLocalPg();
  process.env.TEST_PG_ADMIN_URL = adminUrl();
}
process.env.REQUIRE_DB_TESTS = "1";

const { createSourceEnv } = await import("../apps/api/test/authoring-helpers.ts");
const { loadConfig } = await import("../apps/api/src/config.ts");
const { seedDevLlm } = await import("../apps/api/src/llm-seed.ts");
const { hybridRunner } = await import("../apps/api/src/llm-eval-database.ts");
const { loadEvalSet, runEval } = await import("../packages/llm/src/index.ts");

const env = await createSourceEnv();
const dev = loadConfig(process.env, process.env.ENV_FILE ?? join(ROOT, ".env"));
if (!dev.LLM_DEV_BASE_URL) throw new Error("LLM_DEV_* is not set: nothing to run against");
await env.t.db.delete(RoleAssignment);
await seedDevLlm({ config: { ...dev, ENDPOINT_SECRET_KEY: env.t.ctx.config.ENDPOINT_SECRET_KEY }, db: env.t.db });
try {
  const set = loadEvalSet("retrieval-mini");
  const started = Date.now();
  const report = await runEval(env.t.ctx.llm, set, { hybrid: hybridRunner(env.t.ctx, env.proctorId) });
  console.log(
    JSON.stringify(
      { embed: dev.LLM_DEV_EMBED_MODEL, seconds: (Date.now() - started) / 1000, ...report.summary },
      null,
      2,
    ),
  );
} finally {
  await env.close();
  process.exit(0);
}
