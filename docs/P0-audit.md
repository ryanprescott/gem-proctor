# P0 audit

Audit of P0.md §8, done on 2026-10-29 right after the build (P0.md §10). Each criterion is **pass**, **fail**, **partial** or **blocked**, with evidence.

**Environment.** WSL2 without Docker: `docker` isn't reachable from this distro (Docker Desktop WSL integration is off), so nothing that needs Compose could be run here. Everything else ran against real **Postgres 17.11 + pgvector 0.8.1** (local binaries, `scripts/pg-local.ts`), set up with the same init script (`docker/postgres/init.sql`) and migrations that Compose uses, and with the real Python 3.12 verify parent. Criteria whose Compose half is unverified are marked **blocked** for that half (P0.md §9). The CI workflow (`.github/workflows/ci.yml`) runs those halves on a GitHub runner: `docker compose up`, `scripts/check-compose.ts`, then `bun run ci` against the stack.

**Command evidence.** `bun run ci` (local stack), all steps passing:

```
✔ biome check                       ✔ typecheck (6 projects)
✔ lint rule build is up to date     ✔ bun test — 224 pass, 0 fail, 12 files
✔ lint-rule snapshot (37)           ✔ ruff (apps/verify) + ruff format
✔ suppression baseline (0)          ✔ verify unit tests (3)
✔ i18n catalog check (258 keys)     ✔ Playwright + axe — 8 passed
✔ JSON Schema export is up to date
```

## Summary

| | pass | partial | blocked | fail |
|---|---|---|---|---|
| Count | 30 | 1 | 2 | 0 |

**Blocked:** A2 (Compose up + health), A33 (container settings). **Partial:** A1 (the Compose half: Playwright ran against a local stack, not Compose). Their Compose checks are scripted (`scripts/check-compose.ts`) and run in CI, but haven't been seen to pass yet.

## Repo & tooling

| # | Result | Evidence |
|---|---|---|
| A1 | **partial** | `bun install && bun run ci` passes (above), including every listed step: biome check, rule build staleness, lint-rule snapshot, suppression baseline, catalog check, typecheck, `bun test`, ruff, Playwright + axe. Playwright ran against a throwaway local stack (`scripts/e2e.ts`: fresh database, built web app, API, verify parent), **not against Compose**: blocked here. `bun install --frozen-lockfile` is clean. `ci` needs Postgres: `TEST_PG_ADMIN_URL`, or local binaries (docs/DEVELOPMENT.md). |
| A2 | **blocked** | No Docker. Built: `compose.yaml` (root, includes `docker/compose.yaml`) with `postgres` (pgvector 0.8.1-pg17), `web` (static build into a volume), `api` (serves it), `verify`; Dockerfiles in `docker/`. `/api/v1/health` reports `db`, `queue` and `verify` and is 503 unless all three are ok (`apps/api/src/routes/public.ts`); proven against real Postgres + pg-boss + a socket in `apps/api/test/health.test.ts` ("health is 503 until the queue has processed a heartbeat, then ok"). `scripts/check-compose.ts` checks it against Compose in CI. |
| A3 | **pass** | `strict` (+ `noUncheckedIndexedAccess`) in `tsconfig.base.json`, extended by every project; `bun run typecheck` checks all 6. `any`: Biome `noExplicitAny` is an error repo-wide, and `packages/shared` uses `z.unknown()` where a type is open. `grep -rnw any packages/shared/src` finds only comments and the `unrepresentable: "any"` option of `z.toJSONSchema`. |
| A4 | **pass** | `docs/P0-test-runs.md`: both runs, with versions, results and evidence. No contingency was taken; SPEC §11.6 now reads "Active implementation: primary (GritQL plugin), since 2026-10-29", and §15.2 logs both results. |

## Schemas & normalizer

| # | Result | Evidence |
|---|---|---|
| A5 | **pass** | `packages/shared/test/schema.test.ts` "A5": `BaseQuiz.parse(fixture)` deep-equals and JSON-equals the input; `Quiz` fails with exactly one issue, `answer_not_in_options` at `questions[6].correctAnswer`, `{ id: 7, answer: "1" }`. |
| A6 | **pass** | `schema.test.ts` "A6": a passing and a failing case for each §4 check: unique ids, `correctAnswer` in options, every `correctAnswers` entry in options, unique options, choice types need options, short/numeric must not have them, `true_false` = `["True","False"]`, `chapters` = `[chapter]`, single_choice exactly one answer, multi_choice at least one, numeric parses; `total_questions` mismatch is a warning (and `score`/`percentage` warnings in `result.test.ts`). The checks live in `crossFieldErrors` (`packages/shared/src/quiz.ts`), used by `Quiz`/`Result` `superRefine`. |
| A7 | **pass** | `packages/shared/test/normalize.test.ts` "A7": one or more tests per §3D.2 row, each asserting the recorded fix code: prose/fences, `<think>`, tolerant parse, smart quotes, truncation (incl. inside a nested array), bare array, key aliases (all listed variants), numbers as strings, letter / index / prefixed answers + option prefixes, case/whitespace/LaTeX-spacing snap, renumbering, `total_questions`, type inference. Explicit: **`"1"` is not snapped to `"-1"`** (row 8 test, using the fixture's Q7). |
| A8 | **pass** | `normalize.test.ts` "A8": fast-check property (150 runs) over the fixture with random key aliases, answer forms (letter, index, spaced, upper-case, prefixed), option prefixes, trailing commas and wrappers (fence, prose, `<think>`): question texts are unchanged, options never grow and come from the input, answers are an original option or exactly the input; Q7 never becomes `-1`. |
| A9 | **pass** | Pure: `normalize.test.ts` "A9" (export → re-import → export identical, no fixes on re-import, base key order). Through the API: `apps/api/test/imports.test.ts` "A9 (API)": import → `GET /tests/:id/export` → import that → export: **byte-for-byte equal**; base names kept. Serializer: `packages/shared/src/serialize.ts` (fixed key order). |
| A10 | **pass** | `packages/shared/test/json-schema.test.ts` "A10": Ajv 2020-12 (independent of Zod) validates the fixture with Q7 fixed against `quizJsonSchema()`, rejects structurally invalid quizzes, validates a `toResult` output against `resultJsonSchema()`. Served at `GET /api/v1/schema/quiz.json` and `/result.json` (`imports.test.ts`); exported to `packages/shared/schema/` with a staleness check in `ci`. |
| A11 | **pass** | `packages/shared/test/result.test.ts` "A11": `toResult` output passes `Result`; `score`/`percentage` recomputed (15/20 → 75; weighted points → `maxScore`); the serialized result re-imports as a quiz with attempt fields dropped and question texts intact. |

## Auth & authz

| # | Result | Evidence |
|---|---|---|
| A12 | **pass** | `apps/api/test/auth.test.ts` "A12": stored hash is `$2b$12$…` (cost read from the hash ≥ 12; `BCRYPT_COST = 12`, `apps/api/src/auth/passwords.ts:7`, `Bun.password` bcrypt). A 74-byte / 37-character password → 400 `{ code: "auth_password_too_long", params: { maxBytes: 72 } }`. |
| A13 | **pass** | `auth.test.ts` "A13": cookie `httpOnly`, `SameSite=Lax`, `Secure`, `path=/`; with `NODE_ENV=development` `Secure` is off (`apps/api/src/routes/auth.ts:24`). The cookie is signed with `SESSION_SECRET`; the stored session id is the token's SHA-256. |
| A14 | **pass** | `auth.test.ts` "A14": after a cached `/me`, logout makes the same token 401 on the next request; a student cached as denied on `/tests` is allowed on the very next request after `PUT /admin/users/:id/roles` → proctor, and denied again after the demotion. `Authz.setRole` clears Casbin's decision cache; `SessionStore.invalidateUser` clears cached sessions. |
| A15 | **pass** | `auth.test.ts` "A15": 9 × `auth_invalid_credentials`, the 10th → 423 `auth_account_locked`, the right password is then refused; admin reset clears it and login works. Rate limit: with `AUTH_RATE_LIMIT_MAX=3`, the 4th login and the 4th register are 429 `{ code: "rate_limited" }` (separate limits). |
| A16 | **pass** | `apps/api/test/authz.test.ts` "A16": building the app with an extra `GET /api/v1/forgotten` without a declaration makes `ready()` fail with "routes without a permission declaration … /api/v1/forgotten". The check (`installAuthz`, `apps/api/src/http/route.ts`) covers every route, including the SPA and OpenAPI routes, which declare `{ public: true }`. Also: every contract must have a route (`app.ts`). |
| A17 | **pass** | `authz.test.ts` "A17": the matrix covers every contract (asserted against `CONTRACTS`) × anonymous, student, proctor-owner, proctor-non-owner, admin = 110 assertions. Students get 403 `forbidden` on all import/test routes (also for a nonexistent test id, so ids don't leak; a proctor gets 404 there). Proctors list only their own tests; admins see all. |
| A18 | **pass** | `auth.test.ts` "A18": without env, 1st registration → admin, 2nd → student (one `user.create` audit row, `via: first_registration`). With `ADMIN_EMAIL`/`ADMIN_PASSWORD`, `bootstrapEnvAdmin` run twice creates the admin once (one user, one audit row with `actorId: null`), and the first registration is a student. A Postgres advisory lock serializes concurrent first registrations. |
| A19 | **pass** | `auth.test.ts` "A19": `selfRegistration: false` → `POST /auth/register` is 403 `{ code: "auth_registration_disabled", params: {} }`. |

## Audit

| # | Result | Evidence |
|---|---|---|
| A20 | **pass** | `apps/api/test/audit.test.ts` "A20": role grant, role revoke, password reset, disable, enable, settings change each add exactly one row with `actorId`, `action`, `targetType`, `targetId`, `before`, `after`, `ip`, `userAgent`; bootstrap user creation is covered in A18. The new password (and the account passwords) appear nowhere in the table; `writeAudit` also redacts any `password|secret|token|apiKey` key (`apps/api/src/audit.ts`). |
| A21 | **pass** | `audit.test.ts` "A21": connected as `gem_app` (checked with `current_user`), `UPDATE audit_log`, `DELETE FROM audit_log` and `TRUNCATE` fail with "permission denied"; `INSERT` and `SELECT` work, other tables stay writable. Grants: `packages/db/migrations/0002_grants.sql:10-12`. Run against local Postgres 17 + pgvector with the Compose init script, not inside Compose. |
| A22 | **pass** | `audit.test.ts` "A22": filters by action, actor and date range (`from`/`to`), plus paging; CSV: `text/csv`, CRLF line ends, quoted fields with doubled quotes, header + 11 columns, same filter. A small RFC 4180 parser in the test round-trips commas, quotes and CRLF in fields. Cells that a spreadsheet would run as a formula get a leading `'`. UI: `/admin/audit-log` (filters, table, paging, CSV link with the same filter). |

## Import UI

| # | Result | Evidence |
|---|---|---|
| A23 | **pass** | `apps/web/e2e/import.e2e.ts` "A23 + A32": uploading the fixture shows "1 error must be fixed before saving.", "Question 7, correctAnswer", the message, and a disabled Save; editing Q7 shows "run the preview again"; re-running enables Save. |
| A24 | **pass** | `import.e2e.ts` "A24": pasted prose + fenced JSON + trailing commas + letter answers previews as savable and lists every applied fix (extraction, tolerant parse, three key aliases, option prefixes, both letter answers, `total_questions`). Same input via the API: `imports.test.ts` "A24 (API)". |
| A25 | **pass** | `imports.test.ts` "A25": `Test` (title from `quiz_title`), `TestVersion` (version 1, 20 questions, `provenance` null) and `TestImportRecord` (`sourceRaw` = the uploaded text, `originalFilename`, the report with fixes) are created in one transaction. UI save path: "A23 + A32" ends on the new test's page. |
| A26 | **pass** | `import.e2e.ts` "A26 + A29": the test detail page renders `.katex` and more than 20 `<math>` elements; `annotation[encoding="application/x-tex"]` keeps the LaTeX source (incl. `\begin{bmatrix}`). `apps/web/src/ui/Markdown.tsx`: `output: "htmlAndMathml"`, `trust: false`, size limits. |

## i18n

| # | Result | Evidence |
|---|---|---|
| A27 | **pass** | `no-literal-ui-string` runs in `biome check` on `apps/web/src/**` and passes; the suppression baseline is **empty** (`tools/biome/suppressions-baseline.txt`, `check-suppressions.ts`: 0). |
| A28 | **pass** | Errors leave the API only through `installErrorHandling` (`apps/api/src/http/errors.ts`) as `{ code, params }`, with `code` from `ERROR_CODES` (`packages/shared/src/errors.ts`); handlers throw `AppError(code, params)` only. Validation, 404, 413, 415 and 429 are mapped too (tests in `imports.test.ts`, `auth.test.ts`, `authz.test.ts`). The catalog check confirms every code has `errors:<code>` (and every quiz issue / fix code, role, audit action and question type its entry). |
| A29 | **pass** | All date and number output goes through `apps/web/src/format.ts` (`Intl.DateTimeFormat`, `Intl.NumberFormat`); `import.e2e.ts` "A26 + A29" checks the test page and list show `Intl.DateTimeFormat("en", { dateStyle: "medium" })` output. P0 shows no percentages (results arrive in P1); `toResult` computes them. |

## Accessibility

| # | Result | Evidence |
|---|---|---|
| A30 | **pass** (local stack) | `apps/web/e2e/a11y.e2e.ts`: axe (WCAG 2.0/2.1/2.2 A + AA + best practices) reports **zero violations** on every P0.md §6 page: signed out (sign in, register, 404), student (home, and the refusal shown on import, tests, test detail, admin), proctor (home, import empty and with a report, tests, test detail), admin (all of those plus users, settings, audit log, 404, and the open reset-password dialog). Ran against the local stack; against Compose in CI. |
| A31 | **pass** (local stack) | `apps/web/e2e/keyboard.e2e.ts`: only `Tab`/`Enter`/arrow keys/typing: sign in → Import in the nav → Enter on "Upload a .json file" (file chooser) → arrow keys to Q7's `correctAnswer` in the editor, type `-` → re-run preview → Save → Enter on "Export quiz JSON" downloads a file whose Q7 answer is `-1`. |
| A32 | **pass** | `LiveProvider` (`apps/web/src/ui/live.tsx`): `announce()` → polite live region, `notify()` → toast in a `role="status"` region. Preview results, saves, and errors (`errorText`) are announced; `import.e2e.ts` and `keyboard.e2e.ts` assert the live-region text after preview and after save. |

## Verify skeleton

| # | Result | Evidence |
|---|---|---|
| A33 | **blocked** (container) / pass (health) | Health: `apps/api/test/verify-skeleton.test.ts` spawns the real parent (`apps/verify/gem_verify/server.py`) with an **empty environment** (`-I -B`, `env: {}`) and gets `{ ok: true, sympy: "1.13.3", numpy: "2.1.3" }` over the Unix socket through the API's client, matching the pins in `apps/verify/requirements.txt`. Container: `docker/compose.yaml` sets `network_mode: none`, `read_only: true`, `/tmp` tmpfs, no `environment`, `cap_drop: [ALL]`, `cap_add: [SETUID, SETGID]`, `no-new-privileges`, `pids_limit`, `mem_limit`, `cpus`; the image's entrypoint runs under `env -i`; `docker/compose.prod.yaml` adds `runtime: runsc`. Not run here (no Docker); `scripts/check-compose.ts` inspects all of these, plus `/proc/1/environ` empty and only `lo` present, in CI. |

## Deviations from SPEC (all fixed or logged)

Logged in SPEC §15.2 and reflected in the spec text:

1. **Casbin request** carries the caller's relationship as a string (`r = sub, obj, act, rel`) instead of `r.sub`/`r.obj` objects with `isMember()`, so `CachedEnforcer` can cache decisions (§5.2 updated).
2. **Lint message** quotes the key with single quotes (`t('…')`) because of a GritQL string-escape quirk (§11.6 updated).
3. **pg-boss** uses a `pgboss` schema owned by `gem_app`, created by the grants migration (`createSchema: false`).
4. **pgvector** is created by the init script (superuser); migration 0000 keeps a no-op `IF NOT EXISTS`.
5. **`PUT /admin/users/:id/roles`** takes a single `{ role }`, audited as `role.grant` / `role.revoke`.

Other notes, no spec change needed:

- `normalizeQuiz` reads a bare integer answer as a **0-based** option index (like `"B"` = index 1), and **never** when the options are numeric, where it could be a value (Q7-style). A string of digits is never an index.
- A missing `type` is inferred and **stored** (`type_inferred` fix), so a base-format import exports with `type` set; all base field names stay unchanged, and the round trip is stable.
- `trustProxy` is off by default (`TRUST_PROXY`), so clients can't spoof `X-Forwarded-For` to get around the login rate limit or fake audit IPs.
- New optional config keys (documented in `.env.example`): `API_HOST`, `TRUST_PROXY`, `WEB_DIST`, `POSTGRES_PORT`, `MIGRATE_ON_START`, `AUTH_RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_WINDOW_MS`.

## Before P1

- Run CI once on GitHub (or with Docker locally) to turn A1 (Compose half), A2 and A33 from blocked/partial into pass; fix whatever `scripts/check-compose.ts` reports.
- Manual screen-reader pass (NVDA, VoiceOver) is a release gate (SPEC §1.3), not a P0 criterion.
