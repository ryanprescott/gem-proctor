// Writes the generated JSON Schemas: packages/shared/schema/ (for review) and the sandbox contract in
// apps/verify/gem_verify/contract.json.
//   --check   fail if the committed files are stale
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { quizJsonSchema, resultJsonSchema, verifyContractSchema } from "../src/json-schema.ts";

const dir = join(import.meta.dir, "..", "schema");
const verifyDir = join(import.meta.dir, "..", "..", "..", "apps", "verify", "gem_verify");
const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const files = [
  { path: join(dir, "quiz.json"), text: pretty(quizJsonSchema()) },
  { path: join(dir, "result.json"), text: pretty(resultJsonSchema()) },
  { path: join(verifyDir, "contract.json"), text: pretty(verifyContractSchema()) },
];

if (process.argv.includes("--check")) {
  const stale = files.filter(({ path, text }) => {
    try {
      return readFileSync(path, "utf8") !== text;
    } catch {
      return true;
    }
  });
  if (stale.length > 0) {
    console.error(
      `stale JSON Schema export: ${stale.map((f) => basename(f.path)).join(", ")}. Run: bun run schema:export`,
    );
    process.exit(1);
  }
  console.log("JSON Schema export is up to date");
} else {
  mkdirSync(dir, { recursive: true });
  for (const { path, text } of files) writeFileSync(path, text);
  console.log(`wrote ${files.map((f) => basename(f.path)).join(", ")}`);
}
