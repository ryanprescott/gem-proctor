# @gem/knowledge

The knowledge base (SPEC §3C): Markdown → sections → chunks (`parse.ts`, `chunk.ts`, pure), saving a revision and embedding it (`ingest.ts`), and hybrid retrieval. It depends on `@gem/db` and `@gem/llm`, and on no framework, so it can be tested against a test Postgres without the server (SPEC §11.2).
