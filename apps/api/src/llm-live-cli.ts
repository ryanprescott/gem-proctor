// bun run llm:live [--trials n] [--embed-model tag]… [--only name]: the live checks (P1.5.md §5, C38–C40) against the server in
// LLM_DEV_*: discovery, chat probe, embeddings probe, generate-smoke and retrieval-mini. Nothing is stored.
// Each check runs even if an earlier one failed; the exit code says whether all of them passed.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { emptyFlowASummary, flowABatch } from "@gem/authoring";
import { evalPromptVersion, formatEvalReport, LlmError, loadEvalSet, runEval } from "@gem/llm";
import { DEFAULT_VERIFY_SETTINGS, GenerationBatch } from "@gem/shared";
import { findVerifyPython, superviseVerify } from "../../../scripts/verify-local.ts";
import { loadConfig } from "./config.ts";
import { devRuntime } from "./llm-dev.ts";
import { groundingRunner } from "./llm-eval-database.ts";
import { l7Runner } from "./llm-evals.ts";
import { SocketVerifyClient } from "./verify-client.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const DEFAULT_TRIALS = 5;

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    trials: { type: "string" },
    "embed-model": { type: "string", multiple: true },
    only: { type: "string" },
  },
});
const trials = Number(values.trials ?? DEFAULT_TRIALS);
const config = loadConfig(process.env, process.env.ENV_FILE ?? join(ROOT, ".env"));
const llm = devRuntime(config);
let failed = false;

// The real parent, locally: flow A runs model programs, so this is only for a trusted model on a dev machine.
const python = findVerifyPython();
const verifySocket = join(mkdtempSync(join(tmpdir(), "gem-live-")), "verify.sock");
const local = python ? superviseVerify(python, verifySocket) : undefined;
const verify = local ? new SocketVerifyClient(verifySocket) : undefined;
for (let i = 0; verify && i < 100 && !(await verify.health()); i++) await Bun.sleep(100);

async function check(name: string, run: () => Promise<string>) {
  if (values.only && !name.includes(values.only)) return;
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
    const report = await runEval(llm, set, {
      trials,
      l7: verify ? l7Runner({ llm, verify }) : undefined,
      grounding: groundingRunner({ llm }),
    });
    const head = { model: target.model, endpoint: target.endpoint.label, promptVersion: evalPromptVersion(set) };
    return `${formatEvalReport(set, head, report)}\n${JSON.stringify(report.items)}`;
  });
}

/** `generate-smoke` through flow A: programs, the sandbox, built options (P2.1.md C34). */
async function flowACheck() {
  await check("flow A on generate-smoke", async () => {
    if (!verify) throw new Error("no Python with the pinned libraries: flow A needs the sandbox");
    const set = loadEvalSet("generate-smoke");
    if (set.kind !== "generate") throw new Error("generate-smoke isn't a generate set");
    const [chunk] = set.fixtures.chunks;
    if (!chunk) throw new Error("no chunk");
    const user = set.request.user.replace("{{chunkId}}", chunk.id).replace("{{chunk}}", chunk.text);
    const deps = {
      llm,
      verify,
      settings: DEFAULT_VERIFY_SETTINGS,
      recorder: { run: async () => "live", denial: async () => {} },
    };
    const summary = emptyFlowASummary();
    const keys = new Set<string>();
    let invalid = 0;
    const started = Date.now();
    for (let trial = 1; trial <= trials; trial++) {
      const generated = await llm
        .generateObject("authoring.generate", GenerationBatch, {
          promptId: set.prompt,
          vars: set.request.vars,
          messages: [{ role: "user", content: user }],
        })
        .catch(() => null);
      if (!generated) {
        invalid += 1;
        continue;
      }
      await flowABatch(deps, generated.value.questions, chunk.text, `live-${started}-${trial}`, summary, keys);
    }
    summary.distinctInputs = keys.size;
    if (summary.computable > 0 && summary.computed === 0) failed = true;
    return JSON.stringify({ trials, invalid, seconds: (Date.now() - started) / 1000, ...summary }, null, 2);
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
  await flowACheck();
  if (await llm.resolve("verify.solve").catch(() => null)) await evalCheck("l7-smoke");
}
if (embeddings) {
  for (const model of [embeddings.model, ...(values["embed-model"] ?? [])]) {
    await check(`embeddings probe ${model}`, async () =>
      JSON.stringify(await llm.probe(embeddings.endpoint, { model, kind: "embeddings" }), null, 2),
    );
  }
  await evalCheck("retrieval-mini");
}
await local?.stop();
process.exit(failed ? 1 : 0);
