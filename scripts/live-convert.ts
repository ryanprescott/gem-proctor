// bun run live:convert [baseUrl] [--out file]: `convert-smoke` through a running converter (Marker, and the vision model on
// the Ollama box), the same set and scoring `bun test` runs on the mock (docs/P2.2.md M26). Stores nothing; prints one
// line per run, writes the full report as JSON, and exits 1 if a run with a bar fell short of it.
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ConvertClient, formatSmokeResult, runConvertSmoke } from "../packages/convert/src/index.ts";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: { out: { type: "string" } },
});
const base = positionals.find((a) => a.startsWith("http")) ?? "http://localhost:8200";
const out = values.out ?? join(homedir(), ".cache", "live-convert-report.json");
const client = new ConvertClient(base);

const health = await client.health();
console.log(
  `${health.engine} ${health.engineVersion}, models ${health.models}, worker starts ${health.workerStarts}\n`,
);
const report = await runConvertSmoke(client, undefined, (r) => console.log(formatSmokeResult(r)));
writeFileSync(out, `${JSON.stringify({ at: new Date().toISOString(), base, health, ...report }, null, 2)}\n`);
console.log(`\nconvert-smoke: ${report.pass ? "pass" : "FAIL"} (report: ${out})`);
process.exit(report.pass ? 0 : 1);
