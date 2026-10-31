// bun run typecheck — TypeScript strict on every project (P0.md A3).
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
export const PROJECTS = [
  "tsconfig.json",
  "packages/shared/tsconfig.json",
  "packages/db/tsconfig.json",
  "packages/authz/tsconfig.json",
  "packages/llm/tsconfig.json",
  "packages/authoring/tsconfig.json",
  "apps/api/tsconfig.json",
  "apps/web/tsconfig.json",
];

let failed = false;
for (const project of PROJECTS) {
  const proc = Bun.spawn([join(ROOT, "node_modules", ".bin", "tsc"), "-p", project, "--noEmit"], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  console.log(`${code === 0 ? "ok  " : "FAIL"} ${project}`);
  failed ||= code !== 0;
}
process.exit(failed ? 1 : 0);
