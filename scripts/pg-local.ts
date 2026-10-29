// A throwaway local Postgres 17 (+ pgvector) for development and CI when Docker isn't available
// (P0.md §9). Uses initdb/pg_ctl from PG_BIN, PATH, ~/.local/bin or the micromamba env documented in
// docs/DEVELOPMENT.md. Data lives in .dev/pg (gitignored).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

export const ROOT = join(import.meta.dir, "..");
export const PG_DIR = join(ROOT, ".dev", "pg");
export const PG_PORT = Number(process.env.DEV_PG_PORT ?? 54329);
export const SUPERUSER_PASSWORD = "postgres";

export function findPgBin(name: string): string | undefined {
  const dirs = [
    process.env.PG_BIN,
    ...(process.env.PATH ?? "").split(delimiter),
    join(process.env.HOME ?? "", ".local", "bin"),
    join(process.env.HOME ?? "", ".local", "share", "gem-dev", "bin"),
  ].filter((d): d is string => !!d);
  for (const d of dirs) {
    const p = join(d, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

async function run(cmd: string[], opts: { quiet?: boolean } = {}): Promise<number> {
  const proc = Bun.spawn(cmd, { stdout: opts.quiet ? "ignore" : "inherit", stderr: opts.quiet ? "ignore" : "inherit" });
  return await proc.exited;
}

export function adminUrl(db = "postgres"): string {
  return `postgres://postgres:${SUPERUSER_PASSWORD}@127.0.0.1:${PG_PORT}/${db}`;
}

export async function isRunning(): Promise<boolean> {
  const pgCtl = findPgBin("pg_ctl");
  if (!pgCtl || !existsSync(join(PG_DIR, "PG_VERSION"))) return false;
  return (await run([pgCtl, "-D", PG_DIR, "status"], { quiet: true })) === 0;
}

export async function startLocalPg(): Promise<void> {
  const initdb = findPgBin("initdb");
  const pgCtl = findPgBin("pg_ctl");
  if (!initdb || !pgCtl) throw new Error("initdb/pg_ctl not found: set PG_BIN or see docs/DEVELOPMENT.md");
  if (!existsSync(join(PG_DIR, "PG_VERSION"))) {
    mkdirSync(PG_DIR, { recursive: true });
    const pwfile = join(ROOT, ".dev", "pg-superuser.pw");
    writeFileSync(pwfile, SUPERUSER_PASSWORD);
    const code = await run(
      [initdb, "-D", PG_DIR, "-U", "postgres", "--auth=scram-sha-256", `--pwfile=${pwfile}`, "-E", "UTF8"],
      {
        quiet: true,
      },
    );
    if (code !== 0) throw new Error(`initdb failed (${code})`);
  }
  if (await isRunning()) return;
  const code = await run(
    [
      pgCtl,
      "-D",
      PG_DIR,
      "-l",
      join(ROOT, ".dev", "pg.log"),
      "-w",
      "-o",
      // TCP only: a Unix socket in the workspace breaks tools that snapshot it (e.g. zeroshot checkpoints).
      `-p ${PG_PORT} -c unix_socket_directories= -c listen_addresses=127.0.0.1`,
      "start",
    ],
    { quiet: true },
  );
  if (code !== 0) throw new Error(`pg_ctl start failed (${code}); see .dev/pg.log`);
}

export async function stopLocalPg(): Promise<void> {
  const pgCtl = findPgBin("pg_ctl");
  if (pgCtl && (await isRunning())) await run([pgCtl, "-D", PG_DIR, "-m", "fast", "stop"], { quiet: true });
}
