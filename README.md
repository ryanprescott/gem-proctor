# gem-proctor

Practice tests and proctored tests, grounded in your own course material. See [`docs/SPEC.md`](docs/SPEC.md) for the product and technical spec, [`docs/P0.md`](docs/P0.md) and [`docs/P1.md`](docs/P1.md) and [`docs/P1.5.md`](docs/P1.5.md) for the build phases.

**Status: P1.5 (LLM layer).** Admins can set up model endpoints, assign model roles, probe, and run evals on `/admin/llm`; no user-facing feature calls a model yet. Before that, P0's foundations (import a quiz JSON, preview and fix it, save it as a test, export it again; audit logging, accessibility with axe in CI, i18n and authorization from the start) plus practice mode: take any of your tests as often as you like, with shuffled questions, immediate feedback, a soft timer, flags, autosave and resume; a graded results screen with a per-topic breakdown and "I was right" on short answers; retake the questions you missed; attempt history; and export any attempt as a Result file.

```
apps/api        Fastify on Bun + pg-boss
apps/web        React + Vite, React Aria, TanStack Router/Query, i18next, KaTeX
apps/verify     Python sandbox runner (P0: health only)
packages/shared Zod schemas, API contracts, quiz normalizer, toResult, JSON Schema export
packages/authz  Casbin model, policy and route permissions
packages/db     Drizzle schema, migrations
tools/biome     no-literal-ui-string lint rule (GritQL), fixtures, snapshot, suppression baseline
tools/i18n      catalog check
```

Quick start: `bun install`, `cp .env.example .env` (fill in the secrets), `docker compose up --build`, open http://localhost:3000. The first account registered becomes the admin (or set `ADMIN_EMAIL` / `ADMIN_PASSWORD`).

Development, checks and running without Docker: [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md). Test runs: [`docs/P0-test-runs.md`](docs/P0-test-runs.md). Audits: [`docs/P0-audit.md`](docs/P0-audit.md), [`docs/P1-audit.md`](docs/P1-audit.md).
