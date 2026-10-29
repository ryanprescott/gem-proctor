# P0 test runs

The two go/no-go test runs from P0.md §7 (build steps 2 and 3), run on 2026-10-29 before the code that depends on them. Both are re-runnable and run in CI on every change, so a regression after an upgrade shows up as a failing check.

Environment: WSL2 (Linux 5.15), Bun 1.4.4, Node not used.

## 1. GritQL on `.tsx` (SPEC §11.6, test run steps 1–3)

**Versions:** `@biomejs/biome` 2.6.4 (pinned exactly in `package.json`).

**Result: pass. Primary implementation kept (GritQL plugin); no contingency taken.**

| Step | Question | Result | Evidence |
|---|---|---|---|
| 1 | Do GritQL patterns match JSX text, JSX attributes and expression containers in `.tsx`? | Yes. `JsxText`, `JsxAttribute(name, initializer=JsxAttributeInitializerClause(value))`, `JsxString`, `JsxExpressionAttributeValue`, `JsxExpressionChild`, `JsStringLiteralExpression`, `JsTemplateExpression` / `JsTemplateChunkElement`, `JsConditionalExpression`, and code snippets such as `` `notify($m, $...)` `` and `` `document.title = $v` `` all match in `.tsx`. `within` / `not within` work for context (e.g. a literal inside a `JsxExpressionChild` but not inside `t(…)`). | `tools/biome/no-literal-ui-string.grit` (generated); `tools/biome/__fixtures__/invalid.tsx` |
| 2 | Suppression syntax for plugin diagnostics | `// biome-ignore lint/plugin: <reason>` before a statement, and `{/* biome-ignore lint/plugin: <reason> */}` before a JSX child. A suppression that matches nothing is reported ("Suppression comment has no effect"). | `valid.tsx` (last JSX child) is suppressed with a reason; `tools/biome/check-suppressions.ts` enforces the reason and the baseline |
| 3 | Every F1–F5 case detected, no false positives on `valid.tsx` | 37 diagnostics on `invalid.tsx` covering F1 (incl. multi-line text, fragment, nested JSX), F2 (string, template, both conditional branches, logical fallback), F3 (all 15 attributes, string / `{"…"}` / template values), F4 (all 7 functions, incl. a template literal), F5 (string and template). **0** on `valid.tsx` (never-flagged attributes, `t()` / `i18n.t()`, `i18nKey`, data rendered from variables, punctuation/number-only text, the proper-noun allowlist, a reason-bearing suppression) and on `excluded.test.tsx` (path exclusion). | `bun tools/biome/snapshot.ts --check` against `tools/biome/__fixtures__/snapshot.txt` (tool-neutral `file:line:col case-id`) |

Findings recorded while doing it:

- **Plugin `includes`** in `biome.json` accept globs with `!` negations, so the excluded paths (`**/*.test.tsx`, `apps/web/src/i18n/**`, …) are applied by Biome itself. `build-rule.ts` writes this entry from `rule-config.json`, and `--check` fails if either the `.grit` file or the `biome.json` entry is stale.
- **Regex capture groups** aren't allowed in a GritQL regex used as a plain match ("regex pattern matched 2 variables, but expected 0"): the allowlist regex uses `(?:…)` only.
- **String escapes:** in a GritQL string, only the first `\"` is unescaped; a second one keeps its backslash (`"t(\"…\")"` renders as `t("…\")`). The message therefore quotes the key with single quotes: ``User-facing text must come from the i18n catalog: use t('…') (see SPEC §1.3).`` SPEC §11.6 is updated to match.
- **`or` short-circuits per node**: two alternatives that match the same node (e.g. both branches of one conditional) only report once. The F2 rule therefore targets the literal node itself (`JsStringLiteralExpression() as $str where { $str <: within JsxExpressionChild(), … }`), so each literal is its own match.
- **Scope note:** F2 flags *any* string literal inside a JSX expression container except arguments of `t()` / `i18n.t()` and comparison operands, so `{can(user, "admin") ? …}` is flagged. App code computes such values outside the JSX (`const isAdmin = atLeast(user, "admin")`), which keeps the rule strict and syntax-only.
- **Speed:** `biome check .` over the whole repo (127 files, plugin on 24 web files) takes ~0.2 s; the 2× slowdown trigger is nowhere near.

## 2. Fastify on Bun (SPEC §11.0, §15.1)

**Versions:** Bun 1.4.4; `fastify` 5.12.7, `fastify-type-provider-zod` 7.0.0 (Zod 4.6.7), `@fastify/cookie` 11.1.5, `@fastify/rate-limit` 11.2.1, `@fastify/multipart` 10.1.6, `@fastify/swagger` 9.9.2, `@fastify/static` 10.1.8.

**Result: pass. The API runs on Bun; no Node 22 fallback.**

| Plugin | Checked | Result |
|---|---|---|
| `fastify-type-provider-zod` | request validation (400 on a bad body), response serialization strips unknown keys | pass |
| `@fastify/cookie` | signed, `httpOnly`, `SameSite=Lax`, `Secure` cookies; signature round trip; forged value rejected | pass |
| `@fastify/rate-limit` | per-route limit (`global: false`) → 429 on the third request with `max: 2` | pass |
| `@fastify/multipart` | file upload read with `request.file()`, size limit truncates and is detected | pass |
| `@fastify/swagger` | OpenAPI 3 document generated from the Zod route schemas (`jsonSchemaTransform`) | pass |
| `@fastify/static` | `serve: false` + `reply.sendFile` serves the built SPA for any path | pass |
| Real listener | `listen()` on a port and a real `fetch` (not only `inject`) | pass |

Evidence: `apps/api/test/fastify-on-bun.test.ts` (8 tests, part of `bun test`). The same plugins are exercised by the API itself: the session cookie (`apps/api/test/auth.test.ts`, A13), the login/register rate limit (A15), multipart upload on `POST /imports/preview` (`imports.test.ts`), and `@fastify/static` in the end-to-end run (the API serves `apps/web/dist`).

One related finding: pg-boss 12 issues `CREATE SCHEMA IF NOT EXISTS pgboss` at start, which needs `CREATE` on the database even when the schema exists. The grants migration creates the `pgboss` schema owned by `gem_app`, and the API starts pg-boss with `createSchema: false`, so `gem_app` needs no database-level `CREATE`.
