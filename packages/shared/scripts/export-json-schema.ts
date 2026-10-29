// Writes the generated JSON Schemas to packages/shared/schema/ (for the Python side and for review).
//   --check   fail if the committed files are stale
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { quizJsonSchema, resultJsonSchema } from "../src/json-schema.ts";

const dir = join(import.meta.dir, "..", "schema");
const files = {
  "quiz.json": `${JSON.stringify(quizJsonSchema(), null, 2)}\n`,
  "result.json": `${JSON.stringify(resultJsonSchema(), null, 2)}\n`,
};

if (process.argv.includes("--check")) {
  const stale = Object.entries(files).filter(([name, text]) => {
    try {
      return readFileSync(join(dir, name), "utf8") !== text;
    } catch {
      return true;
    }
  });
  if (stale.length > 0) {
    console.error(`stale JSON Schema export: ${stale.map(([n]) => n).join(", ")}. Run: bun run schema:export`);
    process.exit(1);
  }
  console.log("JSON Schema export is up to date");
} else {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  console.log(`wrote ${dir}/quiz.json, result.json`);
}
