// `bun scripts/test-db.ts <test files…>`: bun test against the local dev Postgres, as `bun run ci` runs it.
import { adminUrl } from "./pg-local.ts";

const proc = Bun.spawn(["bun", "test", ...process.argv.slice(2)], {
  env: { ...process.env, TEST_PG_ADMIN_URL: process.env.TEST_PG_ADMIN_URL ?? adminUrl(), REQUIRE_DB_TESTS: "1" },
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await proc.exited);
