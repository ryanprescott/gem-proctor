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
