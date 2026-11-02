// bun run live:convert [baseUrl]: the fixture PDFs through a running converter (Marker and the vision model on the Ollama
// box), scored against what they should contain (docs/P2.2.md M26, M27). Stores nothing; prints one line per run and the
// full report as JSON.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvertClient, scoreConversion } from "../packages/convert/src/index.ts";
import type { ConvertOptions } from "../packages/shared/src/index.ts";

const base = process.argv.slice(2).find((a) => a.startsWith("http")) ?? "http://localhost:8200";
const dir = join(import.meta.dir, "..", "apps", "convert", "tests", "fixtures");
const expected = JSON.parse(readFileSync(join(dir, "linear-algebra.expected.json"), "utf8"));
const client = new ConvertClient(base);

const runs: { name: string; file: string; options: ConvertOptions }[] = [
  { name: "scan, rasterize", file: "linear-algebra-scan.pdf", options: { strategy: "rasterize" } },
  { name: "text PDF, rasterize", file: "linear-algebra.pdf", options: { strategy: "rasterize" } },
  { name: "text PDF, text layer", file: "linear-algebra.pdf", options: { strategy: "text" } },
  { name: "text PDF, page 2 only", file: "linear-algebra.pdf", options: { strategy: "rasterize", pageRange: "2" } },
];

const health = await client.health();
console.log(
  `${health.engine} ${health.engineVersion}, models ${health.models}, worker starts ${health.workerStarts}\n`,
);
const report: unknown[] = [];
for (const run of runs) {
  const started = Date.now();
  try {
    const reply = await client.convert(readFileSync(join(dir, run.file)), run.options);
    const score = scoreConversion(reply.markdown, expected);
    const seconds = (Date.now() - started) / 1000;
    console.log(
      `${run.name.padEnd(24)} ${seconds.toFixed(1).padStart(6)} s  ${reply.pagesConverted}/${reply.pageCount} pages  ` +
        `formulas ${score.formulasMatched}/${score.formulasExpected} (${score.formulasInOutput} in output)  ` +
        `headings ${score.headingsFound}/${score.headingsExpected}`,
    );
    report.push({ ...run, seconds, converterSeconds: reply.seconds, pages: reply.pagesConverted, score });
  } catch (err) {
    console.log(`${run.name.padEnd(24)} FAILED: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    report.push({ ...run, error: String(err) });
  }
}
console.log(`\n${JSON.stringify(report, null, 2)}`);
