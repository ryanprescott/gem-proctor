// C19, C12: nothing outside packages/llm imports the AI SDK, and the runtime's shared code names no model
// or server (those live in the provider adapters and in `RoleAssignment.params`).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");
const SOURCE = "{apps,packages,tools,scripts}/**/*.{ts,tsx}";
const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["'](ai|@ai-sdk\/[^"']+)["']/;
/** The runtime proper: everything in `src` except the adapters. */
const QUIRK_NAMES = /\b(qwen|ollama|vllm|llama\.?cpp|lmstudio|gemma)\b/i;

const problems: string[] = [];
for (const file of new Glob(SOURCE).scanSync({ cwd: ROOT, dot: false })) {
  if (file.includes("node_modules/") || file.includes("__fixtures__/")) continue;
  const text = readFileSync(join(ROOT, file), "utf8");
  if (!file.startsWith("packages/llm/") && IMPORT.test(text)) problems.push(`${file}: imports the AI SDK`);
  if (file.startsWith("packages/llm/src/") && !file.startsWith("packages/llm/src/providers/")) {
    if (QUIRK_NAMES.test(text)) problems.push(`${file}: names a model or server`);
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("LLM imports OK");
