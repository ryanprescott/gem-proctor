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
| `bun run e2e` | Playwright + axe. Starts a throwaway stack (fresh database, built web app, API on :3100, the real verify parent), or uses `E2E_BASE_URL`. |

## Checks (`bun run ci`)

biome check · lint-rule build staleness · lint-rule snapshot · suppression baseline · i18n catalog check · JSON Schema export staleness · typecheck (strict, every project) · `bun test` (unit + integration against real Postgres) · ruff + ruff format · verify unit tests · Playwright + axe.

Integration tests use `TEST_PG_ADMIN_URL` (a superuser URL). `bun run ci` sets it to the local cluster if it isn't set; in CI it's the Compose postgres. Each test file creates its own database with `docker/postgres/init.sql` and the migrations, and connects as `gem_app`, like the API.

On CI (`.github/workflows/ci.yml`) the stack is brought up with Compose, `scripts/check-compose.ts` checks `/health` and the verify container's isolation, and `bun run ci` runs with `E2E_BASE_URL=http://localhost:3000`.

## Lint rule `no-literal-ui-string`

`tools/biome/rule-config.json` is the single source. After changing it: `bun run lint:rule:build` (regenerates the `.grit` file and the `biome.json` plugin entry) and `bun tools/biome/snapshot.ts --update` (the snapshot diff is part of the review). New suppressions need a reason and a line in `tools/biome/suppressions-baseline.txt` (`bun tools/biome/check-suppressions.ts --update`).

## Database

- Schema: `packages/db/src/schema.ts`. Migrations: `packages/db/migrations` (`bun run db:generate` for table changes; extension and grants are hand-written migrations).
- Roles (P0.md §4): `gem_owner` owns the schema and runs migrations; `gem_app` is the API's user, with `SELECT, INSERT` only on `audit_log`. The roles are created by `docker/postgres/init.sql` (Compose init script; also run by `dev:pg` and the tests).
