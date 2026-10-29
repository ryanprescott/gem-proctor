# gem-proctor

Practice tests and proctored tests, grounded in your own course material. See [`docs/SPEC.md`](docs/SPEC.md) for the product and technical spec, and [`docs/P0.md`](docs/P0.md) for the current build phase.

**Status: P0 (foundations).** The stack runs end to end with one feature: import a quiz JSON, preview and fix it, save it as a test, and export it again. Audit logging, accessibility (WCAG 2.2 AA, axe in CI), i18n and authorization are enforced from the start.

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

Development, checks and running without Docker: [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md). Test runs: [`docs/P0-test-runs.md`](docs/P0-test-runs.md). Audit: [`docs/P0-audit.md`](docs/P0-audit.md).
