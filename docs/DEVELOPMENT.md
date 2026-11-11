# Development

## Prerequisites

- **Bun 1.4.4** (package manager, test runner, API runtime).
- **Postgres 17 + pgvector**: either Docker (Compose, below) or local binaries.
- **Python 3.12** with the pinned verify libraries (`apps/verify/requirements.txt`) and **ruff 0.17.3**, for `apps/verify`.
- **Playwright's Chromium**: `bunx --cwd apps/web playwright install chromium` (cached in `~/.cache/ms-playwright`).

Without Docker (e.g. WSL without Docker Desktop integration), everything except the Compose checks runs on local binaries. One way to get them without root, all under `~/.local`:

```sh
curl -Ls https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xj -C ~/.local bin/micromamba
~/.local/bin/micromamba create -y -p ~/.local/share/gem-dev -c conda-forge \
  postgresql=17 pgvector python=3.12 ruff=0.17.3 sympy=1.13.3 numpy=2.1.3 lark=1.2.2
for b in initdb pg_ctl postgres psql ruff python3.12; do ln -sf ~/.local/share/gem-dev/bin/$b ~/.local/bin/$b; done
```

The scripts look for `initdb` / `pg_ctl` in `PG_BIN`, `PATH`, `~/.local/bin` and `~/.local/share/gem-dev/bin`.

## Setup

```sh
bun install
cp .env.example .env        # then fill in SESSION_SECRET (openssl rand -base64 32) and passwords
```

`.env` is validated at API startup (P0.md §5): a missing or malformed key, or a key the schema doesn't know, stops the API with the key's name.

## Running

| Command | What it does |
|---|---|
| `docker compose up --build` | The whole stack (postgres, web build, api on :3000, verify). See `docker/compose.yaml`. |
| `bun run dev:pg` | Local Postgres in `.dev/pg` on 127.0.0.1:54329, the dev database set up with the Compose init script and migrated. Prints the two URLs for `.env`. `bun run dev:pg stop` stops it. |
| `bun run dev:api` | API with reload (needs `DATABASE_URL*` pointing at a migrated database). |
| `bun run dev:web` | Vite on :5173, proxying `/api` to the API. |
| `bun run ci` | Everything CI runs (below). |
| `bun run verify:escape` | The escape suite against the real Compose `verify` service (`--runtime runsc` for gVisor). See "Sandbox" below. |
| `bun run e2e` | Playwright + axe. Starts a throwaway stack (fresh database, built web app, API on :3100, the real verify parent), or uses `E2E_BASE_URL`. Either way it runs a mock model server for the LLM page (`E2E_MOCK_HOST` is the name a stack in containers reaches it by; CI uses `host.docker.internal`). |

## LLM (P1.5)

Nothing in `bun run ci` needs a model server: tests and e2e use the mock in `packages/llm/mock/server.ts`.

| Command | What it does |
|---|---|
| `bun run llm:seed` | Creates the `LLM_DEV_*` endpoint(s) and role assignments once (also on API start in development). Never overwrites an assignment. |
| `bun run llm:eval <set> [--trials n] [--dev]` | Runs an eval set (`generate-smoke`, `grounding-smoke`, `retrieval-mini`, `l7-smoke`, which needs the sandbox at `VERIFY_SOCKET`) from the database's assignments and stores the run; with `--dev`, from `LLM_DEV_*`, with nothing stored. |
| `bun run llm:live [--trials n] [--embed-model tag]… [--only name]` | The live checks against the `LLM_DEV_*` server: discovery, chat probe, `generate-smoke`, embeddings probes, `retrieval-mini`. `--only` runs the checks whose name contains it. Stores nothing; exits 1 if a check failed. |

`llm:live` also runs flow A on `generate-smoke` (programs, the sandbox, built options) and `l7-smoke`, on a local verify parent: it runs what a trusted dev model wrote, so don't point it at anything else.

Keys: `ENDPOINT_SECRET_KEY` (32 random bytes, base64) is needed to save an endpoint key. Cloud keys stay in the shell environment or the admin UI, never in the repo.

### Reference local setup (Ollama, 12 GB GPU)

```
# qwen3.5-9b-32k: ollama create qwen3.5-9b-32k -f <this file>
FROM qwen3.5:9b
PARAMETER num_ctx 32768

# embeddinggemma2-4k: both settings are needed, or inputs are cut at 2,048 tokens without an error
FROM embeddinggemma-2:270m
PARAMETER num_ctx 4096
PARAMETER num_batch 4096
```

Assignment for the chat roles, as `.env` values (`LLM_DEV_PARAMS` is optional; `llm:live` on P1.5 used exactly this):

```sh
LLM_DEV_SERVER=ollama
LLM_DEV_MODEL=qwen3.5-9b-32k
LLM_DEV_CONTEXT=32768
LLM_DEV_STRUCTURED_MODE=native_schema
LLM_DEV_PARAMS={"temperature":0.7,"top_p":0.8,"top_k":20,"presence_penalty":0,"reasoning_effort":"none"}
LLM_DEV_EMBED_MODEL=embeddinggemma2-4k
LLM_DEV_EMBED_DIM=768
LLM_DEV_EMBED_MAX_INPUT_TOKENS=4096
LLM_DEV_EMBED_QUERY_PREFIX="task: search result | query: "
LLM_DEV_EMBED_DOCUMENT_PREFIX="title: none | text: "
```

Other servers set their context at launch (vLLM `--max-model-len`, `llama-server -c`); the probe reports what they were started with. The cloud setup is an `anthropic` or OpenAI-compatible endpoint with `location: cloud` and the role's `maxOutputTokens` set for that model. These are starting points, not guarantees (SPEC §3B.2).

## Sandbox (P2.1)

`apps/verify` runs model-written programs (SPEC §3A.3.1). Security comes from the container, not from the code: no network, read-only root, no capabilities but `SETUID`/`SETGID`, a fresh unprivileged process per run, recycling. The parent (`server.py`) is single-threaded and never runs a program; `child.py` drops everything and runs one request.

- **Contract:** Zod in `packages/shared/src/verify.ts`. After changing it, run `bun run schema:export`, which rewrites `apps/verify/gem_verify/contract.json`; a stale file fails `bun run ci`.
- **Local mode:** `bun test` and `bun run e2e` run the real parent from `scripts/verify-local.ts`, as your own user and with your network, restarted when it exits to recycle. Limits and recycling are real there, isolation isn't: it prints a warning, and a test for what isolation does belongs in the escape suite.
- **Escape suite:** `bun run verify:escape` brings up the `verify` service from `docker/compose.yaml` under its own project name, and sends hostile programs from a second container sharing the socket volume, like the API. Each must end the expected way, and a normal run after it must give the right value. It's a `bun run ci` step when a Docker daemon answers, and required in GitHub CI. A new way to attack the sandbox is a new line in `scripts/verify-escape.ts`.
- **gVisor:** production's `docker/compose.prod.yaml` sets `runtime: runsc`. The suite under it is `bun run verify:escape --runtime runsc`. Check the socket when you first run it: the API reaches the runner over a Unix socket across containers, which gVisor restricts by default, so it may need `runsc --host-uds=open` in `daemon.json`.
- **Python:** the libraries are pinned in `apps/verify/requirements.txt`; adding one is a reviewed change (SPEC §13). Import `gem_verify` before NumPy: the package limits OpenBLAS's threads, and a child has no budget for them.
- **Recording replies:** `tools/probes/l7/record.ts` rewrites `packages/authoring/test/fixtures/l7-recorded.json` from the live model, for the tests that replay it.

## Sources and authoring (P2)

A creator adds a source (paste or `.md`/`.txt`), picks a scope, edits objectives, sets a blueprint, generates, reviews, revises and publishes. Everything runs in the API process: no extra service beyond Postgres with pgvector, the sandbox parent and a model endpoint.

- **Ingest** (`packages/knowledge`): remark parses the Markdown into sections, `chunk.ts` cuts about 500 tokens at a time and never inside a code block, a table or a `$$` block, and each chunk's offsets slice back to its exact text. Saving a revision writes its rows; the `source.embed` pg-boss job then embeds them in batches through the `embeddings` role, reusing a vector when a chunk's content hash and the model id match an earlier revision. A source is usable once its latest revision is `ready`; a failure stores its code and `POST /sources/:id/embed:retry` runs the rest. The vector column is `vector(768)` with an HNSW index, fixed by migration: a role with another dimension fails ingest with `knowledge_dimension_mismatch`.
- **Retrieval** (`retrieve.ts`): the scope filter is in the SQL of both searches, then the top 40 by vector and by full text, reciprocal-rank fusion (k = 60), and neighbours until the budget fills. `RetrievalLog` records what each call was given.
- **Generation** (`apps/api/src/authoring`): a call is `llm.generate` (a batch), L7 is `authoring.l7` (a draft), embedding is `source.embed`. Each queue runs one job at a time. L1 to L3 run in process when a question arrives; L7 follows only on questions with no L1 or L2 fail. State lives in the database: the SSE stream (`/authoring/sessions/:id/events`) only says "read it again", and a dropped stream loses nothing. After a restart, a batch left `running` shows as failed with a retry.
- **The workers** start in `apps/api/src/main.ts` (`startGenerateWorker`, `startL7Worker`, `startSourceWorker`). A test that sends a job needs them: `createSourceEnv` in `apps/api/test/authoring-helpers.ts` starts all three, with the mock model and the local sandbox parent, and `authoring-gen-helpers.ts` has a scripted model that answers as the prompt asks (set what goes wrong per test).
- **The prompt** is `packages/llm/prompts/authoring.generate/gen-v11.md` and the schema is `strict8` in `packages/shared/src/generation.ts`. A change to either is a new version, and `generate-smoke` and `grounding-smoke` are run again.
- **Evals:** `bun run llm:eval grounding-smoke` runs the generation prompt on two chunks laid out as authoring lays them out and reports L1, L2 and L3 pass rates over the questions (`grounding-latex` is the same on chunks with LaTeX equations, a guard: the 9B model passes it either way). Each trial's items list which checks failed (`L2:quote_not_found`) and the quotes L2 refused, and `devRuntime(config, prompts)` takes other prompt versions, so two can be compared in one script. A failure rate near 5% needs about 100 questions a side to say anything, and swings a lot between runs: interleave the versions, and don't trust 24 questions. `retrieval-mini` also runs through the database when it has an owner: the corpus becomes a source (soft-deleted after) and reports top-1 and MRR for pgvector alone and for vector with full text (`top1Pgvector`, `top1Hybrid`).
- **The whole journey live:** `bun run live:authoring` runs it against the `LLM_DEV_*` server on a throwaway database (the local Postgres from `scripts/pg-local.ts`, the real workers, a local sandbox parent, so a trusted dev model only): ingest `packages/authoring/test/fixtures/linear-algebra.md`, propose objectives, generate a chapter quiz, one revise round, publish, take it in practice. It prints pass rates, seconds per question and failures, and writes `~/.cache/live-authoring-report.json`. It stores nothing in your dev database.
- **Web:** the Authoring pages are `routes/Authoring.tsx` (sessions), `AuthoringSession.tsx` (the steps) and `AuthoringReview.tsx` (the split view). `e2e/authoring.e2e.ts` is the journey against the mock model; the mock in `scripts/e2e.ts` answers generation requests from the chunks in them, and answers a source that contains `HOSTILE-SOURCE` with a program that attacks the sandbox. That spec signs in once and unassigns its roles when it ends: the login route is rate limited across specs, and the import spec starts with `verify.solve` unassigned.

## PDF converter (P2.2)

`apps/convert` turns a PDF into Markdown with equations as LaTeX, using [Marker](https://github.com/datalab-to/marker) pinned at 2.1.0 (`apps/convert/requirements.txt`). It is a small standard-library HTTP service (`gem_convert`): `GET /health`, and `POST /convert` with the PDF as the raw body and the options as JSON in the `x-gem-options` header. Marker is imported only inside a worker process, which the service kills and replaces after a timeout, a crash, or every 200 conversions, together with the helper processes Marker starts. The contract is Zod in `packages/shared/src/convert.ts`, exported to `apps/convert/gem_convert/contract.json` by `bun run schema:export` (a stale file fails `bun run ci`). `packages/convert` has the client the API will use, a mock converter (`@gem/convert/mock`) and the scoring used to compare a conversion with what it should contain.

- **Strategy.** `rasterize` (the default) renders each page to an image with pdfium and gives Marker an image-only PDF, so the vision model reads whole pages, equations included. `text` keeps the PDF's own text layer. On the repo's fixtures `rasterize` finds 54 of 54 formulas and all 5 headings, and `text` finds 39; Marker's own fast mode finds none. Pages go in batches of ten inside the converter, and a page can be rendered to at most 30 megapixels. The API itself sends a long PDF 20 pages per request (`CONVERT_BATCH_PAGES` in `apps/api/src/convert.ts`), saving the pages done after each so a retry continues; the raw Markdown is cleaned once, at the end. Marker is asked to keep page headers (`marker_settings` in `marker_engine.py`): it labels a page's first line a header and drops it, even when that line is the end of a sentence or the document's title, and our clean-up drops the running headers that really repeat.
- **The vision model** (Surya 2.5, about 589M parameters) runs on the Ollama box, as a model in Ollama. To set it up without a shell on the box: download `surya-2.5.gguf` and `surya-2.5-mmproj.gguf` from the Hugging Face repo `datalab-to/surya-ocr-2.5-gguf`, hash each, `POST /api/blobs/sha256:<digest>` to Ollama with each file as the body, then `POST /api/create` with `{"model":"datalab-to/surya-ocr-2.5","files":{"surya-2.5.gguf":"sha256:…","surya-2.5-mmproj.gguf":"sha256:…"}}`. `GET /api/show` should list the capabilities `completion` and `vision`. It takes 1.36 GiB of VRAM beside Qwen's 6.12.
- **Run it.** With the stack: set `CONVERT_URL=http://convert:8200` and `CONVERT_SHARED_SECRET` (24+ characters) in `.env`, then `docker compose --profile convert up -d --build`. The API reaches the converter by service name, and the converter sends its page reads to the API's proxy (`http://api:${API_PORT}/internal/vlm/v1`, role `document.ocr`), so the vision model's calls share the endpoint's queue, call log and stats with every other model call. Assign `document.ocr` on the admin LLM page: the Ollama endpoint, model `datalab-to/surya-ocr-2.5:latest`. The secret reaches the converter as `VLLM_API_KEY`, because Surya's vLLM client is the one that sends a key (its llama.cpp client always sends `EMPTY`); no vLLM server is started, the URL is given. It is the converter's one credential and opens only the proxy's page-read route; the proxy's `/internal/vlm/health` and `/internal/vlm/v1/models`, which Surya asks for with no key, are open and say only "ok" and the model id. The image is about 3.3 GB: CPU PyTorch, Marker, and the weights Marker's own models need, baked in, so it runs read-only and offline. It runs as uid 10003 with no capabilities, a 6 GB and 2 CPU limit (`CONVERT_MEM_LIMIT`, `CONVERT_CPUS`) and the lowest CPU priority; its port is published on loopback only (`CONVERT_PORT`, default 8200). A conversion peaks near 3 GB of RAM and needs no GPU of its own.
- **The converter alone** (no API, e.g. to try the engine): set `CONVERT_VLM_UPSTREAM` to Ollama's address (e.g. `http://10.207.0.102:11434`) and `docker compose --profile convert up -d convert`. A small development shim in the service then stands in for the proxy, because Surya wants `/health` and a model id without `:latest`, and Ollama has neither. Nothing is queued or logged that way.
- **Settings** are the `CONVERT_*` environment variables in `gem_convert/config.py`: `CONVERT_MAX_BYTES` (50 MB), `CONVERT_MAX_PAGES` (400), `CONVERT_BASE_SECONDS` and `CONVERT_SECONDS_PER_PAGE` (a conversion's time limit is the first plus the second times its pages), `CONVERT_RECYCLE_EVERY`, `CONVERT_QUEUE_MAX`, `CONVERT_STRATEGY`.
- **Tests.** `bun run ci` runs the service's unit tests (`apps/convert/tests`, the standard library and a stub engine that takes its behaviour from the "PDF" it is sent) and `packages/convert`'s, which include the TypeScript client against the real Python service. Neither needs Marker or a GPU.
- **`convert-smoke`** (`packages/convert/evals/convert-smoke/eval.json`): the fixtures through `POST /convert`, each conversion scored for formulas (a normalized LaTeX comparison with the expected list), headings and the prose's word-level similarity to the source Markdown, against a bar per run. `bun test` runs it on the mock (a conversion that matches passes, one formula or heading lost fails); `bun run live:convert [url]` runs it against a real converter and exits 1 below the bar.
- **Checks against the real thing** (not in `bun run ci`; they need Docker, the image and the box): `bun run live:convert` as above; `bun run live:pdf` the whole journey on a running stack (below); `bun run convert:check -- --hostile --image <image>` checks the container's isolation and sends ten hostile PDFs (`apps/convert/tests/fixtures/hostile`, regenerated by `python3 apps/convert/tests/make_hostile.py`) through the parser with no network and to the running service, which must stay healthy and still convert a normal PDF.
- **Fixtures.** `bun apps/web/e2e/fixtures/make-pdfs.tsx` regenerates `linear-algebra.pdf` (typeset with KaTeX and printed by Chromium), `linear-algebra-scan.pdf` (the same pages as pictures only) and the list of formulas and headings they should contain. It needs `pdftoppm` (poppler). The body is set in KaTeX's own Main face, not a system serif, so every machine gives the same pages: the text and the rendered pages match across hosts, the bytes don't (timestamps).
- **The live journey** (`bun run live:pdf`, P2.2 M27 and M10b): against a stack with the `convert` profile, as a client would, on a stack of its own (it adds an endpoint from `LLM_DEV_*`, the roles, `document.ocr` and a proctor). It uploads both fixtures, scores the previews, saves them as sources and waits for embedding; measures `GET /health`, a practice route and an authoring read idle and during a 10-page conversion, and an objectives call idle and during it, from the call log; then authors questions from the "Inner product" section and checks their quotes with L2. Settings: `LIVE_API`, `LIVE_DATABASE_URL` (gem_app on the stack's Postgres), `LIVE_ADMIN_EMAIL`, `LIVE_ADMIN_PASSWORD`. Run it on a throwaway project (`COMPOSE_PROJECT_NAME=gem-live`, other ports, `down -v` after), not on data you keep. The report is `~/.cache/live-pdf-report.json`.

## Checks (`bun run ci`)

biome check · lint-rule build staleness · lint-rule snapshot · suppression baseline · i18n catalog check · JSON Schema export staleness · LLM import boundary (`ai` and `@ai-sdk/*` only in `packages/llm`) · typecheck (strict, every project) · `bun test` (unit + integration against real Postgres) · ruff + ruff format · verify unit tests · the escape suite, when Docker answers · Playwright + axe.

Integration tests use `TEST_PG_ADMIN_URL` (a superuser URL). `bun run ci` sets it to the local cluster if it isn't set; in CI it's the Compose postgres. Each test file creates its own database with `docker/postgres/init.sql` and the migrations, and connects as `gem_app`, like the API.

On CI (`.github/workflows/ci.yml`) the stack is brought up with Compose, `scripts/check-compose.ts` checks `/health` and the verify container's isolation, and `bun run ci` runs with `E2E_BASE_URL=http://localhost:3000`.

## Lint rule `no-literal-ui-string`

`tools/biome/rule-config.json` is the single source. After changing it: `bun run lint:rule:build` (regenerates the `.grit` file and the `biome.json` plugin entry) and `bun tools/biome/snapshot.ts --update` (the snapshot diff is part of the review). New suppressions need a reason and a line in `tools/biome/suppressions-baseline.txt` (`bun tools/biome/check-suppressions.ts --update`).

## Database

- Schema: `packages/db/src/schema.ts`. Migrations: `packages/db/migrations` (`bun run db:generate` for table changes; extension and grants are hand-written migrations).
- Roles (P0.md §4): `gem_owner` owns the schema and runs migrations; `gem_app` is the API's user, with `SELECT, INSERT` only on `audit_log`. A new table needs its own grant in a hand-written migration (`0002_grants.sql` only covered the P0 tables; P1's are in `0004_p1_grants.sql`). The roles are created by `docker/postgres/init.sql` (Compose init script; also run by `dev:pg` and the tests).
