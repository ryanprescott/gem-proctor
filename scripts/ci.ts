// bun run ci — everything CI runs, locally (P0.md A1, S19). Fails on the first failing step.
// Postgres for the integration tests: TEST_PG_ADMIN_URL if set (CI uses the Compose postgres), otherwise
// the throwaway local cluster from scripts/pg-local.ts. Playwright runs against E2E_BASE_URL if set
// (CI: the Compose stack), otherwise against a throwaway local stack (scripts/e2e.ts).
import { delimiter, join } from "node:path";
import { adminUrl, findPgBin, ROOT, startLocalPg } from "./pg-local.ts";

const env: Record<string, string> = { ...(process.env as Record<string, string>) };
// Standalone tools (ruff, python3.12, Postgres) may live in ~/.local/bin.
env.PATH = [env.PATH, join(env.HOME ?? "", ".local", "bin")].filter(Boolean).join(delimiter);

const dockerUp = () => Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore", env }).exitCode === 0;

const steps: { name: string; cmd: string[]; cwd?: string; when?: () => boolean; skipped?: string }[] = [
  { name: "biome check", cmd: ["bunx", "--bun", "biome", "check", "."] },
  { name: "lint rule build is up to date", cmd: ["bun", "tools/biome/build-rule.ts", "--check"] },
  { name: "lint-rule snapshot", cmd: ["bun", "tools/biome/snapshot.ts", "--check"] },
  { name: "suppression baseline", cmd: ["bun", "tools/biome/check-suppressions.ts"] },
  { name: "i18n catalog check", cmd: ["bun", "tools/i18n/check-catalogs.ts"] },
  {
    name: "JSON Schema export is up to date",
    cmd: ["bun", "packages/shared/scripts/export-json-schema.ts", "--check"],
  },
  { name: "LLM imports stay in packages/llm", cmd: ["bun", "scripts/check-llm-imports.ts"] },
  { name: "typecheck", cmd: ["bun", "scripts/typecheck.ts"] },
  { name: "bun test", cmd: ["bun", "test"] },
  { name: "ruff (apps/verify)", cmd: ["ruff", "check", "apps/verify"] },
  { name: "ruff format (apps/verify)", cmd: ["ruff", "format", "--check", "apps/verify"] },
  {
    name: "verify unit tests",
    cmd: ["python3.12", "-B", "-m", "unittest", "discover", "-s", "tests", "-t", "."],
    cwd: "apps/verify",
  },
  {
    name: "verify escape suite",
    cmd: ["bun", "scripts/verify-escape.ts"],
    // Always in GitHub CI (a missing Docker fails there); on a machine without Docker it's skipped, and says so.
    when: () => env.CI === "true" || dockerUp(),
    skipped: "no Docker daemon: run `bun run verify:escape` where there is one",
  },
  { name: "Playwright + axe", cmd: ["bun", "scripts/e2e.ts"] },
];

if (!env.TEST_PG_ADMIN_URL) {
  if (!findPgBin("pg_ctl")) {
    console.error(
      "No TEST_PG_ADMIN_URL and no local Postgres binaries: see docs/DEVELOPMENT.md (or run against Compose).",
    );
    process.exit(1);
  }
  await startLocalPg();
  env.TEST_PG_ADMIN_URL = adminUrl();
}
env.REQUIRE_DB_TESTS = "1";

const only = process.argv.slice(2);
for (const step of steps) {
  if (only.length > 0 && !only.some((o) => step.name.includes(o))) continue;
  if (step.when && !step.when()) {
    console.log(`\n▷ ${step.name}: skipped (${step.skipped})`);
    continue;
  }
  const started = Date.now();
  console.log(`\n▶ ${step.name}`);
  const proc = Bun.spawn(step.cmd, { cwd: join(ROOT, step.cwd ?? ""), env, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (code !== 0) {
    console.error(`\n✘ ${step.name} failed (exit ${code}, ${secs}s)`);
    process.exit(code);
  }
  console.log(`✔ ${step.name} (${secs}s)`);
}
console.log("\nci: all steps passed");
