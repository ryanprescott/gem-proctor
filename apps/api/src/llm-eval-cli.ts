// bun run llm:eval <set> [--trials n] [--dev]: the job's runner, from the shell (P1.5.md §5). Uses the database's
// assignments and stores the run, or with --dev the LLM_DEV_* settings, with nothing stored.

import { join } from "node:path";
import { parseArgs } from "node:util";
import { createDb, createPool } from "@gem/db";
import {
  createLlmRuntime,
  dbStore,
  type EvalReport,
  evalPromptVersion,
  formatEvalReport,
  loadEvalSet,
  runEval,
} from "@gem/llm";
import { loadConfig } from "./config.ts";
import { devRuntime } from "./llm-dev.ts";
import { groundingRunner } from "./llm-eval-database.ts";
import { createEvalRun, l7Runner, processEvalRun } from "./llm-evals.ts";
import { SocketVerifyClient } from "./verify-client.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");

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
// An `l7` set needs the sandbox: the socket in VERIFY_SOCKET.
const verify = new SocketVerifyClient(config.VERIFY_SOCKET);

async function report(): Promise<{ text: string; report: EvalReport | null }> {
  const head = { promptVersion: evalPromptVersion(set) };
  if (values.dev) {
    const llm = devRuntime(config);
    const target = await llm.resolve(set.role);
    const out = await runEval(llm, set, { trials, l7: l7Runner({ llm, verify }), grounding: groundingRunner({ llm }) });
    const where = { model: target.model, endpoint: target.endpoint.label, ...head };
    return { text: formatEvalReport(set, where, out), report: out };
  }
  const pool = createPool(config.DATABASE_URL, 2);
  const db = createDb(pool);
  const llm = createLlmRuntime({ store: dbStore(db), secretKey: config.ENDPOINT_SECRET_KEY });
  try {
    const target = await llm.resolve(set.role);
    const run = await createEvalRun({ db, llm }, { evalSet: name as string, trials, startedBy: null });
    const out = await processEvalRun({ db, llm, verify }, run.id);
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
