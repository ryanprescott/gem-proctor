// Counts no-literal-ui-string suppressions in the web app and fails if the count grows beyond the
// committed baseline, or if a suppression has no reason (SPEC §11.6, "Escape hatch").
//   bun tools/biome/check-suppressions.ts            check
//   bun tools/biome/check-suppressions.ts --update   rewrite the baseline (review the diff)
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";
import { loadConfig } from "./build-rule.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BASELINE = join(import.meta.dir, "suppressions-baseline.txt");
const SUPPRESSION = /biome-ignore\s+lint\/plugin(?:\/[\w-]+)?\s*(?::\s*(.*?))?\s*(?:\*\/\s*\}?)?$/;

export function findSuppressions(): { entries: string[]; missingReason: string[] } {
  const cfg = loadConfig();
  const excluded = cfg.excludes.map((e) => new Glob(e));
  const entries: string[] = [];
  const missingReason: string[] = [];
  for (const pattern of cfg.includes) {
    for (const file of new Glob(pattern).scanSync({ cwd: ROOT })) {
      if (excluded.some((g) => g.match(file))) continue;
      readFileSync(join(ROOT, file), "utf8")
        .split("\n")
        .forEach((line, i) => {
          const m = SUPPRESSION.exec(line);
          if (!m) return;
          const reason = (m[1] ?? "").trim();
          if (reason === "") missingReason.push(`${file}:${i + 1}`);
          else entries.push(`${relative(ROOT, join(ROOT, file))} | ${reason}`);
        });
    }
  }
  return { entries: [...new Set(entries)].sort(), missingReason };
}

function readBaseline(): string[] {
  return readFileSync(BASELINE, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

if (import.meta.main) {
  const { entries, missingReason } = findSuppressions();
  if (process.argv.includes("--update")) {
    const header = "# no-literal-ui-string suppressions (SPEC §11.6). One line per suppression: file | reason.\n";
    writeFileSync(BASELINE, header + entries.map((e) => `${e}\n`).join(""));
    console.log(`baseline: ${entries.length} suppression(s)`);
    process.exit(0);
  }
  if (missingReason.length > 0) {
    console.error(`suppressions without a reason:\n  ${missingReason.join("\n  ")}`);
    process.exit(1);
  }
  const baseline = readBaseline();
  const added = entries.filter((e) => !baseline.includes(e));
  if (entries.length > baseline.length || added.length > 0) {
    console.error(
      `suppressions grew beyond the baseline (${entries.length} > ${baseline.length}). New:\n  ${added.join("\n  ")}\n` +
        "Update tools/biome/suppressions-baseline.txt in the same change so the exception is reviewed.",
    );
    process.exit(1);
  }
  console.log(`suppressions: ${entries.length} (baseline ${baseline.length})`);
}
