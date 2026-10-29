// bun run e2e — Playwright + axe end-to-end tests (P0.md A1, A30–A32).
//   E2E_BASE_URL=http://localhost:3000 bun run e2e   run against a running stack (e.g. Compose)
//   bun run e2e                                      start a throwaway stack: fresh database on the local
//                                                    Postgres (TEST_PG_ADMIN_URL or .dev/pg), built web app,
//                                                    API on port 3100, and the real verify parent if Python is there
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapDatabase, withDatabase } from "@gem/db";
import pg from "pg";
import { adminUrl, ROOT, startLocalPg } from "./pg-local.ts";

const WEB = join(ROOT, "apps", "web");
const extraArgs = process.argv.slice(2);

async function runPlaywright(baseUrl: string, env: Record<string, string> = {}): Promise<number> {
  const proc = Bun.spawn([join(WEB, "node_modules", ".bin", "playwright"), "test", ...extraArgs], {
    cwd: WEB,
    env: { ...process.env, ...env, E2E_BASE_URL: baseUrl },
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error(`timed out waiting for ${url}`);
}

function findVerifyPython(): string | undefined {
  const candidates = [
    process.env.VERIFY_PYTHON,
    Bun.which("python3.12"),
    join(process.env.HOME ?? "", ".local", "bin", "python3.12"),
  ];
  return candidates.find(
    (p): p is string => !!p && existsSync(p) && Bun.spawnSync([p, "-c", "import sympy, numpy, lark"]).exitCode === 0,
  );
}

if (process.env.E2E_BASE_URL) {
  process.exit(await runPlaywright(process.env.E2E_BASE_URL));
}

// ── Throwaway stack ──────────────────────────────────────────────────
let admin = process.env.TEST_PG_ADMIN_URL;
if (!admin) {
  await startLocalPg();
  admin = adminUrl();
}
const ownerPw = process.env.GEM_OWNER_PASSWORD ?? "change-me";
const appPw = process.env.GEM_APP_PASSWORD ?? "change-me";
const dbname = `gem_e2e_${randomBytes(4).toString("hex")}`;
await bootstrapDatabase({ adminUrl: admin, dbname, ownerPassword: ownerPw, appPassword: appPw });
const roleUrl = (role: string, pw: string) => {
  const u = new URL(admin as string);
  u.username = role;
  u.password = pw;
  return withDatabase(u.toString(), dbname);
};

console.log("building the web app…");
if (Bun.spawnSync(["bun", "run", "build"], { cwd: WEB, stdout: "ignore", stderr: "inherit" }).exitCode !== 0) {
  throw new Error("web build failed");
}

const children: { kill(): void; exited: Promise<number> }[] = [];
const socket = join(mkdtempSync(join(tmpdir(), "gem-e2e-")), "verify", "verify.sock");
const python = findVerifyPython();
if (python) {
  children.push(
    Bun.spawn([python, "-I", "-B", join(ROOT, "apps", "verify", "gem_verify", "server.py"), socket], {
      env: {},
      stdout: "ignore",
      stderr: "inherit",
    }),
  );
}

const port = process.env.E2E_PORT ?? "3100";
const api = Bun.spawn(["bun", join(ROOT, "apps", "api", "src", "main.ts")], {
  cwd: ROOT,
  env: {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: "development",
    API_HOST: "127.0.0.1",
    API_PORT: port,
    DATABASE_URL: roleUrl("gem_app", appPw),
    DATABASE_URL_OWNER: roleUrl("gem_owner", ownerPw),
    SESSION_SECRET: randomBytes(32).toString("base64"),
    ADMIN_EMAIL: "",
    ADMIN_PASSWORD: "",
    VERIFY_SOCKET: socket,
    WEB_DIST: join(WEB, "dist"),
    MIGRATE_ON_START: "true",
    ENV_FILE: "/dev/null",
  },
  stdout: process.env.E2E_API_LOG ? "inherit" : "ignore",
  stderr: "inherit",
});
children.push(api);

let code = 1;
try {
  await waitFor(`http://127.0.0.1:${port}/api/v1/health`, 60_000);
  code = await runPlaywright(`http://127.0.0.1:${port}`);
} finally {
  for (const c of children) c.kill();
  await Promise.all(children.map((c) => c.exited));
  const client = new pg.Client({ connectionString: admin });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS "${dbname}" WITH (FORCE)`);
  await client.end();
}
process.exit(code);
