# P1 audit

Audit of P1.md §8, feature by feature, each section written when its feature was finished (P1.md §10). Each criterion is **pass**, **fail**, **partial** or **blocked**, with evidence.

**Environment.** As in P0: WSL2 without Docker. Postgres 17 + pgvector from the local binaries (`scripts/pg-local.ts`), the real Python 3.12 verify parent, Playwright's Chromium. Anything that needs Compose is **blocked** (P1.md §9).

## F1 Grading & shuffle

Built in `packages/shared`: `gradeResponse` (`src/result.ts`), `parseNumericAnswer` (`src/quiz.ts`), the seeded shuffle (`src/shuffle.ts`), and the optional fields `Question.partialCredit`, `Question.ignoreWords`, `AnsweredQuestion.selfGraded` (`src/quiz.ts`). Tests: `test/grading.test.ts`, `test/shuffle.test.ts`, `test/json-schema.test.ts` (B8).

| # | Result | Evidence |
|---|---|---|
| B1 | **pass** | `grading.test.ts` "B1": passing and failing cases for `single_choice` and `true_false` (exact option text, no trimming or case folding), `multi_choice` (`["c","a"]` = `["a","c"]`; missing or extra selection fails), `numeric` (tolerance 0 exact, incl. `2.50` and `25e-1`; tolerance 0.1 with `0.4` vs `0.3`, which is `0.10000000000000003` in binary, and `1000.4` vs `1000.3`, both correct at the boundary; just outside fails), `short_answer` (`correctAnswer` and both `acceptedAnswers`). No answer → 0 points. |
| B2 | **pass** | `grading.test.ts` "B2": one test per §7.2 rule: trim/collapse; case fold, and `caseSensitive: true` in both `normalizeShortAnswer` and grading; one test per operator `[ ] , ( ) ^ _ + - * /`; NFKC (ligature, superscript, full-width digits); U+2212 / en / em dash and curly quotes; `ignoreWords` (case-folded with the answer, whole separated words only, repeated stripping). `[4, 2, 3]^T` matches `[4,2,3]^T`; `2n - 1 flops` matches `2n-1` with `ignoreWords: ["flops"]` and doesn't without it. |
| B3 | **pass** | `grading.test.ts` "B3": accepts `-1`, `+2.5`, `1e-3`, `.5`, `5.`, U+2212, `$-1$`, NFKC digits; rejects `1,000`, `1/2`, `3 m`, empty, blanks, `0x10`, `Infinity`, `NaN`, `1e`, `1e400` and others (→ `null`), and grading those is `incorrect` without throwing. `parsesAsNumber` (the `numeric_not_a_number` check) now uses the same parser, so a numeric `correctAnswer` is always gradeable; A6's numeric cases still pass. |
| B4 | **pass** | `grading.test.ts` "B4": 15 table rows: default and explicit `all_or_nothing`; `proportional` with ⅔, ⅓, 3 right + 1 wrong (0.67), 1 right + 1 wrong (0), more wrong than right (0), only wrong, nothing selected; fractional `points` (2.5 → 1.67, 1.5 → 0.5). `autoResult` is `partial` exactly when 0 < points < max. `toResult` writes `pointsAwarded` for a partial answer and `recomputeScore` agrees (1.67 / 83.5 %). |
| B5 | **pass** | `gradeQuestion` is now `gradeResponse(...).outcome === "correct"` and `toResult` grades with `gradeResponse` (`src/result.ts`). `result.test.ts` (A11 and the P0 grading helpers) is unchanged and passes; `grading.test.ts` "B5" checks `toResult` against `gradeResponse` on every fixture question. |
| B6 | **pass** | `shuffle.test.ts` "B6": fast-check (200 runs) over the fixture plus a `true_false` question: the same seed gives the same shuffle; question ids and every option list are permutations (no loss, no duplicates); `true_false` stays `True, False`; `applyShuffle` follows the order. Second property (200 runs): two different seeds give different shuffles. Spread: every question comes first for some of 2000 seeds. A snapshot pins one seed's order. Seeds: 16 bytes from `crypto.getRandomValues` as 32 hex digits; PRNG sfc32, unbiased Fisher–Yates (rejection sampling); no `Math.random` (`grep -rn Math.random packages/shared/src` finds nothing). |
| B7 | **pass** | `grading.test.ts` "B7": with Q7 fixed, `"-1"` is correct and `"1"` incorrect (and `"−1"` with U+2212 is incorrect: a choice answer must be the option text). On the unfixed Q7 the stored `"1"` only matches itself, so nothing snaps to a nearby option. |
| B8 | **pass** | `json-schema.test.ts` "B8": the fixed fixture still parses (and A5 still passes, `schema.test.ts`); a question with `ignoreWords` and `partialCredit` passes `Quiz` and Ajv, an invalid `partialCredit` fails both; `quiz.json` has `partialCredit` / `ignoreWords`, `result.json` also `selfGraded`; a serialized result with `selfGraded` passes Ajv. `packages/shared/schema/*.json` regenerated; the staleness check in `ci` passes. |
| B9 | **pass** | `grading.test.ts` "B9": a `toResult` output with one short answer changed to `selfGraded: true, userIsCorrect: true, pointsAwarded: 2` passes `Result`, `recomputeScore` gives 3 / 3 (100 %), and `serializeResult` keeps `selfGraded`. |

**`bun run ci`:** all steps pass.

```
✔ biome check                       ✔ JSON Schema export is up to date
✔ lint rule build is up to date     ✔ typecheck (6 projects)
✔ lint-rule snapshot                ✔ bun test — 306 pass, 0 fail, 14 files
✔ suppression baseline              ✔ ruff + ruff format, verify unit tests (3)
✔ i18n catalog check (258 keys)     ✔ Playwright + axe — 8 passed
```

**Deviations and notes.**
- `ignoreWords` only strips words separated from the answer by whitespace (`2n-1 flops`, not `2n-1flops`), so a unit like `m` can't eat the end of `2m`. The ignore words go through the same normalization as the answer.
- Numeric comparison with a tolerance allows a few ulps over the tolerance, so a decimal boundary (`0.4` vs `0.3 ± 0.1`) counts as `|Δ| = tolerance`. Tolerance 0 is exact equality of the parsed numbers.
- `parsesAsNumber` (validation of a numeric `correctAnswer`) is stricter than in P0: it accepts only the forms in P1.md §5 (P0 accepted anything `Number()` took, e.g. `0x10`). Logged for SPEC §15.2 at F6.

## F2 Practice data & authz

Built: `PracticeAttempt` and `Response` in `packages/db/src/schema.ts`, migrations `0003_p1_practice_tables.sql` (generated by drizzle-kit) and `0004_p1_grants.sql` (hand-written); policy rows and the `practice_attempt` object type (`packages/authz/src/policy.csv`, `routes.ts`); the eight error codes with statuses (`packages/shared/src/errors.ts`) and catalog entries (`apps/web/src/i18n/locales/en/errors.json`); contracts for every P1.md §6 route (`packages/shared/src/contracts/index.ts`, "Practice"); the private attempt lookup in the authz preHandler (`apps/api/src/http/route.ts`, `relationship`). Tests: `apps/api/test/practice-db.test.ts`, the extended matrix in `apps/api/test/authz.test.ts`.

| # | Result | Evidence |
|---|---|---|
| B10 | **pass** | `practice-db.test.ts`, as `gem_app` against a fresh migrated database: a second in-progress attempt for the same user and version fails with `23505` (partial unique index `practice_attempt_in_progress_unique … WHERE submitted_at IS NULL`), and succeeds once the first is submitted; a duplicate `(attempt_id, question_id)` fails with `23505`; deleting an attempt deletes its responses (`ON DELETE CASCADE`); a response for a missing attempt fails with `23503`. Check constraints (`23514`): `kind`, the seed format, `question_ids` set exactly for `retake_missed`, `score` and `duration_ms` set exactly when submitted, `auto_result`, `time_spent_ms ≥ 0`. Points are `numeric(10,2)` read back as numbers: `1.67`, `7.5`, `0.33` round-trip exactly; durations are `bigint` (3 000 000 000 ms round-trips). |
| B11 | **pass** | `practice-db.test.ts` "B11": `has_table_privilege` for `gem_app`: SELECT/INSERT/UPDATE/DELETE on `practice_attempt` and `response`; on `audit_log` SELECT/INSERT only. A21 (`audit.test.ts`: UPDATE/DELETE/TRUNCATE on `audit_log` → permission denied) still passes. |
| B12 | **pass** | Each of the 8 routes has a contract in `CONTRACTS` (`practice.start`, `.list`, `.get`, `.saveResponse`, `.selfGrade`, `.submit`, `.discard`, `.export`) and a declaration in `ROUTE_PERMISSIONS`, which `satisfies Record<ContractId, RoutePermission>`, so a missing declaration is a type error. The routes are registered (`apps/api/src/routes/practice.ts`), so the startup checks cover them: the A16 test still passes (an undeclared route fails `ready()`), and the "every contract has a route" check (`app.ts`) passes. The A17 matrix now includes every practice route × 5 callers ("the matrix covers every contract"); someone's attempt is 404 `not_found` for another proctor **and for an admin**, 403 for a student, 401 anonymous. |

**`bun run ci`:** all steps pass.

```
✔ biome check                       ✔ JSON Schema export is up to date
✔ lint rule build is up to date     ✔ typecheck (6 projects)
✔ lint-rule snapshot                ✔ bun test — 351 pass, 0 fail, 15 files
✔ suppression baseline              ✔ ruff + ruff format, verify unit tests (3)
✔ i18n catalog check (266 keys)     ✔ Playwright + axe — 8 passed
```

**Deviations and notes.**
- **Handlers come in F3.** To keep the startup checks and the matrix honest from F2 on, the practice routes are registered now with a placeholder handler (503 `service_unavailable`, `apps/api/src/routes/practice.ts`). F3 replaces it; the matrix row for `practice.start` is `proctor` here (the route-level check) and becomes owner-only in F3, when the handler checks `test` / `practice`.
- A missing or someone else's attempt is `not_found` (the generic code); P1.md §6 lists no `practice_attempt_not_found`. Callers who couldn't act on an attempt even if it were theirs (students) get 403, like P0's tests.
- Extra columns and checks beyond P1.md §4: `practice_attempt (user_id, started_at)` and `(test_version_id)` indexes for history; check constraints tying `question_ids` to `kind` and `score` / `duration_ms` to `submitted_at`. `user_id` cascades on user delete (attempts are private data); `test_version_id` doesn't.
- `0002_grants.sql` granted on the tables that existed then, so P1's tables get an explicit grant in `0004_p1_grants.sql`.

## F3 Practice API

Built: the eight practice handlers in `apps/api/src/routes/practice.ts` (replacing F2's placeholder), `toResult` with stored grades and `selfGraded` (`packages/shared/src/result.ts`), and a `jsonb` column type for `response.answer` that doesn't re-parse strings (`packages/db/src/schema.ts`). Tests: `apps/api/test/practice.test.ts` (real Postgres, a test clock through `ctx.now`), the matrix and B21 tests in `apps/api/test/authz.test.ts`, `practice-db.test.ts` (answer round-trip), `packages/shared/test/grading.test.ts` (stored grades).

| # | Result | Evidence |
|---|---|---|
| B13 | **pass** | `practice.test.ts` "B13" (5 tests): `full` pins the latest version (v1, and v2 once a second version exists), stores a 32-hex seed, `question_ids` null and `maxScore` 6 (weights 1+2+1+1+1); a second start → 409 `{ code: "practice_attempt_in_progress", params: { attemptId } }`; archived → 409 `test_archived`; `retake_missed` with no submitted attempt, and after an all-correct one → 409 `practice_nothing_to_retake`; after an attempt with q2 self-graded and q3 correct it stores exactly `[1, 4, 5]` (unanswered q5 included), `maxScore` 3, and pins **v1** although v2 is the latest. A concurrent start that loses the partial unique index is mapped to the same 409. |
| B14 | **pass** | `practice.test.ts` "B14": `GET` returns questions in `shuffleAttempt(storedSeed, …)` order with each option list in its shuffled order (`true_false` kept), responses in the same order, `quizOrder` in the test's order; two requests return identical bodies. Second test: two attempts on the 20-question fixture have different seeds and different question orders over the same ids. |
| B15 | **pass** | `practice.test.ts` "B15" (4 tests): `check: true` returns `{ outcome, pointsAwarded, maxPoints, correctAnswer, explanation }` (and `correctAnswers` for multi_choice, partial 0.5); a second check, an answer change, or both → 409 `practice_answer_locked`; `flagged` and `timeSpentMs` update after the check; question 99 → 404 `practice_question_not_in_attempt` (also a question outside a retake's subset); `check` with no answer → 400 `validation_failed` `{ field: "answer" }`; after submit, `PUT`, `submit` and `DELETE` → 409 `practice_attempt_submitted`. |
| B16 | **pass** | `practice.test.ts` "B16": 10 000 000 ms sent 5 s after the start is stored as 5 000; a smaller value later keeps 5 000; after another second 5 800 is accepted; negative → 400. "B17 + B16": `durationMs` = 66 000 = `submittedAt − startedAt` on the test clock, computed by the server (the request carries no time). |
| B17 | **pass** | `practice.test.ts` "B17 + B16": submit stores `submittedAt` and `score` 3.5 / 6 = q1 0 + q2 2 (self-graded) + q3 1 (an unchecked draft, graded at submit) + q4 0.5 (partial) + q5 0 (unanswered). No `audit_log` rows are written by practice actions. |
| B18 | **pass** | `practice.test.ts` "B18" (2 tests): on an incorrect short answer, `right: true` → `selfGraded`, 2 points (score stays null before submit), `right: false` undoes it; single_choice, numeric, multi_choice and unanswered questions → 409 `practice_self_grade_not_allowed`. After submit, undo → stored score 1.5, redo → 3.5 (checked in the response and in the row). |
| B19 | **pass** | `practice.test.ts` "B19": `GET /practice/attempts?testId=` returns the owner's two attempts newest first (retake, then full) with kind, status, score, `maxScore`, `durationMs`, `questionCount`; the admin's attempt on the same test is in neither the owner's list nor vice versa; `missedCount` is 0 after a perfect retake and null without a submitted attempt; `?limit=1` without `testId` returns the newest attempt across tests (for the home page). |
| B20 | **pass** | `practice.test.ts` "B20" (2 tests): the export passes `Result`, has `mode: "practice"`, `attemptId`, `startedAt`, `submittedAt`, `score` 3.5, `maxScore` 6, questions in order 1–5 with unshuffled options, q2 `selfGraded: true, userIsCorrect: true`, q4 `pointsAwarded: 0.5`, q5 `userAnswer: ""`, `userIsCorrect: false`; it re-imports through `POST /imports/preview` with no errors. Before submit → 409 `practice_attempt_not_submitted`. The retake's export has only questions 1, 4, 5 and `total_questions: 3`. `grading.test.ts`: a stored grade wins over re-grading. |
| B21 | **pass** | `authz.test.ts` matrix: every practice route × anonymous (401), student (403), owner (allowed), proctor non-owner, admin. `practice.start` is owner-only for proctors (non-owner 403) and allowed for an admin; on a missing test 404 `test_not_found` for a proctor, 403 for a student. For someone's attempt, every attempt route is 404 `not_found` for another proctor **and an admin** (matrix rows plus "B21: another user's attempt is 404 for every route, admins included"), the same as a missing id, and it never shows in their history. |
| B22 | **pass** | `practice.test.ts`: `DELETE` on an in-progress attempt → `{ ok: true }`, the row and its responses are gone, `GET` is then 404; on a submitted attempt → 409 `practice_attempt_submitted`. |

**`bun run ci`:** all steps pass.

```
✔ biome check                       ✔ JSON Schema export is up to date
✔ lint rule build is up to date     ✔ typecheck (6 projects)
✔ lint-rule snapshot                ✔ bun test — 373 pass, 0 fail, 16 files
✔ suppression baseline              ✔ ruff + ruff format, verify unit tests (3)
✔ i18n catalog check (266 keys)     ✔ Playwright + axe — 8 passed
```

**Deviations and notes.**
- **Unchecked answers.** `PUT` with `answer` and no `check` stores the answer ungraded (still changeable); submit grades it. The UI keeps typed-but-unchecked text in `sessionStorage` as P1.md §5 says, but the API doesn't lose such an answer either.
- **Who may start.** P1.md §5 says "the test's owner (proctor) and admins, on tests they own", §6 says "test owner, or admin". Built as §6: the admin policy line reaches `test` / `practice` on any test. The attempt itself is still private to whoever started it.
- **In-progress rule** is per test version (the partial unique index), so an in-progress retake on v1 doesn't block a full attempt on v2; the UI offers Resume for any in-progress attempt of the test.
- **Fix to F2's table:** drizzle's `jsonb` JSON-parses any string it reads back, so a stored answer `"3.505"` came back as a number. `response.answer` now uses a custom `jsonb` type without that second parse (no migration: the SQL type is unchanged); `practice-db.test.ts` checks that `"3.50"`, `"true"`, `"null"` and arrays round-trip. F2's B10 row stays **pass** (its tests didn't store JSON-looking strings); the new test is part of this commit.
- `check` with an empty answer is `validation_failed` (`params.field: "answer"`) rather than a new code.

## F4 Test-taking UI

Built in `apps/web`: the attempt page `/practice/attempts/:id` (`src/routes/Attempt.tsx`), the feedback block with "I was right" (`src/routes/Feedback.tsx`), the test detail page's Practice section with Take test / Resume / Discard (`src/routes/PracticeSection.tsx`), a first results page (`src/routes/Results.tsx`: score, percentage, time; F5 completes it), a reusable confirmation dialog (`src/ui/ConfirmDialog.tsx`), the draft store and question clock (`src/practice/session.ts`), `Intl` helpers for points, percentages, the clock and durations (`src/format.ts`), and the `practice` catalog namespace. Tests: `apps/web/e2e/practice.e2e.ts` (Playwright + axe) on a five-question quiz with every question type (`PRACTICE_QUIZ` in `e2e/helpers.ts`).

| # | Result | Evidence |
|---|---|---|
| B23 | **pass** | `practice.e2e.ts` "B23": Take test on the test detail page opens `/practice/attempts/<id>` at "Question 1 of 5"; stepping through with Next, each question's text matches the API's display order, choice questions are a `radiogroup` (single choice, true/false) or a `group` of checkboxes (multi choice) named by the question, with the input values in the server's shuffled order, and short/numeric answers are a labelled `textbox`. |
| B24 | **pass** | "B24": a wrong single-choice answer shows "✗ Incorrect (0 of 1 points)" (icon `aria-hidden`, the outcome as text), "Correct answer:", the explanation, and "Your answer" / "Correct answer" labels on the options; the live region says "Incorrect" (A32 pattern, `useLive().announce`). A correct true/false and a correct numeric answer show "Correct" and announce it. The API agrees with what's shown (`autoResult` incorrect / correct). Focus moves to the feedback block after the check. |
| B25 | **pass** | "B25": "Flag for review" is a React Aria `ToggleButton` (`aria-pressed` false → true) and the change is announced. Navigator buttons are named in text ("Question 3, answered, flagged for review" / "Question 4, not answered"), the current one has `aria-current="step"`, visible marks have a text legend. Tab to a navigator button + Enter moves to that question, focuses its heading and announces "Question n of 5". |
| B26 | **pass** | "B26": `role="timer"` with `aria-live="off"`, an always-visible "Elapsed time" label, `hh:mm:ss` from `Intl.DateTimeFormat` (`formatClock`), and the text changes as time passes; nothing ends the attempt. After about 1.2 s on a question and moving away, the API reports its `timeSpentMs` > 1000. The clock counts only while the document is visible (`QuestionClock`), and a `pagehide` keepalive request saves the current question's time. |
| B27 | **pass** | "B27": after typing an unchecked short answer and reloading, the same attempt URL opens at the first unanswered question; the typed text is restored (`sessionStorage`), the checked answer still shows its feedback with the option selected, the flag is still pressed, and the numeric answer is still there. |
| B28 | **pass** | "B28": Submit attempt opens an `alertdialog` "Submit this attempt?" saying "1 question is unanswered. It will score 0."; focus starts on "Keep working"; Escape closes it and focus returns to the Submit button; confirming submits (the typed short answer is saved first and graded at submit) and shows the results page. Reopening the attempt URL afterwards redirects to the results. |
| B29 | **pass** | `expectNoAxeViolations` (WCAG 2.0–2.2 A/AA + best practice) on the attempt page unanswered, after incorrect feedback, after correct feedback, flagged, with the submit dialog open, and at 320 px wide (with and without feedback). The existing P0 axe runs on the test detail page (proctor, admin) now include the Practice section. |

**`bun run ci`:** all steps pass.

```
✔ biome check                       ✔ JSON Schema export is up to date
✔ lint rule build is up to date     ✔ typecheck (6 projects)
✔ lint-rule snapshot                ✔ bun test — 373 pass, 0 fail, 16 files
✔ suppression baseline (0)          ✔ ruff + ruff format, verify unit tests (3)
✔ i18n catalog check (330 keys)     ✔ Playwright + axe — 15 passed
```

**Deviations and notes.**
- **Submit with typed answers.** Before submitting, the UI saves any typed-but-unchecked answer (without `check`), so the server grades it at submit instead of dropping it; the dialog counts such questions as answered.
- **"I was right" during the attempt** is in F4 already (the feedback block, after a short answer is checked incorrect), as P1.md §5 allows; the results screen gets the same control in F5.
- The catalog check has a new dynamic key family `practice:outcome.` tied to the shared `GRADE_OUTCOMES` enum (`tools/i18n/check-catalogs.ts`).
- The results page here only shows score, percentage and time; F5 adds the per-question review, topic breakdown, retake and export.
- *Note added in F5:* F5 extends `PracticeSection.tsx` and `Results.tsx` (history, Retake missed, the full results screen) and moves the start mutation to `src/practice/useStartAttempt.ts`; the F4 rows above still hold (`practice.e2e.ts` passes unchanged in F5's `bun run ci`).

## F5 Results, retake & history UI

Built in `apps/web`: the full results screen (`src/routes/Results.tsx`: score, percentage, time, kind, Retake / Retake missed / Export, topics covered and the per-topic table, per-question review with your answer, the correct answer, explanation, evidence quotes, points and "I was right" / undo), the history table and Retake missed on the test detail page (`src/routes/PracticeSection.tsx`), the shared start hook (`src/practice/useStartAttempt.ts`), recent attempts on the proctor home page and the student message (`src/routes/Home.tsx`); `topicBreakdown` in `packages/shared/src/result.ts`. Tests: `apps/web/e2e/results.e2e.ts` (an attempt with known answers made through the API), `packages/shared/test/grading.test.ts` "B31".

| # | Result | Evidence |
|---|---|---|
| B30 | **pass** | `results.e2e.ts` "B30": "1.5 of 6 points (25%)" (points and percent through `Intl.NumberFormat`), "Time taken" (`formatDuration`, `Intl` units + list format); five questions in the test's order, each with the question, "Your answer:" (or "Not answered"), the outcome in text ("Correct", "Partly correct", "Incorrect"), points ("(0.5 of 1 points)"), the correct answer(s), the explanation, and for q5 the evidence quote in a `blockquote` under "From the source:". axe: zero violations. |
| B31 | **pass** | `results.e2e.ts` "B31": the topic table rows are exactly Vectors 1 of 2 / 1 of 2, Complexity 0 of 2 / 0.5 of 3, Sets 0 of 1 / 0 of 1 for the known answers (order of first appearance), under "Topics covered:". `grading.test.ts` "B31" checks `topicBreakdown` on the same data with a self-graded question. |
| B32 | **pass** | `results.e2e.ts` "B32": "I was right" on the wrong short answer changes the score to "3.5 of 6 points (58.3%)", the Complexity row to 2.5 of 3, shows "Self-graded: you marked this answer as right.", and the live region says "Marked as right (self-graded). Score: 3.5 of 6."; "Undo “I was right”" returns to 25 % and announces "Self-grade undone."; redone, the test detail history shows "3.5 of 6 (58.3%)". |
| B33 | **pass** | `results.e2e.ts` "B33": "Retake missed (3 questions)" opens "Question 1 of 3" and the API shows a `retake_missed` attempt over exactly `[3, 4, 5]` (q2 was self-graded right); after a perfect retake, "Retake missed (nothing missed)" is disabled; "Retake" opens a full attempt ("Question 1 of 5"). |
| B34 | **pass** | `results.e2e.ts` "B34": the downloaded file has `score` 3.5, `maxScore` 6, `percentage` 58.33, `mode`, `attemptId`, questions 1–5, q2 `selfGraded: true`; the screen shows the same score, and each question's `userAnswer` (or "Not answered") and correct/incorrect outcome match what's on screen. |
| B35 | **pass** | `results.e2e.ts` "B35": the history table ("3 attempts, newest first") lists the in-progress attempt (date via `Intl`, "In progress", a "Resume attempt of …" link), the retake ("Retake missed (3 questions)", "3 of 3 (100%)") and the first attempt ("3.5 of 6 (58.3%)", a duration in `Intl` units), with "Results of …" links to `/practice/attempts/<id>/results`; Resume and Discard are shown for the in-progress one; Discard opens an `alertdialog`, deletes it, announces "Attempt discarded." and the table drops to 2 rows. axe: zero violations on the test detail page with history, with the discard dialog open, and on the results page (B30). |

Home page (P1.md §6), `results.e2e.ts` "home": the proctor home lists recent attempts (five at most, `GET /practice/attempts?limit=5`) with links and scores, axe clean; the student home says "Practice tests appear here once a proctor shares one with you." and has no practice list.

**`bun run ci`:** all steps pass.

```
✔ biome check                       ✔ JSON Schema export is up to date
✔ lint rule build is up to date     ✔ typecheck (6 projects)
✔ lint-rule snapshot                ✔ bun test — 374 pass, 0 fail, 16 files
✔ suppression baseline (0)          ✔ ruff + ruff format, verify unit tests (3)
✔ i18n catalog check (371 keys)     ✔ Playwright + axe — 22 passed
```

**Deviations and notes.**
- The per-question review and the topic breakdown use the test's own order (`quizOrder`), like the export, not the shuffled order of the attempt.
- "Retake missed" on any results page retakes the misses of the **most recent** submitted attempt of the test (P1.md §5), which is the attempt shown unless an older result is opened; the button shows how many questions it will include.
- New dynamic catalog family `practice:kind.` tied to `PRACTICE_KINDS`.
