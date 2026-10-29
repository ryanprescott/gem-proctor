import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { v7 } from "uuid";
import * as schema from "./schema.ts";

export type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool };

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max });
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema }) as Db;
}

/** UUID v7, generated in the app (P0.md §4). */
export function newId(): string {
  return v7();
}
