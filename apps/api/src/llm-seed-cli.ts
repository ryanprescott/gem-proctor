// bun run llm:seed: applies the dev LLM seed to the database in `.env` (P1.5.md §5).
import { join } from "node:path";
import { createDb, createPool } from "@gem/db";
import { loadConfig } from "./config.ts";
import { seedDevLlm } from "./llm-seed.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const config = loadConfig(process.env, process.env.ENV_FILE ?? join(ROOT, ".env"));
const pool = createPool(config.DATABASE_URL, 2);
await seedDevLlm({ config, db: createDb(pool) }, console.log);
await pool.end();
console.log("llm seed: done");
