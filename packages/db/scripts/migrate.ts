// bun run db:migrate — applies migrations as gem_owner (DATABASE_URL_OWNER).
import { runMigrations } from "../src/migrate.ts";

const url = process.env.DATABASE_URL_OWNER;
if (!url) {
  console.error("DATABASE_URL_OWNER is not set");
  process.exit(1);
}
await runMigrations(url);
console.log("migrations applied");
