// Runs the active no-literal-ui-string implementation on the fixtures and compares its diagnostics with
// the committed tool-neutral snapshot (SPEC §11.6): one `file:line:col case-id` line per diagnostic.
//   bun tools/biome/snapshot.ts            print
//   bun tools/biome/snapshot.ts --check    fail if it differs from __fixtures__/snapshot.txt
//   bun tools/biome/snapshot.ts --update   rewrite the snapshot (scope changes need their own review)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { GRIT_PATH, loadConfig } from "./build-rule.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURES = join(import.meta.dir, "__fixtures__");
const SNAPSHOT = join(FIXTURES, "snapshot.txt");

interface BiomeDiagnostic {
  category?: string;
  message?: string;
  location?: { path?: string; start?: { line: number; column: number } };
}

/** Adapter for the primary implementation: Biome JSON reporter → neutral format. */
export async function runFixtures(): Promise<string[]> {
  const cfg = loadConfig();
  const dir = join(ROOT, ".dev", "biome-fixtures");
  mkdirSync(dir, { recursive: true });
  const config = {
    root: true,
    vcs: { enabled: false },
    formatter: { enabled: false },
    assist: { enabled: false },
    linter: { rules: { preset: "none" } },
    plugins: [{ path: GRIT_PATH, includes: ["**/__fixtures__/**/*.tsx", ...cfg.excludes.map((e) => `!${e}`)] }],
  };
  writeFileSync(join(dir, "biome.json"), JSON.stringify(config, null, 2));
  const biome = join(ROOT, "node_modules", "@biomejs", "biome", "bin", "biome");
  const proc = Bun.spawn(
    [biome, "lint", `--config-path=${dir}`, "--reporter=json", "--max-diagnostics=none", FIXTURES],
    {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const json = JSON.parse(out.slice(out.indexOf("{"))) as { diagnostics: BiomeDiagnostic[] };
  const lines: string[] = [];
  for (const d of json.diagnostics) {
    if (d.category !== "plugin") {
      throw new Error(`unexpected diagnostic: ${d.category} ${d.message} at ${d.location?.path}`);
    }
    const id = /\[(F\d)\]$/.exec(d.message ?? "")?.[1];
    if (!id) throw new Error(`plugin diagnostic without case id: ${d.message}`);
    const start = d.location?.start;
    lines.push(`${basename(d.location?.path ?? "")}:${start?.line}:${start?.column} ${id}`);
  }
  const key = (l: string) => {
    const [file, line, col] = l.split(/[: ]/);
    return [file ?? "", Number(line).toString().padStart(6, "0"), Number(col).toString().padStart(6, "0")].join(":");
  };
  return lines.sort((a, b) => key(a).localeCompare(key(b)));
}

if (import.meta.main) {
  const lines = await runFixtures();
  const text = `${lines.join("\n")}\n`;
  if (process.argv.includes("--update")) {
    writeFileSync(SNAPSHOT, text);
    console.log(`wrote ${lines.length} diagnostics to ${SNAPSHOT}`);
  } else if (process.argv.includes("--check")) {
    const expected = readFileSync(SNAPSHOT, "utf8");
    if (expected !== text) {
      console.error(`lint-rule snapshot mismatch.\n--- expected\n${expected}--- actual\n${text}`);
      process.exit(1);
    }
    console.log(`lint-rule snapshot matches (${lines.length} diagnostics)`);
  } else {
    process.stdout.write(text);
  }
}
