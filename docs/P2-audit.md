# P2 audit

Audit of P2.md §8, feature by feature, each section written when its feature was finished (P2.md §10). Each criterion is **pass**, **fail**, **partial**, **blocked** or **dropped**, with evidence.

**Environment.** WSL2 with Docker and Compose, default runtime runc, no gVisor. Postgres 17 + pgvector 0.8 from the local binaries, Python 3.12 with the pinned libraries, Playwright's Chromium. Each `bun run ci` ran on a snapshot of the tree in `~/.cache` (tracked and new files, no `.env`, a fresh `bun install --frozen-lockfile`), so editing can't change what a run tests.

## F1 Sources & ingest

Built: every §4 table in `packages/db/src/schema.ts`, migrations `0009_p2_authoring_tables.sql` (generated) and `0010_p2_grants.sql` (hand-written). `packages/knowledge`: `parse.ts` (remark, sections, block units), `chunk.ts`, `ingest.ts` (saving a revision, the embedding job's work, reuse). `packages/shared/src/sources.ts`, contracts for the source routes, seven error codes, four audit actions. `apps/api/src/sources.ts` (the `source.embed` pg-boss job), `routes/sources.ts`, `events.ts` (the event hub and SSE). `InstanceSettings.authoring`. Casbin object `source`, and the private-resource rule in `http/route.ts`. Tests: `packages/knowledge/test/chunk.test.ts`, `apps/api/test/sources.test.ts`, the matrix in `authz.test.ts`.

| # | Result | Evidence |
|---|---|---|
| E1 | **pass** | `sources.test.ts` "E1": `pg_indexes` shows `USING hnsw (embedding vector_cosine_ops)` and `USING gin (tsv)`; `tsv` is generated from both configs; `embedding` is `vector(768)`; `test_authoring_session_fk` and `verification_run.draft_question_id`'s FK exist; `has_table_privilege` over the three append-only tables. On real rows as `gem_app`: `UPDATE` and `DELETE` on `question_event`, `validation_result`, `retrieval_log` fail 42501; on `source_chunk`, `UPDATE` of `text`, `chunk_key`, `content_hash`, `char_start` and any `DELETE` fail 42501, while the flag and embedding columns update. |
| E2 | **pass** | "E2": paste creates, audited `source.create`; upload as multipart, `.md` and `.txt` with their formats, `.pdf` 415 `source_bad_type`; the cap is the instance setting, by paste and by upload, 413 `source_too_large` with `maxBytes`; empty text 400; preview leaves the revision count unchanged and returns the tree, with `no_headings`, `duplicate_heading` and `long_section`. |
| E3 | **pass** | `chunk.test.ts` "E3": nesting, heading paths, text before the first heading, no headings; plain text is one section by paragraph and `#` isn't a heading there. `sources.test.ts` "E3 + E4" through the routes. |
| E4 | **pass** | `chunk.test.ts` "E4": target size, offsets on mixed content and CRLF, overlap bounded by `OVERLAP_TOKENS`, a code block, a table and a `$$` block each whole in one chunk, inline math never cut, LaTeX as written, a run-on sentence cut between words. Through the routes: `markdown.slice(charStart, charEnd)` equals each chunk's text. |
| E5 | **pass** | `chunk.test.ts` "E5"; `sources.test.ts` "E5": a code block over the cap is 422 `knowledge_unit_too_large` with `heading: "Big › Code"`, nothing saved, no embedding request. P1.5's guard through ingest: a chunk that estimates under the cap but counts at it fails the job `llm_embedding_truncated`, 0 embedded, not usable. |
| E6 | **pass** | `sources.test.ts` "E6": the input sent starts `document-prefix: `; the stored text, `tsv` and `chunk_key` don't have it. |
| E7 | **pass** | "E7": revision 2 is new rows, revision 1's are unchanged and still served; editing one sentence sends exactly 1 chunk to the model, and the others copy their vectors; a different model re-embeds every chunk and stores its own id. |
| E8 | **pass** | "E8": dimension mismatch stored as `{ expected: 768, actual: 1024 }`; a wrong-length reply stored as `llm_endpoint_error`; `embeddings` unassigned stored as `llm_role_unassigned`; each not usable, and usable after `embed:retry`; a retry of what didn't fail is 409. |
| E9 | **pass** | "E9": another proctor 404 `source_not_found` on every route, an empty list; a student 403; an admin reads. `authz.test.ts`: every source route × 5 callers (`hidden` is the new expectation). |
| E10 | **pass** | "E10": a stored vector reads back at 768 dimensions and unit norm. `EXPLAIN` of a nearest-neighbour query filtered by model shows `source_chunk_embedding_idx` with `enable_seqscan`, `enable_bitmapscan` and `enable_sort` off. **Why those are off:** on a test table this small the planner rightly prefers a seq scan, so the test shows the index can serve the query, not that the planner picks it at this size. |

**`bun run ci`:** all steps pass, exit 0.

```
✔ biome check                       ✔ LLM imports stay in packages/llm
✔ lint rule build is up to date     ✔ typecheck (9 projects)
✔ lint-rule snapshot                ✔ bun test — 777 pass, 0 fail, 29 files
✔ suppression baseline              ✔ ruff + ruff format, verify unit tests (73)
✔ i18n catalog check (658 keys)     ✔ verify escape suite — 40/40
✔ JSON Schema export is up to date  ✔ Playwright + axe — 35 passed
```

**Deviations and notes** (for SPEC §15.2 at phase close).
- **`AuthoringBatch` is a new table.** `POST /authoring/batches/:id/retry` and "a failed batch shown with its code" need a row per batch, and §4 doesn't list one.
- **Sessions and sources are soft-deleted** (`deleted_at`). `QuestionEvent`, `ValidationResult` and `RetrievalLog` are append-only, so a session's rows can't be deleted; published citations must keep resolving, so a source's can't either.
- **`DELETE /sources/:id` and `GET /sources/:id/events` are added.** §5 audits a source delete and streams embedding progress, but §6 lists neither route.
- `RetrievalLog.objective_id` has no FK, like `audit_log.actor_id`: a creator can remove an objective, and an append-only row can't stop that.
- `SourceChunk.token_count` is in the column grant with the embedding columns: it starts as the estimate and becomes the endpoint's own count, as §5 says.
- `Objective.origin` adds `heading` to SPEC's `llm | human`, so a heading-based start can be told from a human one. `AuthoringSessionSource` carries the revision and section ids: that's the scope.
- A chunk includes its section's heading line, so the text retrieval sends has its context. Offsets still slice back exactly.
- `embeddingModelId` is the role's model id. §5 adds the digest "where known"; the runtime doesn't know it, so models are compared by id alone. A retagged model with the same id would be treated as the same model.
- `apps/api/test/llm-db.test.ts`: two `toEqual`s on the settings object gained `authoring`, because the object did; what they check is unchanged.
- Found by the tests: paragraph splitting ignored a cap below the 500-token target, so ordinary text was refused; a heading joined to a full chunk went over it; and with pieces at the limit no overlap fit. An oversized upload answered the generic `payload_too_large`.
- `once=true` on the events route sends one state and closes, for a client that can't hold a stream; the authz matrix uses it, because `inject` can't finish on a stream.

## F2 Retrieval & scope

Built: `packages/knowledge/src/retrieve.ts` (the scope filter, vector search, full text, reciprocal-rank fusion, neighbours, `RetrievalLog`), `POST /sources/:id/scope/estimate`. Mock: `embedVector`, so a test can say two texts mean the same. Tests: `apps/api/test/retrieval.test.ts`, the matrix.

| # | Result | Evidence |
|---|---|---|
| E11 | **pass** | `retrieval.test.ts` "E11": the best match by vector and by text comes back unscoped, and not at all when its section is out of scope, in the SQL of both searches; a section stands for what's under it; another revision of the same source is out of scope; an empty scope returns nothing and calls no model. |
| E12 | **pass** | "E12": `x^T y` finds its chunk with `textRank: 1`; a paraphrase sharing no word finds its chunk with `vectorRank: 1`, `textRank: null`; a stemmed word matches; `fuse` merges by rank with the exact RRF score, ties by key whichever list came first; the same query gives the same ranks. |
| E13 | **pass** | "E13": `query-prefix: …` is what's sent; with another model assigned, no chunk has a `vectorRank`, and full text still works. |
| E14 | **pass** | "E14": the row has the query, scope, chunk ids in order, ranks, scores and model. |
| E15 | **pass** | "E15": a small budget gets fewer tokens and a large one more, neither over; neighbours (`rank: null`) fill the budget past the 40 each search returns; a budget too small for any chunk returns nothing, not an oversized chunk; the estimate route gives chunks and tokens equal to the sections' sums, and per role `assigned`, `budget`, `fits`, with no model name. |

**`bun run ci`:** all steps pass, exit 0.

```
✔ biome check                       ✔ LLM imports stay in packages/llm
✔ lint rule build is up to date     ✔ typecheck (9 projects)
✔ lint-rule snapshot                ✔ bun test — 798 pass, 0 fail, 30 files
✔ suppression baseline              ✔ ruff + ruff format, verify unit tests (73)
✔ i18n catalog check (658 keys)     ✔ verify escape suite — 40/40
✔ JSON Schema export is up to date  ✔ Playwright + axe — 35 passed
```

**Deviations and notes.**
- `tsv` holds both configs in one column, and a query asks both: `simple` keeps notation, `english` stems. §5 says "`simple` config, with `english` alongside".
- Words are OR-ed, not AND-ed: an objective's label rarely has all its words in one chunk. A chunk holding the query as a phrase ranks first, which is what makes a notation query exact.
- The vector search sets `hnsw.iterative_scan = relaxed_order` for its transaction, since a filtered HNSW scan can otherwise run out of candidates, and re-sorts by distance. With 40 candidates and a small scope, the planner mostly uses the revision and section indexes and an exact sort anyway.
- A chunk bigger than what's left of the budget is skipped, and smaller ones after it can still fit. So the budget holds strictly, and `llm_context_exceeded` can't come from chunks (the prompt's own share comes in F5).
- E15's `fits` compares against `contextWindow − maxOutputTokens`. The instructions' share is F5's; here "fits" means the source text alone.
