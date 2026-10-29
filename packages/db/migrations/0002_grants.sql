-- P0.md §4: two DB roles. gem_owner (this migration's user) owns the schema; gem_app runs the API.
-- gem_app gets SELECT/INSERT/UPDATE/DELETE on everything except audit_log, where it has SELECT/INSERT only
-- (SPEC §1.3: the app never updates or deletes audit rows).
GRANT USAGE ON SCHEMA public TO gem_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gem_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gem_app;
--> statement-breakpoint
REVOKE ALL ON TABLE audit_log FROM gem_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE audit_log TO gem_app;
--> statement-breakpoint
-- pg-boss keeps its queue tables in its own schema, owned by the app role so it can manage them.
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION gem_app;
