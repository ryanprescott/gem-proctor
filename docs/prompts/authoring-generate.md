# Prompt: `authoring.generate` (+ `verify.solve` blind program)

> Working draft, iterated against the probe and recorded here. Referenced from SPEC §3A.2, §3A.3.1 and §3B.4.
> The current texts moved to `packages/llm/prompts/` in P1.5 (`authoring.generate/gen-v8.md`, `verify.solve.blind/blind-v2.md`, `verify.solve.classify/classify-v1.md`, `program-repair/repair-v1.md`), and the `strict7` schema to `packages/shared/src/generation.ts`. This file keeps the history and the probe results. Older drafts stay in `tools/probes/l7/prompts/`.

**Current version:** `gen-v8` + **`strict7` schema** / `blind-v2` / `repair-v1` / `classify-v1`, with local inputs (`tools/probes/l7/inputs.py`) and local distractors (`distract.py`), on `qwen3.5-9b-32k` (§4). Texts: `packages/llm/prompts/`, schema: `SCHEMAS["strict7"]` in `tools/probes/l7/probe.py`. §2–3 below show v1, kept for history.
**Reference model:** `qwen2.5-16k` (Qwen2.5 7B Instruct Q5_K_M, Ollama 0.40.12, 16K context)

---

## 1. What the prompt must achieve

| # | Property | How it's checked |
|---|---|---|
| P1 | Every question cites a chunk and quotes it exactly | L2 |
| P2 | Computable questions are flagged `computable: true` and carry an `answerProgram` | L1 |
| P3 | **The model doesn't decide computable answers.** All options may be `isCorrect: false`; any mark is a hint only and is replaced by L7 | L7 flow A (`modelClaim` rate is reported, not failed) |
| P4 | `answerProgram` runs in the sandbox, uses whitelisted imports only, and returns the type the question needs | L7 |
| P5 | Distractors are plausible: each reflects a specific, common mistake | L6 judge (optional), creator review |
| P6 | The explanation describes the method and doesn't state a computed value | Local check (proposed, not yet in SPEC) |
| P7 | Non-computable `single_choice` marks exactly one option correct | L1 |

## 2. Generation prompt (`gen-v1`, history; current text in `tools/probes/l7/prompts/gen-v6.txt`)

The system message. Placeholders in `{{…}}`. Sources follow it in the user message, each tagged with its chunk id (SPEC §3A.2).

```text
You write quiz questions from the source material you are given, as JSON that matches the schema.

Every question:
- tests one idea from the sources, and cites it in `evidence`: the chunkId and an exact quote copied from that chunk.
- has a `topic`, a `question`, and an `explanation` of how to get the answer.

There are two kinds of question.

CONCEPT questions (computable = false): definitions, properties, which-statement-is-true.
- Mark exactly one option isCorrect = true.
- answerProgram = "".

CALCULATION questions (computable = true): anything whose answer is a value you could compute
(a number, vector, matrix, expression, or true/false from a calculation).
- You do not decide the answer. A program you write decides it.
- Write `answerProgram`: Python that sets a variable named `result` to the answer.
  Allowed imports: {{allowedImports}}. Nothing else.
  `result` must be: {{resultTypeRules}}
- Write the options as WRONG answers that a student could plausibly reach by a specific mistake:
  a sign error, a dropped term, the wrong formula, a transposed or swapped value, an off-by-one count.
  Leave every option isCorrect = false. The correct answer is added after your program runs.
- The explanation describes the method in words. Do not write the final value.

Example of a CALCULATION question:
{
  "tempId": "q1",
  "type": "single_choice",
  "topic": "Inner product",
  "question": "What is the inner product $x^T y$ of $x = [1, -2, 3]^T$ and $y = [4, 0, -1]^T$?",
  "options": [
    { "text": "7", "isCorrect": false, "whyWrong": "sign error on the last term" },
    { "text": "5", "isCorrect": false, "whyWrong": "adds the entries instead of multiplying them" },
    { "text": "4", "isCorrect": false, "whyWrong": "leaves out the last term" }
  ],
  "explanation": "Multiply the vectors entry by entry and add the products.",
  "computable": true,
  "answerProgram": "x = [1, -2, 3]\ny = [4, 0, -1]\nresult = sum(a * b for a, b in zip(x, y))",
  "evidence": [{ "chunkId": "vmls:ch1:s1.4:c1", "quote": "x^T y = x_1 y_1 + x_2 y_2 + ... + x_n y_n" }]
}

{{styleGuidance}}
```

Template variables:
- `{{allowedImports}}`: from the sandbox whitelist (SPEC §3A.3.1), e.g. `sympy, numpy, fractions, math, statistics, itertools`.
- `{{resultTypeRules}}`: per question type: `single_choice`/`numeric`/`short_answer` → "a number, Fraction, list (vector), list of lists (matrix) or sympy expression"; `true_false` → "True or False (a bool, not a number)".
- `{{styleGuidance}}`: the test type's style line (SPEC §3A.1.1).

Why it's written this way (small-model notes):
- Positive instructions and one complete example, instead of a list of "do not"s.
- The example's options are all `isCorrect: false`, so the most-copied pattern is the one we want.
- The example's distractors carry a `whyWrong`, which pushes toward deliberate mistakes rather than random numbers. The true value (1) isn't among them.
- The example is **not** a question the probe asks, so a probe run measures the behavior, not copying.

## 3. Blind program prompt (`blind-v1`, role `verify.solve`)

Gets the question text and the source passage only. Never the options, the author program, or any stated answer (SPEC §3A.3.1).

```text
Write a short Python program that computes the answer to the question below and sets a variable named `result`.
Allowed imports: {{allowedImports}}. Nothing else.
`result` must be: {{resultTypeRules}}
Reply as JSON: {"program": "..."}

Source passage:
{{passage}}

Question:
{{question}}
```

## 4. Probe results

The probe (`tools/probes/l7/probe.py`, see its README) sends a fixed request (one chunk on inner products and norms; 3 calculation questions and 1 concept question), runs both programs locally, and checks P2–P4 and P7. From v2 on it uses a real sympy/numpy runner and one repair retry per failed program (`repair-v1`). Raw output in `tools/probes/l7/results/` (stdlib-only imports, no sympy). It moves into the eval harness in P1.5.

| Version | Date | Model | Trials | Flagged computable | Model marked/stated an answer | Its answer right | Author program right | Blind program right | Both right | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `gen-v0` / `blind-v0` | 2026-10-28 | qwen2.5-16k, temp 0.7 | 3 × 3 calc | 9/9 | 7/9 | 2/9 | 9/9 | 6/9 | 6/9 | Below |
| `gen-v1` / `blind-v1` | 2026-10-28 | qwen2.5-16k, temp 0.7 | 5 × (3 calc + 1 concept) | 15/15 | 11/15 | 1/11 | 8/15 | 13/15 | 6/15 | Below. Counted by hand from the run output (the script's totals had a bug, since fixed) |
| `gen-v2` plain / `blind-v2` + repair | 2026-10-28 | qwen2.5-16k, temp 0.7, top_p 0.8 | 5 × (3 + 1) | 15/15 | 8/15 | 0/8 | 11/15 → **15/15** after repair | 15/15 | **15/15** | sympy/numpy available |
| `gen-v2` **strict** / `blind-v2` + repair | 2026-10-28 | same | 5 × (3 + 1) | 15/15 | **0/15** | — | 11 → 15/15 | 15/15 | 15/15 | Concept question copied example ex4 5/5 |
| `gen-v3` **strict** / `blind-v2` + repair | 2026-10-28 | same | 8 × (3 + 1) | 24/24 | **0/24** | — | 17 → 24/24 | 24/24 | 24/24 | Concept question copied the (new) example's topic 4/8 |
| `gen-v3` strict | 2026-10-29 | **qwen3.5-9b-32k** (Q4_K_M), thinking off, temp 0.7, top_p 0.8, top_k 20, presence_penalty 0 | 5 × (3 + 1) | 15/15 | **0/15** | — | 14 → 15/15 | 15/15 | 15/15 | Concept 5/5, no copying seen. ~22 s per batch |
| `gen-v4` strict | 2026-10-29 | qwen3.5-9b-32k (same) | 5 × (3 + 1) | 15/15 | **0/15** | — | 14 → 15/15 | 14 → 15/15 | 15/15 | One `whyWrong` was a 2,400-char ramble; one question had a single option |
| `gen-v4` strict, objective-only request | 2026-10-29 | qwen3.5-9b-32k (same) | 5 × (3 + 1) | 15/15 | 0/15 | — | ran 15/15 | ran 15/15 | **agree 15/15** | No example copying (0/20). But the true value was among the options in 5/5 choice questions, and the questions were near-identical across trials (below) |
| `gen-v5` **strict5** | 2026-10-29 | qwen3.5-9b-32k (same) | 5 × (3 + 1) | 15/15 | **0/15** | — | **15/15 first try** | 15/15 | 15/15 | True value among options 0/5; explanation leaks 0; option value matches its own `whyWrong` working 12/15 |
| `gen-v5` strict5, objective-only | 2026-10-29 | same | 8 × (3 + 1) | 24/24 | 0/24 | — | ran 24/24 | ran 24/24 | agree 24/24 (re-scored) | True value among options 6/8, duplicate options 2/8, distinct values 21/24 questions. Author wrapped `math.sqrt` in `Fraction` twice |
| `gen-v6` strict5, objective-only | 2026-10-29 | same | 8 × (3 + 1) | 24/24 | 0/24 | — | ran 24/24 | ran 24/24 | agree 24/24 (re-scored) | Exact `sqrt(n)` now used; no `Fraction`-wrapped floats. True value among options 6/8, duplicates 1/8, distinct values 20/24 |
| `gen-v8` **strict7**: named inputs, sampled locally | 2026-10-29 | same | 8 × (3 + 1), passage with a worked example | 24/24 | 0/24; **0 model-chosen numbers** | — | ran 24/24 | ran 24/24 | **agree 24/24** | Distinct input sets 24/24. 4 options 8/8. true_false target hit 6/8 (one constraint forbade True; one program error). The model set `from: source` 0/40 times. Concept with notation 2, both correctly classified not computable |
| `gen-v8` strict7 + chunk values first | 2026-10-29 | same | 8 × (3 + 1) | 24/24 | 0/24; 0 model-chosen numbers | — | ran 24/24 | ran 24/24 | agree 22/24 | The chunk's example vectors were used in 8/8 tests (once each). true_false target hit 8/8 (5 True). Both disagreements are from trial 4, which wrote **no placeholders** ("Given vectors x and y, …"); the L1 placeholder check fails those. No disguised calculations |
| `gen-v8` strict7, **`generate-smoke` through `packages/llm`** (P1.5 live run) | 2026-10-30 | same, Ollama 0.40.12, `native_schema`, `reasoning_effort: "none"` | 5 × (3 + 1), repo fixture chunk | — (schema, repairs and quotes only; no programs run) | — | — | — | — | — | Valid first try 5/5, 0 repairs, evidence verbatim 20/20, 6.44 s per question, 6.52 on a second run (24–28 s per call, 1,333–1,499 output tokens). `finishReason: stop` on all 5. First run through the runtime instead of the probe. |
| `gen-v8` strict7, **flow A through `packages/llm` and `packages/authoring`** (P2.1 live run, `llm:live`) | 2026-10-31 | same, Ollama 0.40.12, `native_schema`, `reasoning_effort: "none"`, the local verify parent | 5 + 8 × (3 + 1), repo fixture chunk | 37/39 | 0/37; 0 model-chosen numbers | — | — | — | **computed 33/37** | Computable 37 of 52: computed 33, programs disagree 1, `constraint_unmet` 3, none couldn't compute, no denial. 4 options 11/11; distractors common 18, random 11, near 4. true_false 10 reached an answer, 2 True, and 1 of the 6 in the second run missed a True target (the first run didn't count misses). That's a smaller share of True than the 5 of 8 above, on a small sample; each True was a real orthogonal pair. The probe's 24/24 and 22/24 were 8 trials of the same request. `l7-smoke` × 5: blind programs ran 30/30, agreed 30/30, no repairs, classification 100%, Q7 Wrong answer with `-1` 5/5. |
| `gen-v7` strict6, re-run with exact float conversion | 2026-10-29 | same | 8 × (3 + 1) | 21/24 (3 went to concept) | 0/21; 0 option values | — | ran 20/21 | ran 20/21 | agree 20/21 | Built choice questions: 4 options 5/5, no decimal giveaways. Options: 10 common, 5 random. Mistake programs ran 15/15, 1 equalled the answer. The miss is again a yes/no question typed single_choice. **New:** 3 "concept" questions were calculations about specific vectors ("Let x = [1, 2], y = [−2, 1]. Which statement is true?"), with the model marking the answer |
| `gen-v7` **strict6** + local distractors, objective-only | 2026-10-29 | same | 8 × (3 + 1) | 24/24 | 0/24; **0 model-written option values** | — | ran 23/24 | ran 23/24 | agree 23/24 | The miss is a yes/no question typed single_choice (bool result, fails the type check; regenerate). Built choice questions: **4 options 7/7**. Mistake programs 20/20 ran; 3 equalled the answer and were dropped automatically. Options: 12 common, 2 near, 7 random |

Both runs: every evidence quote was copied exactly (L2 would pass).

**`gen-v0` findings** (prompt: a rule list with "mark every option false", no example):
- The model marked an option correct on 7 of 9 computable questions, usually the wrong one (inner product 10 or 5 instead of −1; norm 13.89 instead of 13; orthogonal vectors marked "not orthogonal").
- Explanations stated those wrong values ("10 − 8 − 3 = 5"). → P6.
- The true value appeared among the distractors once (−1 in trial 1). Under SPEC v0.17 that's handled: the matching option becomes the correct one.
- Author programs: 9/9 correct values. Blind programs: one syntax error, one disallowed import (`operator`), and one returned `True` where the author program returned `0` for the true/false question. That last one is a type mismatch rather than a wrong answer. → `{{resultTypeRules}}`.

**`gen-v1` findings** (prompt: concept/calculation split, positive rules, one worked example with all options false):
- **Marking didn't stop.** The model still marked an answer on 11 of 15 calculation questions. On the inner-product questions it added a third option with `isCorrect: true` and no `whyWrong` every time (21, 16, 18, 19, 11; the true value is −1). On true/false it marked "False" for the orthogonal vectors 5 of 5 times. **1 of 11 marked answers was right.** This confirms that a mark on a computable question can only be a hint (SPEC v0.17).
- **Explanations improved.** No explanation stated a wrong computed value (v0 had several). The 2 hits from the number check were both "0" from the orthogonality definition: false positives, so the P6 check has to allow numbers that appear in the cited passage.
- **Distractors are decorative.** The `whyWrong` labels were copied from the example ("sign error on the last term", "adds the entries instead of multiplying them"), but the values don't follow from them: a sign error on the last term gives 5, and the model wrote 19, 21, 23. The true value was never among the distractors.
- **Author programs: 8/15.** All 5 norm programs called `math.sqrt` without `import math` (a `NameError`). 2 of 5 true/false programs returned the inner product `0` instead of `True`, ignoring the result-type rule. Inner products: 5/5.
- **Blind programs: 13/15.** The 2 failures imported `numpy`, which this probe's import list didn't allow (it's stdlib-only because sympy/numpy aren't installed here). numpy is on the real whitelist, so both would likely run in the sandbox.
- **Concept questions: 5/5** marked exactly one option correct and were not flagged computable.
- **Both programs right on 6/15.** Most failures are mechanical (a missing import, a wrong result type), which is what a one-shot repair retry is for (§5).

**`gen-v2`–`gen-v3` findings:**
- **The prompt alone can't stop the 7B model from answering** (v2 plain: still 8/15, every one wrong). It treats one option as "the correct one" and labels it so ("correct calculation: 10 − 8 − 3", next to the value 11). On true/false it marked "False" for the orthogonal vectors every time.
- **The grammar constraint stops it completely** (0/39 across v2 and v3 strict). The schema is one shallow `anyOf` on `computable`: when it's `true`, `isCorrect` is `const: false` and there is no `numericAnswer`. Ollama (llama.cpp grammar) enforces it, so the model can't emit an answer. This keeps `isCorrect` on every question, as SPEC v0.17 requires, and the validation rules are unchanged. → **Proposed for SPEC:** use this schema in `native_schema` mode; in `prompt_only` mode the hint rule still applies.
- **Field order matters.** llama.cpp writes properties in schema order. From v2 on, `computable` and `answerProgram` come before `options`.
- **Repair works.** Every author-program failure was a forgotten `import math` (the model copies `math.isclose` from the example and drops the import). One retry with the error message fixed all of them: 100% of programs right after repair in v2–v3.
- **Copying is the remaining problem.** Qwen2.5-7B copies examples closely: the concept question reused the example's wording (v2) or its off-source topic (v3, "transpose", which the source doesn't cover). L2 still passes, because the quote comes from the passage, so this would need L5/L6 to catch it. `gen-v4` moves every example to an unrelated everyday domain (shopping arithmetic, store policy) and adds an objective-only request mode to the probe, to measure copying of calculation examples too.
- **Distractors are still decorative:** the `whyWrong` arithmetic doesn't produce the option's value. See the distractor-program item below.
- **Explanations:** no leaks in v2–v3 (with the passage's numbers allowed).

**Qwen3.5-9B findings (2026-10-29):**
- **Setup on Ollama:** thinking is off with `reasoning_effort: "none"` on `/v1/chat/completions` (`think: false` is ignored there). The model's default sampling is for thinking mode (temperature 1.0, top_p 0.95, **presence_penalty 1.5**). A presence penalty that high fights JSON, so requests override it to 0. With thinking on, a plain arithmetic call took 18–41 s and ~750–1,000 reasoning tokens; off, 0.3 s.
- **Clearly better than Qwen2.5-7B** on the same prompts: the strict schema still gives 0 stated answers; the author program is right first time 14/15 (one wrong result type, fixed by repair); **no copying of the examples** in either v3 or v4 (Qwen2.5 copied the concept example in 4–5 of 5–8 trials).
- **The answer sneaks in as an option.** In the objective-only request (where the model picks its own numbers), the true value was one of the "wrong" options in **5/5** choice questions. SPEC v0.17 handles it (that option becomes the correct one), but the question then has one fewer real distractor. Once that option had a duplicate (`["0", "4", "0"]`), which is a fail.
- **Low variety.** Left to choose, it picked the same easy numbers almost every time (`[1, 2]·[3, 4]`, `‖[3, 4]‖`). Fine for one quiz, bad across a session: L4 would flag duplicates, and the questions are trivially easy. The prompt or blueprint needs to ask for varied, non-trivial values (or we seed them).
- **Thinking leaks into fields.** With thinking off, one `whyWrong` contained 2,376 characters of reasoning ("Wait, the correct is 10−8−3 = −1 … Let's use 15, 5, 10"). → Add `maxLength` to free-text fields in the schema (the grammar enforces it), and keep the L3 length check.
- **Option count isn't enforced.** One single-choice question came back with one option. → `minItems`/`maxItems` on `options` in the strict schema.
- **Distractors are better but still not reliably real mistakes** ("sign error on the third term" next to 14, where that mistake gives 5).
- **Explanations:** 3 of 15 in each fixed run listed intermediate values (9, 16, 144), and one stated the final −1. → The P6 check is worth having; consider generating the explanation after the answer is known.

**`gen-v5`–`gen-v6` + `strict5` findings (Qwen3.5-9B):**
- **`strict5` schema:** one `anyOf` branch per (computable, type): computable single_choice → exactly 3 options, each `isCorrect: const false`; numeric → no options; true_false → exactly `True`/`False`, both false; concept single_choice → 3–4 options. Text fields have `maxLength` (`whyWrong` 160, `explanation` 300, …) and `evidence` needs at least one item. The grammar enforces all of it: no rambles, no one-option questions.
- **Reason before value.** In `strict5`, each option's `whyWrong` comes before its `text`, and the prompt says to write the mistake and its working first. The option's value then matches its own working 12/15 times (it was essentially unrelated before). The working itself can still contain an arithmetic slip, so distractor programs remain the robust fix.
- **Variety:** asking for 3–5 entries, mixed signs, no textbook values took the objective-only runs from near-identical questions to 20–21 distinct value sets out of 24.
- **Exactness (`gen-v6`):** "use sympy.sqrt for square roots, Fraction only to divide integers" stopped `Fraction(math.sqrt(…))`, which would have looked exact and been graded with zero tolerance (SPEC §3A.3.1 step 5).
- **Still open: the true value among the "wrong" options** in 6/8 objective-only choice questions, and duplicate options in 1–2/8. SPEC v0.17 makes the matching option the correct one, so the question ends up with 3 options instead of 4; duplicates fail and regenerate. Decision needed: accept 3-option questions, or ask the model for a replacement distractor.
- **Probe fix:** the agreement check now compares exact and float values within a tolerance (`sqrt(38)` vs `6.1644…`), as SPEC §3A.3.1 specifies. Earlier "disagreements" in v5/v6 were this probe bug; both re-score to 24/24.

**`gen-v7` + `strict6` + local distractors (2026-10-29, two runs):**
- **Decision (Ryan):** the model doesn't choose option values. Distractors are built on our side: common errors and completely wrong values.
- **`strict6` schema:** every computable branch has `options: maxItems 0`. Computable single_choice adds `mistakes`: 2–3 items `{whyWrong (≤120, words only), program (≤400)}`, in that order. numeric and true_false have no mistakes; the system adds `True`/`False`. Concept single_choice is unchanged.
- **Local build (`distract.py`, the prototype of the verify worker's step).** Each mistake program runs in the sandbox (no repair; a failure just drops it).
  - Candidates must have the answer's shape. A float is turned back into exact form (`7.4833…` → `2\sqrt{14}`), or rounded.
  - A candidate equal to the answer or to another option is dropped.
  - Selection, seeded: **up to 2 common errors** (mistake programs) and **at least 1 completely wrong value** (random, same shape and kind, on the answer's scale). Generic slips fill any remaining place: sign, off by one, doubled, reciprocal, forgot the root / off by one under it, one entry flipped or off by one, transposed.
  - The options are then shuffled and all rendered by one formatter.
- **Result:** 0 model-written values, and every choice question had 4 options. The "true value among the options" problem is gone by construction: 3 mistake programs did produce the answer, and the build dropped them.
- **`whyWrong` texts often don't describe their programs.** "Swaps the order of multiplication for one pair" gave 31 for a true 32, although multiplication commutes. The value is still a real computed slip. But the text shouldn't be shown to students as feedback unless a check confirms it. It's for the creator's review.
- **The first run found a float leak:** `math.sqrt` in a mistake program rendered as `7.483314773547883` next to integers. That's why exact conversion was added. The re-run had no decimal giveaways.
- **The re-run found a loophole:** calculations disguised as concept questions, where the model marks the answer. SPEC v0.18 now sends every concept question that contains math notation through `verify.solve` classification. If it's computable, it fails and is regenerated as a calculation question. A prompt rule could reduce it too ("a question about specific values is a calculation question").
- **Remaining model-chosen numbers: the question's own inputs.** Variety dropped again: `[1, 2, 3]·[4, 5, 6]` twice, and `[1, -1]`, `[2, 2]` three times. Copy markers hit 3/24, all `[1, -2, 3]`, an old example value that appears only in the probe's marker list. → Proposed: the model writes the question with **named inputs** and we sample the values (§5).

**`gen-v8` + `strict7`: no model-chosen numbers (2026-10-29):**
- **Decision (Ryan):** concept questions with math notation must be checked for computability. Input values come from the source text where possible, otherwise local sampling with sane constraints. In SPEC v0.18, §3A.3.1 ("Notation check", "Input values").
- **Schema order:** `evidence` → `inputs` → `question` → `constraint` → `answerProgram` → `mistakes` → `explanation`. The citation comes first so that a source value can be copied from it.
- **Named inputs work.** The question uses `{x}`, the programs use `x` (predefined as SymPy values), and the sandbox fills in the values.
  - 0 stray numbers in 48 questions.
  - Programs agreed 24/24 in the first run.
  - Every input set was distinct.
  - Exact answers throughout: `sqrt(170)`; `t / n` on SymPy integers gives a `Rational`.
- **The model doesn't use `from: source`** (0/40) even with a worked example in the passage. So sourcing is done locally: vectors written in the cited chunk are used first, once per test. 8/8 tests used them.
- **true_false balance:** a seeded target truth value, with up to 2,000 redraws (~0.5 s) to reach it. 50 draws reached True only 3 times in 12, because random vectors are almost never orthogonal. One model constraint (`valid = u.dot(w) != 0` on an orthogonality question) made True impossible. → The prompt now says a true_false constraint must allow both answers, and the SPEC makes that case a warn.
- **Notation check + `classify-v1`:**
  - On the three disguised calculations from the `gen-v7` re-run (reconstructed: question text as logged, options written for the test), detection fired 3/3, and `classify-v1` said "computable" 3/3.
  - A symbol-only definition ("norm of x = [x_1, …, x_n]") was detected and classified as not computable. So were the 2 notation hits in the `gen-v8` run.
  - With the new prompt rule ("a question about specific numbers … is a calculation question"), no disguised calculations appeared in 16 tests.
- **A failure mode to catch:** a batch that ignores placeholders ("Given vectors x and y, what is their inner product?"). The L1 placeholder check (every declared input appears in the question, and vice versa) fails it. The blind program disagreed on 2 of its 3 questions anyway.

## 4.1 Model choice

**Current choice: `qwen3.5-9b-32k`** (Qwen3.5 9B Q4_K_M, 6.6 GB, 32K context), measured above. The table below was the shortlist before it; Qwen3.5 wasn't on it because it's newer than the assistant's knowledge.

| Model (Ollama tag) | Size at Q4_K_M | Fits 16K context? | Why |
|---|---|---|---|
| `qwen3:14b` | ~9 GB | Tight: needs flash attention + `OLLAMA_KV_CACHE_TYPE=q8_0`, or ~12K context | Clear step up in instruction following and math over Qwen2.5-7B. Best guess for `authoring.generate` |
| `qwen3:8b` | ~5 GB (Q8 ~9 GB) | Yes, even 32K | Safe fallback with room for context. Likely better than Qwen2.5-7B |
| `qwen2.5-coder:14b` | ~9 GB | Tight (as above) | For `verify.solve` only (writing programs) |

Qwen3 quirks to plan for:
- **Thinking mode is on by default.** For structured output, turn it off (Ollama `think: false` on `/api/chat`, or `/no_think` in the prompt). With it on, a grammar-constrained response can't contain the reasoning, and quality drops. `normalizeQuiz` already strips `<think>` blocks (SPEC §3D.2).
- **Ollama's context:** set `num_ctx` explicitly in a Modelfile (as with `qwen2.5-16k`). The default is small, and longer prompts are cut silently.
- **Sampling** (Qwen's recommendation for non-thinking mode): temperature 0.7, top_p 0.8, top_k 20.

Newer models may exist that this list doesn't know about. Whatever is picked, compare it on `gen-v4` strict, both request modes.

## 5. Open items

- P6 local check (numbers in the explanation that aren't in the question and aren't the computed value): proposed, not yet in SPEC.
- One repair retry for programs that fail with a syntax error, a `NameError`, an `ImportError` (a package the runner doesn't have; since SPEC v0.20 nothing is blocked by a static check) or the wrong result type, sending the error back once: proposed, not yet in SPEC. **Confirmed by v2–v3:** it fixed every failure.
- ~~Grammar union on `computable`~~: done. In SPEC since v0.18 as the per-branch constrained schema (§3A.2), the form used from `strict5` on. **Confirmed by v2–v3:** 0 answers stated.
- ~~Distractor programs~~: done in `gen-v7` as `mistakes`, with local distractors (§4).
- ~~**Locally sampled inputs**~~ (done in `gen-v8`, SPEC v0.18; the notes below are kept for history): the question uses named inputs (`{x}`, `{y}`) with a declared kind (integer, n-vector, m×n matrix), and `answerProgram` and the mistake programs read them. The system samples the values (seeded, within the instance's ranges), renders the question, and runs the blind program on the rendered text. That removes the last model-chosen numbers, and with them the variety problem. Constraints such as "non-orthogonal" or "invertible" are a `constraint` program that sets `valid` (SPEC §3A.3.1).
- ~~**Calculations disguised as concept questions**~~ (seen in the `gen-v7` re-run): done. A concept question whose question or options contain **math notation** goes through `verify.solve` classification. If it's computable, it fails and is regenerated as a calculation question (SPEC v0.18, §3A.3.1, "Notation check"). Questions without notation skip the call.
- Check `whyWrong` against its program (a judge or L6 item) before showing it to students as feedback.
- The P6 number check must allow numbers that appear in the question **or the cited passage**.
- ~~`operator` on the whitelist~~: done. It's standard library, so it's always present in the runner. SPEC v0.21 adds it to the prompt's module list. Add it to `ALLOWED` in the probe when the next prompt version is tested.
- Temperature per call: lower (~0.2) for `answerProgram` and blind programs? Needs a probe comparison.
