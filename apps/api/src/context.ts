import type { Authz } from "@gem/authz";
import type { Db } from "@gem/db";
import type { SessionStore } from "./auth/sessions.ts";
import type { Config } from "./config.ts";
import type { Queue } from "./queue.ts";
import type { VerifyClient } from "./verify-client.ts";

/** Everything route handlers depend on; built once in main.ts (or per test). */
export interface AppContext {
  config: Config;
  db: Db;
  authz: Authz;
  sessions: SessionStore;
  queue: Queue | null;
  verify: VerifyClient;
  now: () => Date;
}
