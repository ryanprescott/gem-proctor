// bun run llm:live [--trials n] [--embed-model tag]…: the live checks (P1.5.md §5, C38–C40) against the server in
// LLM_DEV_*: discovery, chat probe, embeddings probe, generate-smoke and retrieval-mini. Nothing is stored.
// Each check runs even if an earlier one failed; the exit code says whether all of them passed.
import { join } from "node:path";
import { parseArgs } from "node:util";
import { evalPromptVersion, formatEvalReport, LlmError, loadEvalSet, runEval } from "@gem/llm";
import { loadConfig } from "./config.ts";
import { devRuntime } from "./llm-dev.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const DEFAULT_TRIALS = 5;

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { trials: { type: "string" }, "embed-model": { type: "string", multiple: true } },
});
const trials = Number(values.trials ?? DEFAULT_TRIALS);
const config = loadConfig(process.env, process.env.ENV_FILE ?? join(ROOT, ".env"));
const llm = devRuntime(config);
let failed = false;

async function check(name: string, run: () => Promise<string>) {
  console.log(`\n== ${name}`);
  try {
    console.log(await run());
  } catch (err) {
    failed = true;
    console.log(`FAILED: ${err instanceof LlmError ? err.code : String(err)}`);
  }
}

async function evalCheck(name: string) {
  const set = loadEvalSet(name);
  await check(`eval ${name}`, async () => {
    const target = await llm.resolve(set.role);
    const report = await runEval(llm, set, { trials });
    const head = { model: target.model, endpoint: target.endpoint.label, promptVersion: evalPromptVersion(set) };
    return `${formatEvalReport(set, head, report)}\n${JSON.stringify(report.items)}`;
  });
}

const chat = await llm.resolve("authoring.generate").catch(() => null);
const embeddings = await llm.resolve("embeddings").catch(() => null);

if (chat) {
  await check("discovery", async () => {
    const models = await llm.discoverModels(chat.endpoint);
    return JSON.stringify(models ?? "no models endpoint");
  });
  await check(`chat probe ${chat.model}`, async () => {
    const probe = await llm.probe(chat.endpoint, { model: chat.model, kind: "chat", params: chat.params });
    if (probe.kind === "chat" && !probe.modes.some((m) => m.schemaRespected)) failed = true;
    return JSON.stringify(probe, null, 2);
  });
  await evalCheck("generate-smoke");
}
if (embeddings) {
  for (const model of [embeddings.model, ...(values["embed-model"] ?? [])]) {
    await check(`embeddings probe ${model}`, async () =>
      JSON.stringify(await llm.probe(embeddings.endpoint, { model, kind: "embeddings" }), null, 2),
    );
  }
  await evalCheck("retrieval-mini");
}
process.exit(failed ? 1 : 0);
