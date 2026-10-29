import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

/**
 * Runs `docker/postgres/init.sql` (the Compose init script) without psql, so local dev clusters and
 * integration tests set up roles exactly as Compose does. Supports the psql subset that file uses:
 * `:'var'` / `:"var"` / `:var` substitution, `\gexec` and `\connect`.
 */
export const INIT_SQL_PATH = join(import.meta.dir, "..", "..", "..", "docker", "postgres", "init.sql");

export interface BootstrapOptions {
  /** Superuser URL; its database is used for the role statements. */
  adminUrl: string;
  dbname: string;
  ownerPassword: string;
  appPassword: string;
}

function quoteLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function quoteIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function substitute(sql: string, vars: Record<string, string>): string {
  return sql.replace(/:(['"]?)([a-z_]+)\1/g, (m, q: string, name: string) => {
    const v = vars[name];
    if (v === undefined) return m;
    if (q === "'") return quoteLiteral(v);
    if (q === '"') return quoteIdent(v);
    return v;
  });
}

export function withDatabase(url: string, dbname: string): string {
  const u = new URL(url);
  u.pathname = `/${dbname}`;
  return u.toString();
}

export async function createDatabaseIfMissing(adminUrl: string, dbname: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbname]);
    if (exists.rowCount === 0) await client.query(`CREATE DATABASE ${quoteIdent(dbname)}`);
  } finally {
    await client.end();
  }
}

export async function bootstrapDatabase(opts: BootstrapOptions): Promise<void> {
  await createDatabaseIfMissing(opts.adminUrl, opts.dbname);
  const vars = { owner_password: opts.ownerPassword, app_password: opts.appPassword, dbname: opts.dbname };
  const lines = readFileSync(INIT_SQL_PATH, "utf8").split("\n");

  let client = new pg.Client({ connectionString: opts.adminUrl });
  await client.connect();
  try {
    let buffer = "";
    for (const raw of lines) {
      const line = raw.replace(/--.*$/, "");
      const connect = /^\\connect\s+(\S+)/.exec(line.trim());
      if (connect?.[1]) {
        await client.end();
        client = new pg.Client({ connectionString: withDatabase(opts.adminUrl, substitute(connect[1], vars)) });
        await client.connect();
        continue;
      }
      buffer += `${line}\n`;
      const trimmed = buffer.trim();
      if (trimmed.endsWith("\\gexec")) {
        const select = substitute(trimmed.slice(0, -"\\gexec".length), vars);
        const res = await client.query({ text: select, rowMode: "array" });
        for (const row of res.rows as unknown[][]) {
          for (const cell of row) if (typeof cell === "string") await client.query(cell);
        }
        buffer = "";
      } else if (trimmed.endsWith(";")) {
        await client.query(substitute(trimmed, vars));
        buffer = "";
      }
    }
  } finally {
    await client.end();
  }
}
