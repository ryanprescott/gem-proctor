-- P0.md S3 / SPEC §10: pgvector from day one.
-- pgvector is not a trusted extension, so the Compose init script (superuser) creates it first;
-- here it is a no-op that documents and checks the dependency.
CREATE EXTENSION IF NOT EXISTS vector;
