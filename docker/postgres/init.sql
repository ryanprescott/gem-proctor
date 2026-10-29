-- Runs once as the superuser when the database is created (docker-entrypoint-initdb.d, or scripts/dev-pg.ts).
-- psql variables: owner_password, app_password, dbname.
-- P0.md §4: gem_owner owns the schema and runs migrations; gem_app is the API's runtime user.

SELECT format('CREATE ROLE gem_owner LOGIN PASSWORD %L', :'owner_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gem_owner') \gexec
SELECT format('CREATE ROLE gem_app LOGIN PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gem_app') \gexec

-- gem_owner may create objects owned by gem_app (the pgboss schema) without inheriting its rights.
GRANT gem_app TO gem_owner WITH INHERIT FALSE, SET TRUE;

\connect :dbname
ALTER DATABASE :"dbname" OWNER TO gem_owner;
ALTER SCHEMA public OWNER TO gem_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE :"dbname" TO gem_app;
-- pgvector isn't a trusted extension: create it here, as the superuser (migration 0000 then no-ops).
CREATE EXTENSION IF NOT EXISTS vector;
