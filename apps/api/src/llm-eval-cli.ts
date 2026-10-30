// bun run llm:eval <set> [--trials n] [--dev]: the job's runner, from the shell (P1.5.md §5). Uses the database's
// assignments and stores the run, or with --dev the LLM_DEV_* settings, with nothing stored.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createDb, createPool, encryptSecret } from "@gem/db";
import {
  createLlmRuntime,
  dbStore,
  type EvalReport,
  evalPromptVersion,
  formatEvalReport,
  type LlmStore,
  loadEvalSet,
  runEval,
  type Target,
} from "@gem/llm";
import type { ModelRole } from "@gem/shared";
import { type Config, loadConfig } from "./config.ts";
import { createEvalRun, processEvalRun } from "./llm-evals.ts";
import { devAssignments } from "./llm-seed.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");

/** The dev key is encrypted like a stored one, under a key that lives for this run. */
const runKey = randomBytes(32).toString("base64");

function devStore(config: Config): LlmStore {
  const now = new Date();
  const targets = devAssignments(config).map(
    (a): Target => ({
      role: a.role,
      endpoint: {
        id: a.role,
        label: a.endpoint.label,
        provider: a.endpoint.provider,
        baseUrl: a.endpoint.baseUrl,
        apiKeyCiphertext: config.LLM_DEV_API_KEY ? encryptSecret(config.LLM_DEV_API_KEY, runKey, a.role) : null,
        location: a.endpoint.location,
        server: a.endpoint.server,
        concurrency: a.endpoint.concurrency,
        timeoutMs: a.endpoint.timeoutMs,
        createdBy: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
      model: a.model,
      capabilities: a.capabilities,
      embedding: a.embedding ?? null,
      params: a.params ?? {},
    }),
  );
  return {
    target: async (role: ModelRole) => targets.find((t) => t.role === role),
    localEndpointsOnly: async () => false,
    endpointsWithKeys: async () => [],
    log: async () => {},
  };
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: { trials: { type: "string" }, dev: { type: "boolean", default: false } },
});
const name = positionals[0];
if (!name) {
  console.error("usage: bun run llm:eval <set> [--trials n] [--dev]");
  process.exit(2);
}
const trials = values.trials === undefined ? undefined : Number(values.trials);
const config = loadConfig(process.env, process.env.ENV_FILE ?? join(ROOT, ".env"));
const set = loadEvalSet(name);

async function report(): Promise<{ text: string; report: EvalReport | null }> {
  const head = { promptVersion: evalPromptVersion(set) };
  if (values.dev) {
    const llm = createLlmRuntime({ store: devStore(config), secretKey: runKey });
    const target = await llm.resolve(set.role);
    const out = await runEval(llm, set, { trials });
    const where = { model: target.model, endpoint: target.endpoint.label, ...head };
    return { text: formatEvalReport(set, where, out), report: out };
  }
  const pool = createPool(config.DATABASE_URL, 2);
  const db = createDb(pool);
  const llm = createLlmRuntime({ store: dbStore(db), secretKey: config.ENDPOINT_SECRET_KEY });
  try {
    const target = await llm.resolve(set.role);
    const run = await createEvalRun({ db, llm }, { evalSet: name as string, trials, startedBy: null });
    const out = await processEvalRun({ db, llm }, run.id);
    if (!out) return { text: `eval ${name} failed: see run ${run.id}`, report: null };
    const where = { model: target.model, endpoint: target.endpoint.label, ...head };
    return { text: formatEvalReport(set, where, out), report: out };
  } finally {
    await pool.end();
  }
}

const out = await report();
console.log(out.text);
process.exit(out.report ? 0 : 1);
