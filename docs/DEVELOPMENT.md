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
| `bun run e2e` | Playwright + axe. Starts a throwaway stack (fresh database, built web app, API on :3100, the real verify parent), or uses `E2E_BASE_URL`. Either way it runs a mock model server for the LLM page (`E2E_MOCK_HOST` is the name a stack in containers reaches it by; CI uses `host.docker.internal`). |

## LLM (P1.5)

Nothing in `bun run ci` needs a model server: tests and e2e use the mock in `packages/llm/mock/server.ts`.

| Command | What it does |
|---|---|
| `bun run llm:seed` | Creates the `LLM_DEV_*` endpoint(s) and role assignments once (also on API start in development). Never overwrites an assignment. |
| `bun run llm:eval <set> [--trials n] [--dev]` | Runs an eval set (`generate-smoke`, `retrieval-mini`) from the database's assignments and stores the run; with `--dev`, from `LLM_DEV_*`, with nothing stored. |
| `bun run llm:live [--trials n] [--embed-model tag]…` | The live checks against the `LLM_DEV_*` server: discovery, chat probe, `generate-smoke`, embeddings probes, `retrieval-mini`. Stores nothing; exits 1 if a check failed. |

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

## Checks (`bun run ci`)

biome check · lint-rule build staleness · lint-rule snapshot · suppression baseline · i18n catalog check · JSON Schema export staleness · LLM import boundary (`ai` and `@ai-sdk/*` only in `packages/llm`) · typecheck (strict, every project) · `bun test` (unit + integration against real Postgres) · ruff + ruff format · verify unit tests · Playwright + axe.

Integration tests use `TEST_PG_ADMIN_URL` (a superuser URL). `bun run ci` sets it to the local cluster if it isn't set; in CI it's the Compose postgres. Each test file creates its own database with `docker/postgres/init.sql` and the migrations, and connects as `gem_app`, like the API.

On CI (`.github/workflows/ci.yml`) the stack is brought up with Compose, `scripts/check-compose.ts` checks `/health` and the verify container's isolation, and `bun run ci` runs with `E2E_BASE_URL=http://localhost:3000`.

## Lint rule `no-literal-ui-string`

`tools/biome/rule-config.json` is the single source. After changing it: `bun run lint:rule:build` (regenerates the `.grit` file and the `biome.json` plugin entry) and `bun tools/biome/snapshot.ts --update` (the snapshot diff is part of the review). New suppressions need a reason and a line in `tools/biome/suppressions-baseline.txt` (`bun tools/biome/check-suppressions.ts --update`).

## Database

- Schema: `packages/db/src/schema.ts`. Migrations: `packages/db/migrations` (`bun run db:generate` for table changes; extension and grants are hand-written migrations).
- Roles (P0.md §4): `gem_owner` owns the schema and runs migrations; `gem_app` is the API's user, with `SELECT, INSERT` only on `audit_log`. A new table needs its own grant in a hand-written migration (`0002_grants.sql` only covered the P0 tables; P1's are in `0004_p1_grants.sql`). The roles are created by `docker/postgres/init.sql` (Compose init script; also run by `dev:pg` and the tests).
