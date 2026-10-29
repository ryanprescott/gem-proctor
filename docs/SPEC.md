# gem-proctor — Product & Technical Spec (Draft v0.17)

> Status: **Draft for iteration.** Nothing here is final. Open questions are collected in §13; planned contingencies and the decision log are in §15.
> Last updated: 2026-10-29 (v0.18: computable questions take their input values from the source text or from local sampling, and choice questions get locally built distractors, so the model chooses no numbers; concept questions with math notation are checked for computability, §3A.3.1. v0.17: `isCorrect` rule for computable questions; generation prompt in `docs/prompts/`. v0.16: computable answers are computed locally, §3A.3.1)

---

## 1. Overview

gem-proctor is a web app for practice tests and proctored tests. It provides:

1. **Grounded authoring with an LLM** (primary way to create tests; works with any model, from a frontier cloud model to an open-weight model on your own hardware): a test creator adds source material. The model generates questions in our schema, and every question cites the source. Local validators check structure, grounding and coverage. The creator and the model then go back and forth until the material is properly covered. See §3A.
2. **Import/export** of quizzes in one JSON format (the Quiz format, §4). Lenient normalization fixes common formatting mistakes in model output (§3D.2).
3. **Practice mode** with unlimited retakes and history.
4. **Optional AI analysis** of results, using whichever model the admin assigns.
5. **Proctored mode**: proctors assign tests, students take them once, proctors review and grade.

### 1.1 Goals

- One data model, built on the base quiz JSON format (§2). LLM generation, import, export and results all use it.
- Quizzes are mostly **generated from curriculum by the model** (§3A). Import is a secondary convenience.
- **Model-agnostic:** no feature depends on a particular model or vendor. Any model the LLM layer can reach works, cloud or self-hosted (§3B). A fully local setup is supported, with nothing leaving your infrastructure.
- Every generated question can be traced to a specific passage in the source material, and that link is checked locally, not just trusted.
- Same test-taking UI in practice and proctored modes. Only the rules around it change (attempt limits, when feedback is shown, who sees answers).
- End-to-end type safety from shared Zod schemas.
- **Postgres + pgvector from day one.** One database holds the app data and the knowledge base (§3C). Everything runs as a Docker Compose stack (§11.5).

### 1.2 Non-goals (v1)

- Lockdown-browser style exam security or integrity monitoring (tab switches, paste detection, etc.).
- Generating tests from no source material ("make me a quiz on linear algebra"). Generation always needs uploaded source material.
- LMS integrations (LTI, Google Classroom). Possible later.
- Multi-tenancy. One deployment is one organization (single-tenant).
- Real-time live proctoring (webcam, screen share).
- Extracting text from PDFs, DOCX, scans or whole books. Creators bring source material in as text or Markdown themselves (§3C).

### 1.3 Cross-cutting requirements (v1)

These apply to every feature, from the first release.

**Audit logging (required)**
- Every **admin action** is written to an append-only `AuditLog`: user creation, disabling and deletion; role grants and revocations; password resets; instance-setting changes; LLM endpoint create/edit/delete and role-assignment changes; endpoint secret changes (the fact of the change only, never the value).
- Also logged: proctor **submission resets**, **results releases** and `resultVisibility` changes, and grade overrides (in addition to `GradeOverride`).
- Each entry records actor, action, target, before/after (secrets redacted), timestamp, IP and user agent.
- The app never updates or deletes audit rows: the application's database user has only `INSERT`/`SELECT` on the table. Admins can view and filter the log in the UI and export it as CSV.
- Question-level provenance stays in `QuestionEvent` (§3A.1). The audit log covers platform and governance actions.

**Accessibility: WCAG 2.2 Level AA, from day one**
- Every screen meets **WCAG 2.2 AA**: full keyboard operation with visible focus, correct semantics and ARIA, labels on every form control, contrast ≥ 4.5:1, no information conveyed by color alone, reflow at 320 px and 200% zoom, respect for `prefers-reduced-motion`, and live-region announcements for async updates (generation progress, autosave, immediate feedback).
- **Math is accessible:** KaTeX renders with **MathML** output alongside the visual HTML, so screen readers can read equations. Every rendered formula keeps its LaTeX source available.
- **Timing (WCAG 2.2.1):** the practice timer never ends an attempt. For proctored **time limits**, proctors can grant per-student **extended time** (an accommodation multiplier, e.g. ×1.5), and students get warnings before time runs out.
- **Test-taking UI:** options are a real radio or checkbox group. Shuffling never breaks reading order. Flag-for-review and navigation are reachable by keyboard and announced.
- **Verification:** automated axe-core checks in Playwright on every page in CI (a failure blocks the merge), plus a manual screen-reader pass (NVDA and VoiceOver) before each release. Components come from an accessible headless library (e.g. React Aria).

**Internationalization: English only, i18n-ready**
- v1 ships in **English only**, but **every user-facing string** goes through i18n string tables from the start: no hard-coded UI text. Frontend: **i18next / react-i18next** with namespaced JSON catalogs (`en`). Dates, numbers and percentages are formatted with `Intl`.
- **API errors** return stable **error codes** plus parameters, never English sentences. The frontend maps codes to strings.
- **Lint rule `no-literal-ui-string`** (a custom Biome plugin, specified in §11.6) blocks hard-coded user-facing text in the web app. A companion CI check keeps the string catalogs and the code in sync.
- **Quiz content** (questions, options, sources) is not translated; it's in whatever language the curriculum is. Prompts ask the model to write in the source's language (English in v1).

---

## 2. Base data model

The JSON format in **`tests/engr108_chapter1_new_20q_quiz.json`** is the **base model** for gem-proctor. Everything else builds on it: the extended schema (§4), import/export (§3D), generation output (§3A) and results (§6, §9). Its field names are kept **exactly as they are** (`quiz_title`, `topics_covered`, `options`, `correctAnswer`, …), so any file in the base format is always valid input, and the base format is always a valid export.

### 2.1 Base quiz format

```jsonc
{
  "quiz_title": "Stanford ENGR108 Chapter 1 Practice Quiz (Set 2)",
  "course": "Stanford ENGR108 / VMLS (Boyd & Vandenberghe)",
  "chapter": 1,                          // int
  "total_questions": 20,                 // int, = questions.length
  "topics_covered": ["Notation & Vector Definition", "..."],   // quiz-level topics (broader than per-question topics)
  "questions": [
    {
      "id": 1,                           // int, 1-based, unique within the quiz
      "topic": "Notation & Dimensions",  // per-question topic (finer-grained)
      "question": "What is the dimension of ... $z = \\begin{bmatrix} -4 & 2 & 7 & 0 & 9 & -1 \\end{bmatrix}^T$?",
      "options": ["5", "6", "7", "4"],   // answer options; present on choice questions
      "correctAnswer": "6"               // choice questions: exactly one of `options`
    }
  ]
}
```

### 2.2 Result format (derived)

A result is **the same quiz plus one attempt**. Each question gets `userAnswer` / `userIsCorrect`, and the top level gets `score` / `percentage`. The key stays `questions`, so a result file is a valid quiz file with extra fields.

```jsonc
{
  "quiz_title": "...", "course": "...", "chapter": 1, "total_questions": 20, "topics_covered": ["..."],
  "score": 18,                           // number (points earned)
  "percentage": 90.0,
  "questions": [
    { "id": 1, "topic": "...", "question": "...", "options": ["..."], "correctAnswer": "6",
      "userAnswer": "6", "userIsCorrect": true }
  ]
}
```

### 2.3 Conventions

| Rule | Detail |
|---|---|
| Base field names are fixed | Never renamed, even though casing is mixed. **New fields use camelCase** (matching `correctAnswer`). |
| Everything we add is optional | A file with only base fields is always valid. Extensions (§4) only add optional fields. |
| `id` is the question's identity | 1-based integer, unique within a quiz, and stable within a published `TestVersion`. Responses refer to it. |
| `options` + `correctAnswer` | Every choice question has its answer options in `options`. `correctAnswer` must **exactly** equal one of them. Options are written once, by whoever authors the question (a person, or the model during authoring, §3A). Nothing generates them afterwards. |
| No `options` means a typed answer | A question without `options` is short-answer (or numeric, if `type` says so), graded per §7. |
| `topics_covered` vs `topic` | `topics_covered` lists the quiz's broad topics. In authoring these are the **learning objectives** in scope (§3A.1). Each question's `topic` is a finer label within one of them. |
| `course` / `chapter` | `course` is free text, which in authoring comes from the source's citation label. `chapter` is a single integer; multi-chapter tests (unit test, midterm, final) use the extension `chapters` (§4). |
| Derived fields are recomputed | `total_questions`, `score` and `percentage` are always recomputed by the server. On import, a mismatch is a warning; the recomputed values win. |
| Text format | Markdown with `$...$` / `$$...$$` LaTeX, rendered with KaTeX, in `question`, `options` and `correctAnswer`. Plain text is fine too. |

### 2.4 What the sample file shows

The file is a good example of exactly what the local checks have to catch. **Question 7** ("inner product of $x = [2, 4, -3]^T$ and $y = [5, -2, 1]^T$") has `correctAnswer: "1"`, but the options are `["5", "3", "7", "-1"]`. The correct value is $10 - 8 - 3 = -1$.
- **Validation** (§4) flags this as an error, because `correctAnswer` isn't one of the `options`. The quiz can't be saved until it's resolved.
- **Normalization** (§3D.2) must **not** "fix" it by snapping to the closest option. `"1"` → `"-1"` happens to be right here, but that kind of guess is exactly what normalization refuses to make. It stays an error for a human (or the repair loop) to resolve.
- **Answer verification (L7, §3A.3.1)** catches it on import. It computes $x^T y = -1$ independently, finds that this matches option `"-1"`, not `"1"`, and offers the creator that fix to confirm. A numerically wrong answer can look perfectly well-formed, which is why computable answers are always checked by computation.

---

## 3A. Grounded authoring

The model assigned to each authoring role (§3B) writes questions in our schema (§2 base + §4 extensions). It reads source material that the creator adds. Every question it writes must point back to the exact passage it tests. Local validators check each question. The creator steers coverage over several rounds.

### 3A.1 Workflow

```
 ┌─────────────┐   ┌──────────────┐   ┌────────────┐   ┌────────────┐   ┌──────────────┐   ┌─────────┐
 │ 1. Sources  │──▶│ 2. Objectives│──▶│ 3. Blueprint│──▶│ 4. Generate│──▶│ 5. Validate  │──▶│ 6. Review│
 │ upload+chunk│   │ model drafts │   │ creator sets│   │ model      │   │ local checks │   │ creator  │
 └─────────────┘   │ creator edits│   │ counts/mix  │   └────────────┘   └──────────────┘   └────┬────┘
                   └──────────────┘   └────────────┘          ▲                                  │
                                                              └──────── 7. Revise (targeted) ◀───┤
                                                                                                 ▼
                                                                                      8. Publish TestVersion
```

1. **Sources & scope.** The creator picks text sources from their **source library** (§3C), or adds new ones by pasting or uploading `.md`/`.txt`. They then narrow the **scope** to particular sections (from the Markdown headings), e.g. "§1.1–1.4 only". Only chunks inside the scope go on to the next steps. The stored text is what the local grounding check (§3A.3) compares against.
2. **Learning objectives.** The model reads the in-scope chunks from the knowledge base (§3C; section by section for long sources, then merged) and proposes a list of learning objectives / topics. Each one cites the chunks it comes from. The creator edits, merges, removes or adds objectives. This list becomes the **coverage target**.
3. **Blueprint.** The creator picks a **test type** (§3A.1.1), which fills in the defaults: question count, question-type mix, how questions are spread across the selected sections, and style guidance for the model. The creator can then change any number and add constraints ("no questions on §1.4", "include 3 applied word problems"). Together with the **scope** from step 1, this is what sets how hard the test is. There's no separate difficulty setting.
4. **Generate.** The model writes questions that follow the blueprint, in the **generation schema** (§3A.2). Each question includes its objective id(s), source chunk id(s), and a verbatim supporting quote. For a **computable** question the model writes no answer and no option values: it writes the question and programs, and the answer and the options are computed locally (§3A.3.1).
5. **Validate.** The local pipeline (§3A.3) checks every question and builds a **coverage matrix** (objectives × questions, plus source sections that no question touches).
6. **Review.** The creator sees each question with its validation results and source passage next to it. Per-question actions: **accept / edit / reject / regenerate with a note** ("too easy", "distractor B is also correct", "test the concept, not the definition"). Whole-test actions: "more on objective 3", "fill coverage gaps".
7. **Revise.** Only the affected questions go back to the model, along with the creator's notes and the validation failures. Accepted questions are **locked**: they're sent as context so the model avoids duplicating them, but the model can't change them. Steps 5–7 repeat until the creator is satisfied.
8. **Publish.** Accepted questions are converted to the extended quiz schema (§4) and saved as an immutable `TestVersion`. The version records how it was made: which sources, which session, how many rounds, and the model id.

Each round is saved as a numbered **revision** in an `AuthoringSession`, so the creator can compare rounds or go back to an earlier one.

**Provenance is never thrown away.** Every published question can be traced back through:
- its source passage(s) and the source revision it was generated from (`evidence`);
- the revision and model call that produced it (endpoint, model, prompt version);
- every later change: regenerations (`supersedesId` chain), creator edits (`provenance: "llm_edited"` / `"human"`, with who and when), and accepted L7 fixes (old → new `correctAnswer`);
- its validation and verification results at each revision.

The published `TestVersion` keeps a frozen copy of this trail, so it stays readable even if the authoring session is later deleted.

### 3A.1.1 Test types

A test type is a **preset for the blueprint**. It only provides defaults, and every value can be changed. It's stored on the quiz as `testType` (§4).

| `testType` | Typical scope | Default length | Default mix | Spread & style guidance |
|---|---|---|---|---|
| `chapter_quiz` | 1 chapter | ~10 | Mostly single choice | Even across the chapter's sections. Individual concepts and definitions. |
| `homework` | 1 chapter | ~10–15 | More short answer / numeric | Even. Practice applying each concept. |
| `unit_test` | A few chapters | ~20–25 | Mixed | Proportional to section length. Some questions combine ideas within the unit. |
| `midterm` | About half the course | ~30–40 | Mixed | Proportional. More application, and questions that span chapters. |
| `final` | Everything (cumulative) | ~40–50 | Mixed | Proportional across all selected chapters, with a minimum per chapter. Includes questions that combine chapters. |
| `custom` | Any | Creator sets it | Creator sets it | None |

- Presets are a fixed list in `packages/shared` for v1 (instance-defined presets: §13).
- The style guidance is a short line added to the generation prompt. It's versioned with the prompts (§3B.4).
- "Proportional to section length" uses token counts of the selected sections, with a minimum of one question per objective.

### 3A.2 Generation schema & model integration

- **Structured outputs.** Generation calls the LLM layer's `generateObject(GenerationBatch)`. The backend enforces the schema as well as it can (§3B.3), and the result is **always** re-validated with Zod on our side, whatever the backend claims.
- **Generation schema ≠ extended quiz schema.** The schema the model fills in is kept simple: no deep unions, and options are given as objects with an `isCorrect` flag instead of a separate answer field. A deterministic mapper in `packages/shared` converts it to the extended `Question` (§4): it fills `options` and sets `correctAnswer` from the correct one (for computable questions, from the computed value, §3A.3.1), assigns `id`s 1..n, fills `topics_covered` from the objectives, and so on. This keeps the generation schema within what constrained decoding handles well and keeps model-facing changes separate from storage changes.

```ts
// Sketch
GeneratedQuestion = z.object({
  tempId: z.string(),
  objectiveIds: z.array(z.string()).min(1),
  type: z.enum(["single_choice", "multi_choice", "short_answer", "numeric", "true_false"]),
  topic: z.string(),
  question: z.string(),
  options: z.array(z.object({ text: z.string(), isCorrect: z.boolean(), whyWrong: z.string().optional() })).optional(),
                                                       // at most one isCorrect true; computable: empty (L7 builds them)
  acceptedAnswers: z.array(z.string()).optional(),     // short_answer; computable: a hint only, replaced by L7
  numericAnswer: z.object({ value: z.number(), tolerance: z.number() }).optional(),   // computable: a hint only, replaced by L7
  explanation: z.string(),                             // computable: explains the method, never states the value
  computable: z.boolean(),                             // the model decides *whether* it's computable, never the answer (§3A.3.1)
  answerProgram: z.string().optional(),                // required when computable: Python setting `result`, whitelisted tools
  mistakes: z.array(z.object({ whyWrong: z.string(), program: z.string() })).max(3).optional(),
                                                       // computable single_choice: 2–3 common mistakes as programs (§3A.3.1)
  inputs: z.array(z.object({                           // computable: the question's {placeholders} (§3A.3.1, input values)
    name: z.string(), kind: z.enum(["integer", "rational", "vector", "matrix"]), size: z.array(z.number().int()).optional(),
    from: z.enum(["source", "sample"]), sourceText: z.string().optional(),   // source: copied verbatim from an evidence quote
  })).optional(),
  constraint: z.string().optional(),                   // computable: Python setting `valid` from the inputs
  evidence: z.array(z.object({ chunkId: z.string(), quote: z.string() })).min(1),
})
GenerationBatch = z.object({ questions: z.array(GeneratedQuestion), notes: z.string().optional() })
```

- **`isCorrect` and computable questions.** `isCorrect` exists on every question's options, and **at most one** may be `true`. A non-computable `single_choice` question needs exactly one. A **computable** question comes back from the model with **no options**. It supplies `answerProgram` and, for `single_choice`, 2–3 `mistakes`. After L7, the options are the computed answer (the only `isCorrect: true`) plus locally built distractors (§3A.3.1, flow A). If the model wrote options, a `numericAnswer` or `acceptedAnswers` on a computable question anyway (possible in `prompt_only` mode), they're discarded: a marked or stated value that differs from the computed one is recorded as `verification.modelClaim`, and nothing the model wrote becomes an option.
- **Constrained schema.** In `native_schema` mode (§3B.3) the JSON Schema sent to the server is one shallow `anyOf` with a branch per (computable, type). On computable branches `options` has `maxItems: 0`; on computable `single_choice` `mistakes` has 2–3 items; concept `single_choice` has 3–4 options. Free-text fields have a `maxLength`, and `evidence` needs at least one item. Properties are listed in the order they should be written (`computable` and `answerProgram` before `options`; `whyWrong` before `program`), because grammar-constrained servers emit them in schema order. The Zod schema above stays the validation contract; the constrained schema is generated from it per branch.
- **Prompt.** The generation prompt (including the role guidance for computable questions and for writing distractors) is kept in [`docs/prompts/authoring-generate.md`](prompts/authoring-generate.md), where it's iterated with the probe results. It moves into `packages/llm/prompts` when the LLM layer is built (§3B.4).

- **Citations, done our way.** The schema asks for `evidence: { chunkId, quote }`, and we verify those locally (§3A.3). No server-side citation feature is needed.
- **How sources are sent.** For each objective, our server **retrieves** the relevant chunks from the knowledge base (§3C.3) and sends their text, each chunk tagged with its id. The model never queries the knowledge base itself, and only sees what we send. So ids and quotes always match stored text, and we always know exactly what the model was shown (recorded with the revision).
- **Context budget.** Retrieval returns as many top-ranked chunks (plus neighbouring ones) as fit the role's `contextWindow` (§3B.2), after leaving room for instructions and output. Small local models get fewer chunks per call; large models can take a whole section.
- **Prompt caching.** Stable instructions and source chunks go at the front of the prompt, and revision rounds only add messages to the end. That layout makes the most of whatever caching the backend offers: automatic prefix caching on local servers (vLLM, llama.cpp), or explicit prompt caching on cloud APIs (set through provider-specific options). Revision rounds then don't re-process the sources from scratch.
- **Batches.** Calls stream, and are split by objective (e.g. 3–5 questions per call on a 7–14B model, more on large models) so one bad batch doesn't hold up the rest. Calls go through a per-endpoint queue (§3B.2), so a single local GPU isn't flooded and cloud rate limits are respected.
- **Failures.** Normalize the finish reason (complete, truncated by length, refused, error/timeout). A batch that fails Zod parsing goes through the **repair loop** (§3B.3). After that it is shown to the creator as a failed batch, never silently dropped.

### 3A.2.1 Why the local checks matter

The checks are the same for every model, but they matter most for small ones. A 7–14B model running on one consumer GPU (e.g. Qwen on an RTX 3060 12 GB) produces valid JSON fairly reliably when decoding is constrained. It is noticeably weaker than a frontier model at **faithful quoting, plausible distractors, and making sure exactly one answer is correct**. Arithmetic is unreliable too: in a test on the reference setup (Qwen2.5 7B on Ollama), the model wrote out sample Q7 as $10 - 8 - 3$ and then answered $-14$. The design accounts for that:

- L2 grounding and L3 leakage checks (§3A.3) catch the most common failures without any extra model calls.
- Computable answers never come from the model at all (§3A.3.1).
- Roles can point at **different models** (§3B.2). For example, a local model generates and a stronger model (local or cloud) runs the L6 judge, only on questions that already pass L1–L5.
- With all roles on local endpoints, source material and student answers stay on your own infrastructure.

### 3A.3 Local validation pipeline

Structured outputs already guarantee that the JSON has the right **shape**, so the shape alone doesn't need a classifier. The local checks look at whether each question is **correct, grounded and useful**. They run in order, and each check reports `pass | warn | fail` with a reason:

| Layer | Check | How (all local) |
|---|---|---|
| **L1 Structure** | Parses as `GeneratedQuestion`. Cross-field rules: at most one option has `isCorrect: true`; a non-computable single_choice has exactly one; options are unique; `objectiveIds` and `chunkId`s exist. Computable questions: `answerProgram` present, the type is one that can be computed (§3A.3.1), no options from the model, and 2–3 `mistakes` for `single_choice`. Every `{placeholder}` in the question is declared in `inputs` and vice versa; a number in the question outside a placeholder (and not in the cited quote) is a **warn**, since it may be a model-chosen input; a `source` input's `sourceText` appears in an evidence quote. After L7, exactly one option is true. | Zod + `superRefine` |
| **L2 Grounding** | Each `evidence.quote` actually appears in the cited chunk. | Normalized exact match, then fuzzy match (token-level similarity ≥ threshold). A **fail** means a missing chunk or a quote that isn't there, which is a likely hallucination. |
| **L3 Answer leakage & form** | The correct answer isn't given away by the question text; the longest choice isn't always the correct one; no "all of the above"/"none of the above" unless allowed; the text is reasonably short. | Heuristics |
| **L4 Duplicates** | Near-duplicate questions within the test, or against locked questions. | Question embeddings (same `embeddings` role as the knowledge base) + cosine threshold, plus n-gram overlap. |
| **L5 Coverage** | Each question maps to its claimed objective; finds in-scope chunks, sections and objectives that no question covers. | Citations (`evidence.chunkId`) plus embedding similarity between questions, objectives and knowledge-base chunks → coverage matrix and source heatmap. A question whose claimed objective doesn't match its content gets a **warn**. |
| **L6 Judge (optional)** | Is it really answerable from the evidence? Is exactly one answer correct? Are any distractors also defensible? | A separate model call (the `authoring.judge` role, ideally a different model from the generator) that grades one question at a time against its evidence. **Off by default** (it roughly doubles the model calls per question). Turned on per authoring session. Computable answers are covered by L7 regardless. |
| **L7 Answer computation & verification** | Generated computable questions: the answer is **computed**, never stated by the model. Imported or hand-edited computable questions: the stated answer equals an **independent computation**. | Two programs (the generator's `answerProgram` and a blind one from `verify.solve`, which never sees options or answer) run in a sandboxed Python worker with whitelisted math libraries. They must agree, and their result becomes (or is compared with) the answer. See §3A.3.1. |

- L1–L3 run entirely in-process. L4/L5 use vectors already stored in the knowledge base (plus one embedding per new question). All five are fast, deterministic (apart from the embedding model version) and cheap to re-run.
- L7 needs one model call per computable question, to write the blind check (cached with the question), plus two local sandbox runs. Re-running it with the same check is deterministic and free.
- A question with any **fail** can't be accepted until it's fixed or regenerated. **Warn**s are shown but don't block.
- Validation results are saved per question per revision, so the creator can see what changed between rounds.

### 3A.3.1 Answer computation & verification (L7)

**Principle:** for anything computable, **the model never decides the answer.** It decides *whether* a question is computable, and writes the question and programs. The answer is whatever a local library computes, and for choice questions **the options are built locally too**: the model never writes a value that a student sees as an option. Generated computable questions have no model-stated answer at all, and a stated answer on an imported or edited question is only ever checked against the computation, never trusted.

There are two paths:
- **Generated questions: the answer is computed.** The generator leaves the answer blank, and L7 fills it in (flow A).
- **Imported or hand-edited questions: the answer is checked.** These already have a `correctAnswer`, and L7 compares it with an independent computation (flow B, sample Q7).

**Which questions can be computable (v1):** `single_choice`, `true_false`, `numeric` and `short_answer`. `multi_choice` is never computable in v1 (§13), because its answer depends on evaluating each option.

**Check programs.** A check program is a few lines of Python that set `result` using whitelisted tools only (sandbox, below). Example for sample Q7:
```python
from sympy import Matrix
x = Matrix([2, 4, -3]); y = Matrix([5, -2, 1])
result = x.dot(y)
```
Every computable question gets **two independent programs**, so a single buggy program can't silently produce a wrong answer:
- the **author program** (`answerProgram`), written by the generator together with the question;
- the **blind program**, written by the `verify.solve` role (§3B) from the question text and the source passage only. It does **not** see the options, the author program, or any stated answer.

Both run in the sandbox (`apps/verify`). Each returns a value: a number, rational, vector, matrix, symbolic expression or boolean. Two values are **equal** if they are exactly or symbolically equal (`simplify(a - b) == 0`), or within a tolerance for floats.

**Flow A: generated computable question (answer computed)**

**Notation check (concept questions).** Every generated question the model marks **not computable** is scanned locally for mathematical notation in its question and options. Notation means any of:
- math delimiters (`$…$`, `\(…\)`, `\[…\]`) or LaTeX commands;
- a bracketed or parenthesised list of numbers (`[1, 2]`, `(1, −2, 2)`);
- numbers joined by an operator or `=`;
- symbols with sub- or superscripts (`x_1`, `x^T`).

If the scan finds any, `verify.solve` classifies the question, as in flow B, step 1. If it finds the question computable (e.g. "Let $x = [1, 2]$, $y = [-2, 1]$. Which statement is true?"), the question **fails** and is regenerated as a calculation question, with the reason "calculation written as a concept question". The answer the model marked is never used. A definition written in symbols only (`x^T y = x_1 y_1 + …`) normally classifies as not computable and passes. A question without notation skips the classification call. Without this check, a calculation could pass as a concept question with a model-decided answer; the probe has seen that happen.

**Input values.** The model doesn't choose a computable question's numbers either. The question text names its inputs as placeholders (`{x}`, `{y}`), and the generator declares each one in `inputs` (§3A.2): a `kind` (`integer`, `rational`, `vector` or `matrix`), an optional size (`n` or `m×n`), and where its value comes from:
- **Values from the source text come first.** The sandbox parses the values written out in the question's cited chunks (vectors and matrices such as `x = (1, −2, 2)` in a worked example, a table or given data). It uses them in order of appearance for inputs of a matching kind and size, before sampling anything. The constraint still applies, and if the values fail it, they're sampled instead. Each source value is used once per test. This doesn't depend on the model: in the probe, the model never chose `source` on its own (0 of 40 inputs), although the passage had a worked example.
- **`from: "source"`** (optional): the generator can also point at a specific value by copying it into `sourceText`, e.g. a scalar that isn't written as a tuple. It's parsed locally and **must appear in one of the question's evidence quotes** (after normalizing whitespace, minus signs and brackets), otherwise the question fails.
- **`from: "sample"`**: values are drawn locally with a seeded random draw. Defaults (instance setting; a test type can override them):
  - integers in −9…9;
  - vectors of 3–5 entries, the same length for every vector in the question unless sizes are declared;
  - at least one negative entry, at most one zero, not all entries equal;
  - matrices from 2×2 to 3×3;
  - no well-known textbook values (`[1, 2]`, `[3, 4]`, `[1, 2, 3]`, `[4, 5, 6]`, unit vectors), and no value set already used in the test.
- **`constraint`** (optional): a program that reads the inputs and sets `valid`. Examples: `valid = x.dot(y) != 0` for "not orthogonal", `valid = A.det() != 0` for "invertible". Sampling redraws up to 50 times; if no draw is valid, the question **fails** ("constraint can't be met").
- **`true_false`**: a constraint must allow both answers; one that only ever lets one answer through (e.g. "not orthogonal" on an orthogonality question) is a **warn**, found when sampling can't reach the target. The system picks a target truth value with the seeded draw, about half True. Sampling redraws until the computed result matches it, so the answers aren't nearly always False (random vectors are almost never orthogonal). It allows up to 2,000 draws, about 0.5 s: in the probe, 50 draws reached a True target only 3 times in 12, and 2,000 reached it every time. If no draw hits the target, the last valid draw is used.

The values are rendered into the question by the option formatter (step 5). They're predefined as SymPy values in `answerProgram`, in the mistake programs and in `constraint`: `Integer`, `Rational`, or `Matrix`, with vectors as columns. The blind program sees only the rendered question. The values and the seed are recorded in `verification`. All of this happens before step 2.

1. **Classify.** The generator sets `computable: true`, writes the question, supplies `answerProgram` and (for `single_choice`) 2–3 `mistakes`, and writes no options (§3A.2). Anything it marks or states as an answer anyway is discarded (recorded as `modelClaim`).
2. **Blind program.** `verify.solve` writes the blind program.
3. **Run both** in the sandbox.
4. **Agree?**

   | Outcome | Condition | Result |
   |---|---|---|
   | **Computed** | Both programs succeed and their values are equal | The value becomes the answer (step 5). **pass**, `verification.status = "computed"` |
   | **Programs disagree** | Both succeed, values differ | **fail**. The creator sees both programs and values. They can pick one (recorded as `fix_accepted`, with a note), or regenerate |
   | **Couldn't compute** | Either program fails or times out | **warn**, `status = "unverified"`. The question has **no answer** and can't be accepted until it's re-run, regenerated, or the creator supplies the answer by hand (`provenance: "human"`, re-checked by flow B) |

5. **Build the answer** from the computed value:
   - **`single_choice`:** build the options locally (`apps/verify`):
     1. **Common errors.** Run each `mistakes[].program` in the sandbox (no repair; one that fails is dropped). Its value is what a student making that mistake would get.
     2. **Candidates.** A candidate must have the answer's shape (scalar, or the same vector or matrix dimensions). A float is converted to exact form where one fits (`7.4833…` → $2\sqrt{14}$), otherwise rounded to 3 places. Candidates equal to the answer or to each other are dropped.
     3. **Choose** `distractorCount` distractors (instance setting, default 3), with a seeded random draw:
        - **up to 2 common errors**;
        - **at least 1 completely wrong value**: random, the same shape and kind as the answer (integer, rational, surd), and on its scale;
        - any remaining places filled by **generic slips** of the answer: sign flipped, off by one, doubled, reciprocal, forgot the root or off by one under it, one entry flipped or off by one, transposed.

        Then add more random values until there are enough.
     4. **Assemble.** The computed answer (`isCorrect: true`) plus the distractors, in seeded random order. **All options are rendered by one formatter** (integers and decimals as plain text; rationals as $\frac{p}{q}$; vectors and matrices as $\begin{bmatrix}…\end{bmatrix}$, with `^T` for column vectors written inline; other expressions through `sympy.latex`, in `$…$`). `correctAnswer` is the correct option's text. Using one formatter for every option means the correct one can't stand out by its formatting (an L3 concern).
     5. **Record** each distractor's source (`common`, `near` or `random`), its reason and, for a common error, its program, in `verification.distractors`.

        A mistake's `whyWrong` text isn't checked against its program. It's shown to the creator in review, but it isn't used as student feedback unless the creator accepts it.

     Since the distractors are computed values, the answer can never appear as a "wrong" option, and options can't duplicate one another.
   - **`true_false`:** the value must be a boolean. L7 adds the options `"True"` and `"False"`, and the matching one gets `isCorrect: true`.
   - **`numeric`:** `correctAnswer` is the value as a decimal string. Exact values get `numericTolerance: 0`. Floats get a default relative tolerance of 1e-6 (instance setting; the creator can change it per question).
   - **`short_answer`:** `correctAnswer` is the formatted value. It is graded per §7.
6. **Record** both programs, the value and the outcome in `verification` (§4), and a `QuestionEvent` of kind `answer_computed`.

**Flow B: imported or hand-edited question (answer checked)**

1. **Classify.** Imported questions are classified as computable or not by the `verify.solve` model. Hand-edited questions keep their classification. A creator who changes the answer on a computable question can't skip the check. They can only reclassify the question as not computable, with a required note, and that's recorded in its history.
2. **Blind program** from `verify.solve`, and a sandbox run. (There's no author program on this path.)
3. **Parse the options.** Each option and the `correctAnswer` are converted to values: plain numbers, fractions, LaTeX (`\frac`, `\sqrt`, `bmatrix`/`pmatrix` vectors and matrices, `^T`), and simple expressions such as `2n - 1`, using SymPy's LaTeX parsing plus our own handling for vectors and matrices.
4. **Compare and decide:**

| Outcome | Condition | Result |
|---|---|---|
| **Verified** | `result` equals exactly one option, and that option is the `correctAnswer` | **pass**, `verification.status = "computed"` |
| **Wrong answer** | `result` equals exactly one option, but it isn't the `correctAnswer` (sample Q7) | **fail** with a **suggested fix**. The creator confirms or rejects it; it's never applied automatically |
| **No match** | `result` equals no option | **fail**: the question, the options or the check is wrong |
| **Ambiguous** | `result` equals more than one option (e.g. `0.5` and `\frac{1}{2}`) | **fail**: duplicate options |
| **Couldn't check** | The program failed, timed out, or an option couldn't be parsed | **warn**, `status = "unverified"`; goes to human review |
| **Not computable** | `computable: false` | Optional: the solver model picks an option blind; disagreeing with the stated answer is a **warn** (`status = "model_agreed"` if it agrees). Never a pass by computation |

- In flow B, short-answer and numeric questions are checked the same way, comparing `result` with `correctAnswer` (and `acceptedAnswers`) instead of the options.
- The programs, their results and the outcome are stored with the question (`verification`, §4). Reviewers can read both programs. Students see them only on assignments released with `full_review` (§9.2).
- **Proctored publishing:** an instance setting (default **on**) blocks publishing a proctored test while any `computable` question is not `computed`-verified.

**The sandbox (`apps/verify`):** the one Python component. It's a small worker the API calls over HTTP or through a job queue.

- **Tool whitelist (v1, fixed):**

  | Module | Allowed | Used for |
  |---|---|---|
  | `sympy` | Core, `Matrix`, `Rational`, `sqrt`, `simplify`, `expand`, `factor`, `solve`, `diff`, `integrate`, `limit`, `summation`, `symbols` | Exact and symbolic math, linear algebra |
  | `numpy` | Array creation, arithmetic, `dot`, `matmul`, `linalg.norm` / `det` / `inv` / `solve` / `eig` / `rank` | Numeric linear algebra |
  | `fractions`, `math`, `statistics`, `itertools` | All public functions | Exact fractions, basic math, counting |

  Anything not on the list is rejected **before** running. Growing the list is a code change with review (§13).
- **Static check before running:** parse the program's AST and allow only whitelisted imports and attribute paths. No `open`, `exec`, `eval`, `__import__`, `getattr`, dunder access, `globals`, or file/OS/network modules. Size limit (e.g. ≤ 40 lines).
- **Run limits:** a separate process per run, CPU time limit (e.g. 5 s), memory limit (e.g. 256 MB), no network (the container runs with networking off), read-only filesystem, and a non-root user. `result` must be JSON-serializable after conversion (numbers, rationals as `"p/q"`, matrices as nested lists, SymPy expressions as `srepr` plus LaTeX).
- **Contract:** request and response schemas are Zod in `packages/shared`, with a generated JSON Schema / Pydantic model on the Python side.
- **Packaging:** its own container, with pinned versions of the whitelisted libraries. A failed run doesn't affect the API.

### 3A.4 Review UI (creator)

- Split view: question on the left, cited source passage(s) on the right with the quote highlighted, plus the L7 check program and its result.
- **Question history:** for any question, the full chain of versions (generated → regenerated → edited → fix accepted), with who/what made each change and why (creator note, failed check).
- Validation badges per question; filter by fail/warn/objective.
- **Coverage panel:** objectives × question counts compared with the blueprint targets, plus a **source heatmap** showing which chunks are tested (and by which questions) and which aren't.
- Inline editing. An edited question is re-validated locally right away, and the edit is recorded in its history.
- **Compare revisions:** a side-by-side view of two rounds, showing which questions were added, changed (with a text diff), rejected or locked.

---

## 3B. LLM layer (model-agnostic)

Every model call (authoring, judging, answer-verification checks, analysis, embeddings) goes through one **model-agnostic** layer. The spec never assumes a particular model or vendor. Anything the layer can reach plugs in the same way:

- **Self-hosted open-weight models** behind an OpenAI-compatible API: vLLM, llama.cpp `llama-server`, Ollama's `/v1`, LM Studio. The **reference local setup** is Qwen on a Proxmox box with an RTX 3060 12 GB.
- **Frontier cloud models**, through their own APIs.
- **Gateways** (e.g. LiteLLM, OpenRouter) that put many models behind one OpenAI-compatible API.

### 3B.1 Framework choice

**Recommendation: Vercel AI SDK (`ai` package)**, used only on the server.

- **One interface for cloud and local:** first-party provider packages for the major cloud APIs, plus `@ai-sdk/openai-compatible` for any OpenAI-compatible server (all the local servers above, and gateways). Switching a role from local Qwen to a cloud model is a configuration change, not a code change.
- **Zod-native:** `generateObject` / `streamObject` take our shared Zod schemas directly and return typed results.
- **Native features where they exist:** each cloud provider's own structured-output mode, prompt caching and so on. These go through `providerOptions`, so shared code never depends on them.
- **`embed` / `embedMany`** for the knowledge base (§3C) and L4/L5, with any provider.
- **Alternatives considered:**
  - **Plain `openai` SDK only:** simplest and most control for OpenAI-compatible servers, but cloud APIs that aren't OpenAI-compatible would need a gateway, and their native features would be lost.
  - **LangChain.js:** much broader, but heavier, and its typing is looser than we need.
  - **Mastra:** adds agents and workflows we don't need.
  - **Gateway only (LiteLLM in front of everything):** a valid deployment option on top of any of these, but not a replacement for a typed client.

The framework is wrapped in a thin **`packages/llm`** module that owns the app's own interface, so the framework itself could be swapped later:

```ts
// Sketch — app-level interface, framework- and model-agnostic
interface LlmRuntime {
  generateObject<T>(role: ModelRole, schema: ZodType<T>, input: PromptInput, opts?): Promise<LlmResult<T>>
  streamObject<T>(role: ModelRole, schema: ZodType<T>, input: PromptInput, opts?): AsyncIterable<Partial<T>> & { final: Promise<LlmResult<T>> }
  embed(texts: string[]): Promise<number[][]>          // uses the "embeddings" role
}
type ModelRole = "authoring.objectives" | "authoring.generate" | "authoring.judge" | "verify.solve"
               | "analysis" | "embeddings"
LlmResult<T> = { value: T; endpointId; model; finishReason; usage; repairAttempts; latencyMs }
```

### 3B.2 Endpoints & roles

An admin sets up one or more **endpoints**, then assigns each **role** an endpoint + model. Roles can share an endpoint or use different ones. For example: everything on local Qwen; or generation local and the judge on a cloud model; or embeddings on a separate small server.

```ts
Endpoint = z.object({
  id: z.string(),
  label: z.string(),                          // "Qwen on proxmox", "Cloud model X"
  provider: z.string(),                       // "openai-compatible" (default) or any registered provider adapter
  baseUrl: z.string().url().optional(),       // required for openai-compatible, e.g. http://10.0.0.20:8000/v1
  apiKeyRef: z.string().optional(),           // optional; stored encrypted
  location: z.enum(["local", "cloud"]),       // drives privacy notices and the local-only setting
  server: z.enum(["vllm", "llamacpp", "ollama", "lmstudio", "gateway", "other"]).optional(),  // openai-compatible quirks
  concurrency: z.number().int().default(1),   // single consumer GPU: 1–2; cloud: higher, within rate limits
  timeoutMs: z.number().int().default(300_000),
})

RoleAssignment = z.object({
  role: ModelRole,
  endpointId: z.string(),
  model: z.string(),                          // whatever id the endpoint expects, e.g. "Qwen/Qwen3-14B-AWQ"
  capabilities: z.object({
    structuredOutput: z.enum(["native_schema", "prompt_only"]),
    contextWindow: z.number().int(),          // the context we budget against (for local: what the server was launched with)
    maxOutputTokens: z.number().int(),
  }),
  params: z.record(z.unknown()).optional(),   // sampling settings + provider-specific options
})
```

- **Model discovery:** where the endpoint supports it (e.g. `/v1/models`), the admin UI lists the available models.
- **Probe/test button:** sends a small structured-output request and an embeddings request, and reports latency, whether the schema was respected, and the context size where reported. This helps fill in `capabilities` and catches a wrong `baseUrl` or key.
- **Per-endpoint queue:** requests to an endpoint are limited to its `concurrency`, with a fair queue across users. That protects a single local GPU from being flooded, and keeps cloud usage within rate limits.
- **Reference setups in the docs:**
  - **Local, 12 GB GPU:** Qwen via vLLM or llama.cpp, ~8B at 8-bit or ~14B at 4-bit (AWQ/GGUF Q4), with context capped around 16–32K so the KV cache fits in VRAM, plus a small embedding model. Known quirk: Ollama's default context window is small and longer prompts are silently cut off. Its context size has to be set on the server side.
  - **Cloud:** any frontier model with native structured output. Larger batches and whole-section context are fine.

  These are documented as starting points, not guarantees.
- **Privacy:** an instance setting **"local endpoints only"** stops source material and student data from ever reaching a `cloud` endpoint. When a role uses a cloud endpoint, the UI shows a notice naming it.
- **Secrets:** keys are stored encrypted at rest (key from env) and never returned by the API after they're saved.
- **SSRF guard:** only admins can create or edit endpoints. Users never enter URLs or keys.

### 3B.3 Getting valid structured output from any model

Each role's `structuredOutput` capability picks one of two methods. `native_schema` is the default and works on all the local servers above and on cloud APIs with structured outputs; `prompt_only` is the fallback for anything else:

| `structuredOutput` | Typical backends | Mechanism |
|---|---|---|
| `native_schema` | Cloud APIs with structured outputs; vLLM (guided decoding), llama.cpp (`json_schema` → grammar), Ollama, LM Studio | The JSON Schema is sent and decoding is constrained to it. **Default.** |
| `prompt_only` | Anything else | Schema + example in the prompt. Normalization (§3D.2) extracts the JSON from the text |

Whatever the mode, the response then goes through the **repair loop**:

1. **Normalize** (§3D.2), then validate with the Zod schema (L1). Fixes from normalization are recorded but don't count as repairs.
2. If that fails: re-ask once or twice, including the Zod error messages, the invalid output and the schema (`maxRepairs`, default 2).
3. Still failing: handle **per item** where possible. Valid questions from the batch are kept, invalid ones are marked as failed, and the whole batch is only failed if nothing can be salvaged.
4. Record `repairAttempts` and the mode used, so each role's reliability can be monitored.

The shared Zod schemas are written for the **weakest supported model**, not the strongest. Rules: no recursive types; avoid `anyOf` where possible (it's why the generation schema uses flat optional fields rather than a discriminated union); keep enums small; give every field a `.describe()` (it goes into the JSON Schema and helps prompt-only models).

`verify.solve` is a good place for a **math-tuned model** (e.g. a math variant of an open-weight model, or a model with thinking turned on). It only writes the check program; the arithmetic is always done by the sandbox.

**Model-specific settings** live in `RoleAssignment.params`, never in shared code. Example: Qwen3's "thinking" mode should normally be off for structured-output roles, so reasoning text doesn't leak into the JSON.

### 3B.4 Prompts & evals

- Prompts are versioned templates in `packages/llm/prompts`, one per role. Until that package exists, drafts are iterated in `docs/prompts/` together with their probe results (e.g. [`authoring-generate.md`](prompts/authoring-generate.md)). Each `LlmResult` and saved report records the prompt version.
- **Call logging:** every call records metadata (endpoint, model, prompt version, tokens, repairs, latency). For **authoring and `verify.solve` calls, the full request and response are stored as well**, so any question's origin can be reproduced exactly (provenance, §3A.1). Analysis calls, which carry student data, store metadata only.
- One default prompt per role, written to work on small models (short, explicit, one example), which also works on large models. The mechanism for **per-model variants** exists, but none ship in v1; one is added only when evals show it's needed.
- A small **eval set** (fixed sources plus expected properties: grounding pass rate, single-correct-answer rate, coverage, repair rate, seconds per question) is run against each role's model. That makes model choices ("is local 8B enough?", "is the cloud judge worth it?") measured answers instead of guesses.

---

## 3C. Source material & knowledge base

Creators bring source material in themselves, as **Markdown or plain text**. gem-proctor doesn't extract text from PDFs, DOCX or scans. Converting and cleaning up is the creator's job, done with whatever tool they like.

Every source is ingested **once** into a **knowledge base**: chunks of text, each with its embedding vector, a full-text index and full provenance, stored in Postgres with pgvector. After ingest, nothing reads the original file again. Authoring retrieves chunks from the knowledge base, and every citation points to a knowledge-base chunk.

### 3C.1 Adding a source

- **Paste** into an editor, or **upload** `.md` / `.txt` (size limit configurable, e.g. 5 MB).
- **Metadata** (creator-entered): title, short citation label (e.g. "VMLS"), optional author/edition/URL. The label is used when showing citations and fills `course` on generated quizzes (§2.3).
- **Math:** `$...$` / `$$...$$` LaTeX is preserved exactly as written and rendered with KaTeX. Plain-ASCII math (`x^T y`) is left as it is.
- **Preview:** shows the rendered Markdown and the detected section tree before saving, with warnings for problems such as no headings, very long sections, or duplicate heading names.

### 3C.2 Ingest (our server)

```
source.md ─▶ parse headings (remark) ─▶ sections ─▶ chunks ─┬─▶ embedding model (embeddings role) ─▶ vector
                                                            └─▶ Postgres: chunk text + vector + tsvector + provenance
```

- **Sections come from Markdown headings.** `#` → chapter, `##` → section, and so on. Plain text with no headings is treated as one section and split by paragraph.
- **Chunks** are split within a section, paragraph-aware, with a target token size and small overlap. They're never split inside a code block, table or `$$` math block.
- **Every chunk is a provenance record:**

  | Field | Example |
  |---|---|
  | `chunkKey` (stable id) | `vmls:ch1:s1.4:c3` |
  | Source + source revision | VMLS, revision 2 |
  | Heading path | Ch. 1 › §1.4 Inner product |
  | Character offsets in the revision's Markdown | 1200–1480 |
  | Content hash | `sha256:…` |
  | Text | the chunk itself |
  | Embedding + embedding model id | `vector(N)`, `bge-m3@…` |
  | Full-text index | `tsvector` |

- **Chunks are immutable.** Editing a source creates a new revision with new chunks. Old chunks are kept, so published tests' citations always resolve.
- **Embedding runs as a background job** (§11.2), batched to suit the embedding endpoint's `concurrency`. A source is usable for authoring once all its chunks are embedded.
- The `embeddings` role is **required** for authoring. A small embedding model on the same box as the generation model is enough.

### 3C.3 Retrieval (our server) and how it works with the model

The knowledge base belongs to **our server**. The models never access it:
- the **embedding model** turns text into vectors (chunks at ingest, queries at retrieval time);
- the **generation model** only reads the chunk text we put in its prompt, and cites chunk ids back.

```
objective "inner product", scope = ch. 1
  [server] ─▶ embedding model: query text ─▶ query vector
  [server] ─▶ Postgres: filter to scope (source revision + sections) ─▶ hybrid rank ─▶ top chunks (text + ids)
  [server] ─▶ generation model: instructions + chunks tagged with ids
  model    ─▶ questions citing { chunkId, quote }
  [server] ─▶ Postgres: load the cited chunk, check the quote is in its text (L2), record provenance
```

- **Scope first, then rank.** The scope filter (sources, revisions, sections) always comes before ranking, so retrieval can never pull material from outside the selected chapters.
- **Hybrid ranking:** pgvector similarity (semantic) combined with Postgres full-text search (exact terms and notation like `x^T y`, which embeddings handle poorly), merged with reciprocal-rank fusion.
- **Across sources:** if several sources are in scope, an objective can draw chunks from all of them. Every citation still names its own source.
- **Recorded per call:** the retrieval query, the chunk ids sent and their ranks are stored with the revision. That's what lets us show exactly what the model was given for any question (§3A.1 provenance).
- **Gaps are visible:** L5 / the heatmap list in-scope chunks that no question cites, so anything retrieval missed shows up.
- **Not in v1:** letting the generation model run its own searches through a tool. Code-driven retrieval is deterministic and auditable, and small models are unreliable at multi-step tool use.

### 3C.4 Scope picker & citations

- **Scope picker:** a checkbox tree built from the headings. It shows a **token estimate** for the selection and whether it fits each assigned role's context window (§3B.2).
- **Objectives come from the headings.** By default, each selected section produces a starting set of learning objectives (step 2 of §3A.1), so coverage follows the material's own organization. They also fill `topics_covered` (§2.3).
- **Citations** show as "VMLS §1.4 (rev 2)", linking to the highlighted passage in the source viewer.

### 3C.5 Editing & versioning

- Sources can be edited in the app or replaced by re-uploading. Each save creates a new `SourceRevision`, which is re-chunked and re-embedded. Chunks whose content hash didn't change reuse their stored vectors.
- Published `TestVersion`s keep pointing at the chunks they were made from, so evidence never silently changes underneath a published test. Draft authoring sessions show a "source changed" banner with a re-validate action, which re-runs L2 grounding against the new revision.
- **Changing the embedding model** means re-embedding the whole knowledge base, run as a background job. Vectors from different models are never compared.
- **Privacy:** sources are private to their owner by default. Only the retrieved chunks are sent, and only to the admin-configured endpoints (§3B). With "local endpoints only" on, nothing leaves your infrastructure.

---

## 3D. Quiz JSON import & normalization

Import is secondary: most quizzes are generated in the app (§3A). There is **exactly one import format, the `Quiz` JSON (§4)**. It's the same format the app exports, so a quiz can be backed up, moved between instances, or written by hand. A Result file (§2.2) can also be imported: it's a valid quiz with extra fields, and the attempt data is ignored. Attempts themselves are never imported.

### 3D.1 Pipeline

```
.json / pasted text ─▶ normalize (§3D.2) ─▶ Zod validate (Quiz) ─▶ verify answers (L7) ─▶ report + preview/edit ─▶ save as TestVersion
```

1. **Input:** upload a `.json` file or paste text (size limit configurable, default 2 MB).
2. **Normalize:** lenient clean-up (§3D.2). Every fix is recorded.
3. **Validate** against `Quiz` (§4), including the cross-field checks.
4. **Verify answers** (L7, §3A.3.1) for computable questions, **including questions that failed step 3** because their answer isn't among the options. That's how a wrong answer gets a suggested fix for the creator to confirm (sample Q7, §2.4).
5. **Report:** errors (block saving), warnings (e.g. recomputed `total_questions`), the list of fixes from normalization, and verification results with any suggested fixes.
6. **Preview & edit:** fix anything flagged before saving.
7. **Save:** creates a `Test` and an immutable `TestVersion`. The original text is kept for debugging.

### 3D.2 Normalization ("massaging")

Model-produced JSON is often almost right: wrapped in prose, with a renamed key or a choice given as a letter. `normalizeQuiz(text) → { value, fixes[] }` is a pure function in `packages/shared`. It runs **before** Zod validation in two places:

- **Import** (§3D.1), e.g. for a quiz a model wrote outside the app.
- **The LLM repair loop** (§3B.3), so many malformed generations are fixed locally, without asking the model again. There, only the JSON-level fixes apply (extraction, syntax, truncation, number coercion, key aliases for that schema). The quiz-specific fixes (answer resolution, renumbering, totals) are only for `Quiz` input.

It only fixes **formatting**, never content:

| Problem | Fix |
|---|---|
| JSON wrapped in prose or Markdown code fences; `<think>` blocks | Strip them and take the first complete JSON object/array |
| Small syntax errors (trailing commas, single quotes, smart quotes, unquoted keys, comments) | Tolerant parse (JSON5-style) |
| Truncated output (cut off by the length limit) | Keep the complete questions and drop the partial last one. **Warn** |
| A bare array of questions | Wrap it in a quiz. The title comes from the input or the session |
| Key-name variants (`quizTitle`, `title`, `question_number`, `questionNumber`, `correct_answer`, `answer`, `choices`, `answers`, `topicsCovered`, …) | Map them to the base names via a fixed alias table |
| Numbers as strings (`"3"`) | Coerce |
| Answer given as a letter/index (`"B"`, `1`) or with a prefix (`"B) 2n − 1"`) | Resolve it to the matching option text. Strip `A)`, `a.`, `(c)` prefixes from options |
| Answer that matches an option except for case, whitespace or LaTeX spacing | Snap it to that option. Never across different values: `"1"` vs `"-1"` stays an error (§2.4) |
| Missing or duplicate question `id` | Renumber 1..n in order. **Warn** |
| Wrong or missing `total_questions` | Recompute |
| `type` missing or inconsistent with `options` | Infer it (§4) |

What it never does: invent missing options or answers, pick between two plausible option matches, or change question text. Those stay **errors** for the creator (on import) or for the repair loop (during generation) to deal with.

---

## 4. Extended schema (shared Zod)

Defined in `packages/shared`. The **base schemas mirror §2 exactly**. The extended schemas use `.extend()` with **optional** fields only, so base files always parse. The API contract, import/export, the generation mapper and the published JSON Schema all come from these Zod models.

```ts
// Sketch — base field names are fixed; new fields are camelCase and optional.

// ── Base (exactly §2.1) ────────────────────────────────────────────
BaseQuestion = z.object({
  id: z.number().int().positive(),
  topic: z.string(),
  question: z.string(),
  options: z.array(z.string()).min(2).optional(),   // present on choice questions
  correctAnswer: z.string(),                        // choice questions: exactly one of `options`
})
BaseQuiz = z.object({
  quiz_title: z.string(),
  course: z.string().optional(),
  chapter: z.number().int().optional(),
  total_questions: z.number().int(),
  topics_covered: z.array(z.string()).optional(),
  questions: z.array(BaseQuestion).min(1),
})

// ── Extensions ─────────────────────────────────────────────────────
QuestionType = z.enum(["short_answer", "single_choice", "multi_choice", "numeric", "true_false"])

Question = BaseQuestion.extend({
  type: QuestionType.optional(),                 // inferred if absent: options → single_choice, else short_answer
  correctAnswers: z.array(z.string()).optional(),// multi_choice only; correctAnswer = first, for base compatibility
  acceptedAnswers: z.array(z.string()).optional(),// short_answer alternatives besides correctAnswer
  caseSensitive: z.boolean().optional(),
  numericTolerance: z.number().optional(),       // numeric: correctAnswer parsed as a number
  explanation: z.string().optional(),
  points: z.number().positive().optional(),      // default 1
  objectiveIds: z.array(z.string()).optional(),
  evidence: z.array(z.object({ sourceId: z.string(), chunkId: z.string(), quote: z.string() })).optional(),
  provenance: z.enum(["llm", "human", "imported", "llm_edited"]).optional(),
  computable: z.boolean().optional(),
  verification: z.object({
    status: z.enum(["computed", "model_agreed", "unverified", "failed"]),
    answerSource: z.enum(["computed", "stated"]).optional(), // computed: answer came from flow A; stated: checked by flow B
    program: z.string().optional(),              // the blind check program (Python, whitelisted tools)
    authorProgram: z.string().optional(),        // flow A only: the generator's answerProgram
    modelClaim: z.string().optional(),           // flow A only: an answer the model marked or stated, if it differed from the computed one
    inputs: z.record(z.string()).optional(),     // flow A: each input's value (LaTeX), as rendered into the question
    seed: z.string().optional(),                 // flow A: the seed for input sampling, distractors and option order
    distractors: z.array(z.object({              // flow A single_choice only: how each wrong option was built
      text: z.string(), source: z.enum(["common", "near", "random"]), reason: z.string(), program: z.string().optional(),
    })).optional(),
    result: z.string().optional(),               // serialized value (LaTeX)
    matchedOption: z.string().optional(),
    checkedAt: z.string().datetime().optional(),
  }).optional(),
})

Quiz = BaseQuiz.extend({
  questions: z.array(Question).min(1),
  chapters: z.array(z.number().int()).optional(),// multi-chapter scope; `chapter` set only when exactly one
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  testType: z.enum(["chapter_quiz", "homework", "unit_test", "midterm", "final", "custom"]).optional(),
  formatVersion: z.literal(1).optional(),
})

// ── Result (§2.2): same quiz + one attempt ─────────────────────────
AnsweredQuestion = Question.extend({
  userAnswer: z.string(),                        // for multi_choice: answers joined, plus userAnswers[]
  userAnswers: z.array(z.string()).optional(),
  userIsCorrect: z.boolean(),
  pointsAwarded: z.number().optional(),
  needsReview: z.boolean().optional(),
  graderComment: z.string().optional(),
})

Result = Quiz.extend({
  questions: z.array(AnsweredQuestion).min(1),
  score: z.number(),
  percentage: z.number(),
  maxScore: z.number().optional(),               // when points ≠ 1; score is then points earned
  attemptId: z.string().optional(),
  mode: z.enum(["practice", "proctored"]).optional(),
  startedAt: z.string().datetime().optional(),
  submittedAt: z.string().datetime().optional(),
})
```

Cross-field checks (`superRefine`):
- Question `id` values are unique.
- If `options` is present, `correctAnswer` (and every `correctAnswers` entry) must **exactly** equal one of them, and options must be unique. (Sample Q7, §2.4, fails this check.)
- `single_choice` / `multi_choice` / `true_false` require `options` (`true_false` exactly `["True", "False"]`). `short_answer` / `numeric` must not have them.
- If both `chapter` and `chapters` are present, `chapters` must be `[chapter]`.
- `single_choice` has exactly one correct answer, `multi_choice` at least one.
- `numeric` needs a `correctAnswer` that parses as a number.
- `total_questions` (and, on results, `score` / `percentage`) must match the recomputed values; otherwise a warning on import, and the recomputed values are used.

---

## 5. Roles, authorization & accounts

The instance is **single-tenant**: one deployment, one organization.

### 5.1 Roles

Three roles, in a hierarchy. Each role inherits everything the role below it can do:

| Role | Can | Inherits |
|---|---|---|
| **Student** | Join groups with a join code. Take proctored assignments given to their groups (once each). Practise test versions their proctors made available to their groups (unlimited). See their own attempts and released results. Run attempt analysis where allowed (§8.2). **Cannot create, generate or import tests.** | — |
| **Proctor** | Everything a student can, plus: manage **their own** sources, authoring sessions, imports and tests; practise their own tests; manage their own groups and join codes; assign tests and make them available for practice to their groups; review, override and release; cohort view and analysis; CSV export. | Student |
| **Admin** | Everything a proctor can, on **all** resources, plus: users and role grants, LLM endpoints and role assignments (§3B.2), instance settings (e.g. "local endpoints only", the publish gate for unverified questions, self-registration). | Proctor |

- **Self-learner (autodidact):** someone running gem-proctor for themselves is simply an **admin**. They can generate tests from their own curriculum, practise them, and run the platform. No separate role is needed. (On a shared instance, a self-learner who shouldn't administer the platform is a **proctor** with no groups.)
- **Getting roles:** new accounts are students. Admins grant proctor or admin. On first start, the **first account created is made admin** (or an admin is seeded from env).
- Proctors only see resources they own (and students in their groups). Admins see everything.

### 5.2 Authorization with Casbin

Authorization is enforced with **Casbin** (`casbin` npm package): RBAC with a role hierarchy, plus **ownership and membership conditions**.

```ini
# Sketch — model.conf
[request_definition]
r = sub, obj, act                # sub: { id, roles }, obj: { type, ownerId?, groupIds? }, act: "read" | "create" | "update" | ...

[policy_definition]
p = sub, objType, act, cond      # cond: any | owner | member

[role_definition]
g = _, _                         # user → role, and role → role (student < proctor < admin)

[policy_effect]
e = some(where (p.eft == allow))

[matchers]
m = g(r.sub.id, p.sub) && (p.objType == "*" || r.obj.type == p.objType) && (p.act == "*" || r.act == p.act) \
    && (p.cond == "any" \
        || (p.cond == "owner"  && r.obj.ownerId == r.sub.id) \
        || (p.cond == "member" && isMember(r.sub.id, r.obj.groupIds)))
```

```csv
# Sketch — policy.csv (excerpt)
p, student, assignment,    take,    member
p, student, practice_test, take,    member
p, proctor, source,        create,  any
p, proctor, source,        update,  owner
p, proctor, test,          assign,  owner
p, proctor, submission,    review,  owner
p, admin,   *,             *,       any
g, proctor, student
g, admin,   proctor
```

- **Where things live:** the **policy** (`p` lines and role inheritance) is a file in the repo (`packages/authz`), changed only by code review. **User → role grants** (`g, <userId>, proctor`) are stored in Postgres through a Casbin adapter, managed by admins in the UI.
- **Enforcement:** every Fastify route declares its `{ objType, act }`. A `preHandler` hook loads the resource's owner or groups and calls the enforcer. A route without a declaration fails a startup check, so nothing is accidentally left public.
- **Caching:** Casbin's cached enforcer keeps decisions in memory, and the cache is cleared whenever role grants change.
- Casbin decides **who may do what**. **What data is returned** is still decided by the DTOs: e.g. `QuestionForStudent` never contains answers (§9.4), whatever the policy says.

### 5.3 Accounts & sessions

- **Passwords:** hashed with **bcrypt** (cost ≥ 12, via `Bun.password` with the bcrypt algorithm, or `bcryptjs`). Inputs longer than bcrypt's 72-byte limit are rejected rather than silently truncated.
- **Sessions:** a random session id in an httpOnly, `SameSite=Lax`, `Secure` cookie. Session rows are stored in Postgres, with an **in-memory cache** in front of them (short TTL, e.g. 60 s), so most requests don't hit the database for auth. Logout and role changes clear the cached entry.
- **Single API instance assumed** for these in-memory caches. Running several API instances later would need cache invalidation across them (e.g. Postgres `LISTEN/NOTIFY`).
- `@fastify/rate-limit` on login/registration and model-calling endpoints. Account lockout after repeated failed logins.
- **Registration:** self-registration can be turned on or off (instance setting). Students then join groups with a **join code** (v1; no email invites, so no mail server).
- Magic links, OAuth and email-based password reset can come later (password reset by an admin in v1).

---

## 6. Practice mode

- **Unlimited attempts** on any test the user owns (proctors/admins), or that a proctor made available for practice to one of the user's groups (students).
- **Every attempt:**
  - Questions and options are **shuffled** (always on; the shuffle seed is stored with the attempt).
  - **Immediate feedback** after each question: correct/incorrect, the correct answer, and the explanation. There's no setting; proctored mode is always end-only (§9).
  - **Soft timer:** shows elapsed time, never ends the attempt. Time per question is recorded.
- **Starting an attempt:** "Take test" (all questions) or "Retake missed" (only questions answered wrong in the most recent attempt).
- **During the attempt:** progress indicator, flag-for-review, navigate between questions, autosave (so a refresh resumes the attempt).
- **Results screen:** score, time taken, per-question review (your answer vs. correct answer, explanation, cited source passage), a per-topic breakdown (by question `topic`, grouped under `topics_covered`), and "Retake" / "Retake missed" / "Analyze with AI".
- **Self-graded override:** on a short-answer question marked wrong, "I was right" changes the score for that attempt. It's recorded as self-graded and shown as such.
- **Export** any attempt as a `Result` file (§2.2 / §4).
- **History:** the list of all attempts per test with score, date and duration. (No trend chart in v1.)
- Practice attempts are **private to the user**. Proctors never see them.
- Correct answers are sent to the client in practice mode, so immediate feedback doesn't need a round trip per question.
- **Making a version available for practice reveals its answer key** to those students (immediate feedback). If the same version is used, or later assigned, in an `outcome_only` assignment, the UI warns the proctor, and the assignment dashboard shows it.

---

## 7. Grading

### 7.1 Auto-grading (server-side, authoritative)

- `single_choice` / `true_false`: `userAnswer` equals `correctAnswer`. `multi_choice`: the set of `userAnswers` equals the set of `correctAnswers`. Partial credit for `multi_choice` is configurable per question: `all_or_nothing` (default) or `proportional`.
- `numeric`: `|given − correctAnswer| ≤ numericTolerance` (default 0).
- `short_answer`: compare after normalization (§7.2) against `correctAnswer` and each `acceptedAnswers` value.

### 7.2 Short-answer normalization

Needed because answers look like `[4, 2, 3]^T` or `2n - 1 flops`:

- trim, collapse whitespace, fold case (unless `caseSensitive`)
- strip whitespace around `[ ] , ( ) ^ _ + - * /`
- unicode normalize (NFKC), unify minus signs and quotes
- optionally strip trailing units/words listed in an ignore list (e.g. "flops")

Anything that doesn't match exactly is flagged **`needs_review`** in proctored mode. In practice mode it is marked incorrect, and the user gets a "I was right" self-override that changes their score but is recorded as self-graded.

### 7.3 Manual grading (proctored)

The proctor can override any question's points and add a comment. Overrides are audited (who, when, from → to).

---

## 8. AI analysis (optional)

### 8.1 Model

- Analysis uses the `analysis` role (§3B.2): any local or cloud model the admin assigns.
- Keys are only ever configured by an admin on endpoints (§3B.2). Users never supply or see API keys.
- If no `analysis` role is assigned, AI features are hidden or disabled with an explanation. Nothing else depends on AI.

### 8.2 Analyses

Two analyses in v1, both run by the model assigned to the `analysis` role:

| Analysis | Who | Input | Output (Zod-typed via the LLM layer) |
|---|---|---|---|
| **Attempt analysis** | Anyone on their own practice attempts, or a student after release on `full_review` assignments only (it would reveal the answer key otherwise) | One attempt: questions, answers, correctness, topics, time per question | Strengths, weak topics, likely misconception behind each wrong answer, a short study plan pointing at the cited source sections |
| **Cohort analysis** | Proctor | All graded submissions for an assignment | Topic gaps across the class, the misconception behind the most common wrong answers, suggested re-teaching focus |

- **Cohort numbers are computed, not generated.** Per-question % correct, the most-chosen wrong option per question, per-topic accuracy and the score distribution are calculated in code. The model only gets those aggregates, plus the questions and the most common wrong answers, and writes the interpretation. Its output can't contradict the numbers, because the numbers are shown next to it straight from the database.
- **Attempt analysis** is a button on the results screen. **Cohort analysis** is a button on the cohort view (§9.5), available once the assignment has submissions.

- Response schemas are Zod. Enforcement and the repair loop follow §3B.3.
- Results are saved (`AnalysisReport`) so they can be viewed again without calling the model a second time. The record stores the endpoint, model and prompt version.
- Privacy: student answers only go to the endpoint assigned to `analysis`. For a cloud endpoint, show a consent notice naming it. Cohort analysis sends no student identities at all, only aggregates and anonymous answer counts.

---

## 9. Proctored mode

### 9.1 Concepts

- **TestVersion** — immutable snapshot. Assignments always point to a version, so editing a test never changes an exam that's already been assigned.
- **Group** — a proctor-owned roster of students. A proctor can have **any number of groups** (e.g. one per class section). Each group has its own join code, which the proctor can regenerate. A one-off student is simply a group of one.
- **Assignment** — `TestVersion` + one or more **groups** + rules. The same test version can be assigned any number of times, to any groups (reuse).
- **Submission** — one student's single attempt at an assignment.

### 9.2 Assignment rules (set by the proctor)

- Availability window: `opensAt`, `closesAt`. Closing is final: in-progress submissions are auto-submitted at `closesAt`, and there are no late submissions.
- Time limit (optional, **enforced server-side**; it auto-submits at expiry). Per-student **extended-time accommodations** (multiplier) can be set by the proctor (§1.3). Students get warnings at 5 minutes and 1 minute remaining.
- Questions and options are shuffled per student (always on; seed stored with the submission).
- Feedback policy: always `end`-only for students (no per-question feedback).
- **Results release:** a single **"Release results"** action by the proctor, typically after reviewing flagged answers. Nothing is released automatically.
- **What students see on release** (set per assignment, `resultVisibility`):
  - `outcome_only` (**default**): score, plus which questions they got right or wrong. Correct answers, explanations and check programs are never sent, so the test stays safe to reuse with later groups.
  - `full_review`: their answers next to the correct answers, explanations and cited source passages. Good for homework and chapter quizzes that won't be reused.

  The proctor can change it until results are released. Reusing a test version is always possible either way; the setting only decides whether its answer key reaches students.

### 9.3 One attempt, enforced

- DB unique constraint on `(assignmentId, studentId)` for `Submission`.
- Lifecycle: `not_started → in_progress → submitted → (needs_review) → graded → released`.
- Starting creates the submission and stamps `startedAt`. If the student leaves, they can **resume** the same in-progress submission (same deadline) but can't restart it.
- The proctor can **reset** a submission (e.g. after a technical failure). This is audited, and the old submission is archived, not deleted.

### 9.4 Answer secrecy

- In proctored mode, the API **never sends correct answers or explanations** to the student client: not before release, and with `outcome_only`, not after release either. Separate DTOs (`QuestionForStudent`) leave those fields out, so the types guarantee it.
- Grading happens only on the server.

### 9.5 Proctor views

- Assignment dashboard: who hasn't started / is in progress / has submitted, plus score distribution.
- Review queue: `needs_review` answers grouped by question (grade all similar answers at once).
- Per-student submission view with overrides and comments.
- **Cohort view:** per-question % correct, wrong-option counts, per-topic accuracy and the score distribution (computed), plus the optional cohort analysis (§8.2) next to them.
- Export grades as CSV.

---

## 10. Data model (logical)

Entities only. The ORM schema will be written at build time.

```
User(id, email, passwordHash, displayName, createdAt)
UserSession(id, userId, createdAt, expiresAt, lastSeenAt, userAgent?)
casbin_rule(ptype, v0, v1, v2, v3, v4, v5)               // Casbin adapter table: user → role grants (g lines)
InstanceSettings(key, value JSON, updatedBy, updatedAt)
Group(id, proctorId, name, joinCode)
GroupMember(groupId, userId, joinedAt)

Source(id, ownerId, title, citationLabel, author?, edition?, url?, visibility, createdAt)
SourceRevision(id, sourceId, number, markdown TEXT, contentHash, createdBy, createdAt)
SourceSection(id, revisionId, parentId?, level, title, slug, order)
SourceChunk(id, revisionId, sectionId, chunkKey, charStart, charEnd, contentHash, text, tokenCount,
            embedding vector(N)?, embeddingModel?, tsv tsvector)   // chunkKey e.g. "vmls:ch1:s1.4:c3"; immutable
RetrievalLog(id, revisionId (authoring), objectiveId?, query, scope JSON, results JSON (chunkId, rank, score), embeddingModel, at)
AuthoringSession(id, ownerId, title, status, model, testType, blueprint JSON, createdAt)
AuthoringSessionSource(sessionId, sourceId)
Objective(id, sessionId, label, description, evidence JSON, origin: llm|human)
Revision(id, sessionId, number, trigger: generate|revise, request JSON, usage JSON, createdAt)
DraftQuestion(id, sessionId, revisionId, tempId, content JSON (generation schema), status: proposed|accepted|rejected|locked,
              creatorNote?, supersedesId?, editedBy?, editedAt?)
QuestionEvent(id, draftQuestionId, kind: generated|regenerated|edited|accepted|rejected|locked|fix_accepted|answer_computed|reclassified, actorId?, revisionId?, before JSON?, after JSON?, note?, at)   // provenance trail
ValidationResult(id, draftQuestionId, layer, outcome: pass|warn|fail, detail JSON)
Test(id, ownerId, title, description, tags[], createdAt, archivedAt?, authoringSessionId?)
TestVersion(id, testId, versionNumber, content JSON (extended Quiz, §4), provenance JSON (frozen trail, §3A.1), publishedAt?, createdAt)
TestImportRecord(id, testVersionId, originalFilename?, sourceRaw TEXT, report JSON)   // report includes normalization fixes
PracticeAvailability(testVersionId, groupId, addedBy, addedAt)   // test versions students in a group may practise

PracticeAttempt(id, userId, testVersionId, kind: full|retake_missed, shuffleSeed, startedAt, submittedAt?, durationMs?, score, maxScore)
Assignment(id, proctorId, testVersionId, title, rules JSON, resultVisibility: outcome_only|full_review, opensAt, closesAt, releasedAt?)
AssignmentGroup(assignmentId, groupId)
Submission(id, assignmentId, studentId, status, shuffleSeed, startedAt, deadlineAt?, submittedAt?, score?, maxScore, archivedAt?,
           UNIQUE(assignmentId, studentId) where not archived)

Response(id, attemptId | submissionId, questionId (int, §2.3), answer JSON, autoResult, pointsAwarded, needsReview, selfGraded, flagged, answeredAt, timeSpentMs)
GradeOverride(id, responseId, proctorId, fromPoints, toPoints, comment, createdAt)
AnalysisReport(id, ownerId, kind, subjectRef, endpointId, model, promptVersion, result JSON, createdAt)
Endpoint(id, label, provider, baseUrl?, apiKeyCiphertext?, location, server?, concurrency, timeoutMs, createdBy)
RoleAssignment(role, endpointId, model, capabilities JSON, params JSON)
VerificationRun(id, testVersionId? | draftQuestionId?, questionId, programKind: author|blind, program TEXT, status, result JSON, matchedOption?, durationMs, sandboxVersion, at)
LlmCallLog(id, endpointId, model, role, promptVersion, mode, finishReason, repairAttempts, usage JSON, latencyMs, at,
           requestBody JSON?, responseBody JSON?)   // bodies stored for authoring + verify.solve calls (provenance); metadata only for analysis
AuditLog(id, actorId, action, targetType, targetId, before JSON?, after JSON?, ip?, userAgent?, at)   // append-only; app DB user has INSERT/SELECT only
Accommodation(assignmentId, studentId, timeMultiplier, note?, grantedBy, grantedAt)
```

Notes (Postgres):
- `jsonb` columns hold the quiz content (§4) and flexible configs. They are validated with Zod at the boundaries.
- `SourceChunk.embedding` is a pgvector column with an **HNSW** index (cosine). `tsv` is a generated `tsvector` with a **GIN** index. The vector dimension is fixed by the embedding model; changing models means migrating the column and re-embedding.
- Enum-like fields use Postgres enums or `text` + check constraints, mirrored by Zod enums.
- `TestVersion.content` is the source of truth for questions. Responses refer to `questionId` within that version.

---

## 11. Tech stack & architecture

### 11.0 Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Language | **TypeScript** (`strict`) | Everywhere except the verification sandbox |
| Runtime & package manager | **Bun** | Runs the API and scripts, `bun install` + Bun workspaces for the monorepo, `bun test` for unit tests |
| Backend | **Fastify** + `fastify-type-provider-zod` | Request/response validated and typed from the shared Zod schemas. Logging via Fastify's built-in pino |
| Frontend | **React** + **Vite** | TanStack Query, TanStack Router (or React Router), react-hook-form + zod resolver, react-markdown + **KaTeX** (HTML + MathML output), **React Aria** components |
| i18n | **i18next / react-i18next** | English catalogs in v1. API returns error codes, not text (§1.3) |
| Schemas / type safety | **Zod** | Single source of truth in `packages/shared`. JSON Schema generated from it for the LLM layer and the Python sandbox |
| Database | **Postgres** + **pgvector** | App data + knowledge base (vectors with HNSW index, full-text search with GIN index) |
| ORM / migrations | **Drizzle ORM** + drizzle-kit + drizzle-zod | Native pgvector column type and distance functions; see §11.4 |
| Authorization | **Casbin** (`casbin`) | RBAC + ownership/membership conditions; policy in repo, role grants in Postgres; cached enforcer (§5.2) |
| Auth | **bcrypt** + Postgres sessions | `Bun.password` (bcrypt) or `bcryptjs`; in-memory session cache (§5.3) |
| Background jobs | **pg-boss** | Postgres-backed queue (no Redis): embedding, generation batches, verification runs |
| LLM access | **Vercel AI SDK** (`ai`) | `@ai-sdk/openai-compatible` for local servers (vLLM / llama.cpp / Ollama) and gateways, cloud provider packages as needed (§3B) |
| Markdown parsing | **remark / unified** | Section tree and chunking (§3C) |
| Answer verification | **Python 3.12** + **SymPy**, **NumPy** | Sandboxed worker with a tool whitelist (§3A.3.1) |
| Containers | **Docker** + Docker Compose | One stack: api, web, postgres, verify (§11.5) |
| Lint / format | **Biome** (2.x) | Lint + format for TypeScript and JSON, plus the custom `no-literal-ui-string` plugin (§11.6); `ruff` for the Python worker |
| Testing | `bun test` (unit), **Playwright** (end-to-end) + **axe-core** (accessibility, blocks CI) | Fixture: `tests/engr108_chapter1_new_20q_quiz.json` |
| Model serving (external) | vLLM or llama.cpp (+ an embedding model) | Runs on the GPU host (e.g. Proxmox + RTX 3060), outside the app's stack. Reached through an endpoint (§3B.2) |

**Bun + Fastify:** Fastify runs on Bun, but plugin compatibility (sessions, multipart, swagger) has to be confirmed in a test run in P0. App code avoids Bun-only APIs, so falling back to Node 22 LTS for the API process stays a one-line change if needed (contingency, §15).

### 11.1 Monorepo layout

```
apps/
  api/        Fastify server (+ pg-boss workers)
  web/        React SPA (Vite)
  verify/     Python sandbox worker: runs check programs with whitelisted math tools (sympy, numpy, …); option parsing + comparison (§3A.3.1)
packages/
  shared/     Zod schemas (domain + API contracts, generation schema), quiz normalizer (§3D.2), grading + short-answer normalization, JSON-Schema export
  llm/        model-agnostic LLM layer: endpoints, roles, queueing, structured-output modes, repair loop, prompts, evals, call logging
  knowledge/  ingest (Markdown → sections → chunks → embeddings), hybrid retrieval, KnowledgeStore interface (§3C)
  authoring/  generation→quiz mapper, local validation pipeline (L1–L5)
  authz/      Casbin model + policy, enforcer setup, route permission declarations (§5.2)
  db/         Drizzle schema, migrations, client, repository helpers (api-only dependency)
docker/
  compose.yaml, Dockerfiles per app
tools/
  biome/      rule-config.json, build-rule.ts → no-literal-ui-string.grit (generated), fixtures + neutral snapshot, suppressions baseline (§11.6)
  i18n/       check-catalogs.ts (§11.6)
```

- **Workspaces:** Bun workspaces.
- **TypeScript** everywhere, with `strict` on, except `apps/verify` (Python, sandboxed; §3A.3.1). Its request/response contract is generated from the shared Zod schemas.

### 11.2 Backend

- Fastify + `fastify-type-provider-zod`: route `schema` objects are the shared Zod schemas, so request/response are validated and typed from one definition.
- An OpenAPI document is generated from the same schemas (`@fastify/swagger`).
- Auth and authorization per §5: bcrypt passwords, Postgres-backed sessions with an in-memory cache, and Casbin enforcement in a `preHandler` hook on every route. `@fastify/rate-limit` on auth and model-calling endpoints.
- All model access goes through `packages/llm` (§3B): the Vercel AI SDK with provider packages (`@ai-sdk/openai-compatible` for local servers and gateways, plus cloud provider packages as needed). No other code makes model calls. (If a local server ever needs request options the AI SDK can't send, a direct `openai`-SDK adapter can be added behind the same interface. It's not in v1.)
- Per-endpoint concurrency limits (a queue in front of each endpoint), so a single-GPU backend isn't flooded and cloud rate limits are respected.
- Ingest and retrieval live in `packages/knowledge`, and the local validators (L1–L5) in `packages/authoring`, so both can be tested without the server (against a test Postgres).
- **Background jobs** (pg-boss): embedding chunks, generation batches, L7 verification runs, re-embedding. Progress is pushed to the UI over SSE.

### 11.3 Frontend

- React + Vite (built and served with Bun in dev), TanStack Query, TanStack Router or React Router.
- A typed API client built from shared contracts, so the frontend imports the same Zod types. Options: a thin hand-written `fetch` wrapper typed by contract, or ts-rest / an OpenAPI-generated client. To decide at build time.
- Markdown rendering (`react-markdown`) + KaTeX for `$...$` math, with MathML output for screen readers.
- All UI text comes from i18n catalogs (§1.3). Accessible components (React Aria) are used throughout.
- Forms: react-hook-form + `@hookform/resolvers/zod`, using the same schemas.

### 11.4 ORM recommendation

**Drizzle ORM** (+ drizzle-kit for migrations), with the **hand-written Zod schemas in `packages/shared` as the source of truth for API contracts**.

- **Why Drizzle now:** with Postgres + pgvector from day one, the earlier reason to prefer Prisma (an easy SQLite → Postgres switch) is gone. Drizzle has a native pgvector `vector` column type and distance helpers (cosine/L2) for queries, typed SQL for the hybrid-search query, and first-party Zod integration (`drizzle-zod`) for row schemas. It also runs well on Bun.
- **DB rows ≠ API DTOs:** row schemas from `drizzle-zod` are used internally. API contracts stay hand-written in `packages/shared` (e.g. `QuestionForStudent` leaves out answers). Mapping functions in `apps/api` connect the two, with tests.
- **Alternative considered:** Prisma. Its tooling is mature, but pgvector columns are `Unsupported` there, so every vector read, write and search would be raw SQL.

### 11.5 Deployment (Docker Compose)

| Service | Image | Notes |
|---|---|---|
| `postgres` | `pgvector/pgvector` (Postgres 17) | Volume for data. Nightly `pg_dump` backup job |
| `api` | Bun + app | Fastify + pg-boss workers. Runs migrations on start (or a separate `migrate` one-shot) |
| `web` | Static build | Served by the API, or by a small static server / Caddy |
| `verify` | Python 3.12 slim + pinned sympy/numpy | **Networking off** except the internal link to `api`, read-only root filesystem, non-root user, CPU and memory limits (§3A.3.1) |
| *(optional)* `caddy` | Caddy | TLS + reverse proxy |

- Model servers (vLLM / llama.cpp / embedding model) run **outside** this stack, on the GPU host, and are configured as endpoints (§3B.2). An optional `docker/compose.models.yaml` can be provided for single-host setups.
- Configuration comes from env: DB URL, the encryption key for endpoint secrets, and session secret.

### 11.6 Custom lint rule: `no-literal-ui-string`

**Purpose:** enforce §1.3. No user-facing text is hard-coded in the web app; all of it comes from i18n catalogs through `t()` / `<Trans>`. The rule runs in `biome lint` / `biome check`, locally and in CI, and **an error blocks the merge**.

**Implementation:** a **Biome GritQL plugin** (`tools/biome/no-literal-ui-string.grit`), registered in `biome.json` and limited to the web app's source:

```json
{
  "plugins": [
    { "path": "./tools/biome/no-literal-ui-string.grit",
      "includes": ["apps/web/src/**/*.tsx", "apps/web/src/**/*.ts"] }
  ]
}
```

GritQL plugins are Biome's stable plugin type. They match syntax patterns and report through `register_diagnostic(span, message, severity)`, but they **can't see types or the semantic model**. So the rule is written purely in terms of syntax, as below.

#### What it flags (severity `error`)

A string counts as **UI text** if, after trimming, it contains **at least one letter** (Unicode `\p{L}`). Pure whitespace, numbers and punctuation/symbols (`·`, `—`, `/`, `:`, `%`) are never flagged.

| # | Pattern | Example (flagged) |
|---|---|---|
| F1 | JSX text children | `<p>No questions yet</p>` |
| F2 | String or template literals inside a JSX expression container | `<p>{"Retake missed"}</p>`, ``<p>{`Score: ${n}`}</p>`` |
| F3 | Literal values of **user-visible attributes/props**: `aria-label`, `aria-description`, `aria-valuetext`, `aria-roledescription`, `alt`, `title`, `placeholder`, `label`, `description`, `helperText`, `errorMessage`, `tooltip`, `emptyText`, `confirmText`, `cancelText` | `<Button aria-label="Close">`, `<TextField label="Email" />` |
| F4 | A literal first argument to **UI message functions**: `notify`, `toast`, `confirmDialog`, `announce` (our live-region helper), `window.alert`, `window.confirm`, `window.prompt` | `notify("Saved")` |
| F5 | Assigning a literal to `document.title` | `document.title = "Results"` |

**The rule's lists are single-sourced** in `tools/biome/rule-config.json`: the F3 attributes, F4 functions, the never-flagged attributes, the excluded paths and the proper-noun allowlist. The `.grit` file is **generated** from it by `tools/biome/build-rule.ts`, and CI fails if the generated file is stale. Every contingency below reads the same JSON, so switching implementation never changes what's enforced. The lists change only through code review, like the Casbin policy.

#### What it never flags

- Attributes that aren't user-visible: `className`, `id`, `key`, `href`, `src`, `type`, `role`, `name`, `htmlFor`, `data-*`, `aria-labelledby`, `aria-describedby`, `aria-controls`, `data-testid`, `form`, `method`, `rel`, `target`, `lang`, `dir`, `autoComplete`, `inputMode`. Anything not listed in F3 is out of scope by default.
- Arguments to `t()`, `i18n.t()` and the `i18nKey` prop of `<Trans>`. These are keys, not text.
- **Content rendered from data:** questions, options, source passages and model output arrive as variables, never as literals, so they're naturally out of scope.
- Files excluded by path: `**/*.test.tsx`, `**/*.spec.tsx`, `**/*.stories.tsx`, `apps/web/src/i18n/**`, `apps/web/src/dev/**`.
- An **allowlist of proper nouns** that are never translated (in `rule-config.json`): `gem-proctor`, `KaTeX`, `Markdown`, `LaTeX`, `JSON`, `CSV`. A literal is allowed if, apart from these terms, it contains no letters.

#### Escape hatch

Biome's standard suppression comment for plugin diagnostics, **with a mandatory reason**, e.g. `// biome-ignore lint/plugin: brand wordmark rendered as SVG title`. The exact suppression syntax is confirmed in the P0 test run. A CI script counts suppressions and fails if the count grows beyond the committed baseline, without a matching update to `tools/biome/suppressions-baseline.txt`, so every new exception is visible in review.

#### Message and fix

- Message: `User-facing text must come from the i18n catalog: use t("…") (see SPEC §1.3).`
- **No autofix.** The rule can't choose a catalog key or namespace. A fix would need a human to pick the key and add the string to `en` catalogs.

#### Tests

- Fixture files in `tools/biome/__fixtures__/`: `invalid.tsx` covers every F1–F5 case (and template-literal, nested-JSX and fragment variants); `valid.tsx` covers every "never flags" case, including the allowlist and `t()` calls.
- A test runs the active implementation on the fixtures and compares its diagnostics with a committed snapshot. The snapshot uses a **tool-neutral format** (`file:line:col case-id`, e.g. `invalid.tsx:12:7 F3`), produced by a small adapter per implementation, so the same fixtures and snapshot carry over unchanged to any contingency. Every change to the rule must update the snapshot.

#### Companion check (not part of the lint rule)

A CI script (`tools/i18n/check-catalogs.ts`) handles what a syntax rule can't:
- every `t("key")` / `i18nKey="key"` used in code exists in the `en` catalog;
- no catalog key is unused;
- every API error code (`packages/shared` error-code enum) has an `errors:<code>` entry in the catalog. The API side is enforced by types: route handlers can only throw `AppError(code, params)`, where `code` is the shared enum, so the API can't send prose.

#### Test run in P0 (go/no-go before relying on it)

1. Confirm that GritQL patterns in Biome match **JSX text, JSX attributes and expression containers in `.tsx`** files. Biome's docs list JavaScript as a plugin target language but don't spell out JSX/TSX.
2. Confirm the suppression-comment syntax for plugin diagnostics.
3. Run the fixtures and check that every F1–F5 case is detected with no false positives on `valid.tsx`.

#### Contingency plans

If the primary implementation (the GritQL plugin) fails its test run, or breaks later (e.g. after a Biome upgrade), switch to the next contingency. **What's enforced stays the same:** F1–F5, the never-flagged list, the allowlist, the error severity, the merge block, the fixtures and the tool-neutral snapshot. Only the implementation changes.

**Triggers (any one):**
- A GritQL pattern can't match one of F1–F5 in `.tsx` (JSX text, attributes, expression containers, template literals).
- `valid.tsx` produces false positives that can't be removed in the pattern.
- Plugin diagnostics can't be suppressed with a reason-bearing comment.
- Plugin support regresses or is removed in a Biome release we need.
- Linting `apps/web` gets more than ~2× slower because of the plugin.

| | **Contingency A: Biome JavaScript plugin** | **Contingency B: ESLint, this rule only** | **Contingency C: standalone AST check** |
|---|---|---|---|
| **Use when** | GritQL can't express a case, but Biome's plugin system works | A fails too, or JS plugins break or are removed | A and B both fail, or ESLint's plugin can't be made to match the scope |
| **Implementation** | `tools/biome/no-literal-ui-string.js` using `defineRule`, with AST queries for JSX text, attributes, expression containers and call expressions (node kind names confirmed at switch time). Reads `rule-config.json` | `eslint` + `typescript-eslint` parser + `eslint-plugin-i18next` (`no-literal-string`), configured from `rule-config.json` (JSX-only mode, the F3 attributes, the F4 functions; exact option names confirmed at switch time). F5, if the plugin can't express it: a tiny local ESLint rule `local/no-document-title-literal`. **No other ESLint rules** are enabled; Biome still lints and formats everything else | `tools/i18n/no-literal-ui-string.ts`: parse each file with the TypeScript compiler API (`ts.createSourceFile`), walk JSX and call nodes, and apply F1–F5 from `rule-config.json`. No third-party lint dependency |
| **Config changes** | Replace the `.grit` entry in `biome.json` with the `.js` plugin, same `includes`. **Pin Biome to an exact version** (developer-preview API), and Biome upgrades need manual approval | Add `eslint.config.js` limited to `apps/web/src/**/*.{ts,tsx}` with the same exclusions; add a `lint:i18n` script | Add a `lint:i18n` script (`bun tools/i18n/no-literal-ui-string.ts apps/web/src`) |
| **Suppression** | Biome plugin suppression comment with a reason (as for GritQL) | `// eslint-disable-next-line i18next/no-literal-string -- <reason>`; a reason is required (enforced by `eslint-comments/require-description` or the baseline script) | `// i18n-ignore: <reason>` on the line before; the script rejects it without a reason |
| **Suppression baseline** | Unchanged script | Script counts the ESLint disable comments instead | Script counts `i18n-ignore` comments |
| **CI** | Unchanged (`biome check`) | `biome check` **plus** `bun run lint:i18n` (`eslint`); both block the merge | `biome check` **plus** `bun run lint:i18n`; blocks the merge |
| **Editor feedback** | Yes (Biome LSP) | Yes (ESLint extension) | No: CI and the pre-commit hook only. This is the main cost of C |
| **Snapshot adapter** | Biome JSON reporter → neutral format | ESLint JSON formatter → neutral format | Script outputs the neutral format directly |
| **Exit / return path** | Move back to GritQL when the blocking case is supported. Re-run the test run first | Move back to A or the primary when they pass the test run. Remove ESLint entirely | Move back to any passing option |

**Switching procedure** (the same for every contingency):
1. Implement the contingency, reading `rule-config.json`.
2. Run the fixtures. The tool-neutral snapshot must match **without edits**. A change to the snapshot means the scope changed, which needs its own review.
3. Port the suppression baseline (same count, new comment syntax).
4. Remove the previous implementation's files and config, so only one is active.
5. Mark this section **"Active implementation: Contingency X since YYYY-MM-DD"** and add a row to the decision log (§15) with the trigger and evidence (Biome version, the failing case).
6. Commit the switch as one commit, referencing the §15 row.

**Active implementation:** primary (GritQL plugin), pending the P0 test run.

---

## 12. API surface (initial)

All request/response bodies are shared Zod schemas. `/api/v1` prefix.

```
Auth        POST /auth/register (if enabled) | /auth/login | /auth/logout      GET /auth/me
Admin       GET /admin/users   PUT /admin/users/:id/roles   POST /admin/users/:id/reset-password
            GET/PUT /admin/settings   GET /admin/audit-log (filter, CSV export)
Sources     POST /sources (paste or .md/.txt upload)   GET /sources   GET /sources/:id
            PUT  /sources/:id   (new revision)   POST /sources/preview   (parse → section tree + warnings, nothing saved)
            GET  /sources/:id/sections   GET /sources/:id/chunks?sectionIds=
            POST /sources/:id/scope/estimate    (section ids → chunk count, tokens, fit per role)
Authoring   POST /authoring/sessions   GET /authoring/sessions/:id
            POST /authoring/sessions/:id/objectives:propose   PUT /authoring/sessions/:id/objectives
            PUT  /authoring/sessions/:id/blueprint
            POST /authoring/sessions/:id/generate      (streams progress via SSE)
            POST /authoring/sessions/:id/revise        (targeted questions + notes)
            PATCH /authoring/questions/:id             (accept/reject/edit/lock → re-validate)
            POST /authoring/questions/:id/validate     (re-run local pipeline; ?judge=true for L6)
            POST /authoring/questions/:id/verify       (L7: re-run the check, or regenerate it with ?regenerate=true)
            POST /authoring/questions/:id/verify/accept-fix   (apply the suggested correctAnswer)
            GET  /authoring/sessions/:id/coverage
            GET  /authoring/sessions/:id/revisions/:n   GET /authoring/sessions/:id/revisions/compare?a=&b=
            GET  /authoring/questions/:id/history
            POST /authoring/sessions/:id/publish       (→ Test + TestVersion)
Imports     POST /imports/preview  (file or text → normalized Quiz draft + report, nothing saved)
            POST /imports          (confirmed Quiz draft → Test + TestVersion)
Tests       GET/POST /tests   GET/PATCH/DELETE /tests/:id
            GET/POST /tests/:id/versions   POST /tests/:id/versions/:v/publish
            PUT  /tests/:id/versions/:v/practice-groups   (make available for practice to groups)
            GET /tests/:id/export          (Quiz JSON, §4)   GET /practice/attempts/:id/export   (Result JSON)
            GET /schema/quiz.json   GET /schema/result.json   (JSON Schemas generated from §4)
Practice    POST /practice/attempts   GET /practice/attempts?testId=
            GET /practice/attempts/:id   PUT /practice/attempts/:id/responses/:questionId
            POST /practice/attempts/:id/submit
Groups      CRUD /groups   POST /groups/:id/join-code:regenerate   POST /groups/join   CRUD /groups/:id/members
Assignments CRUD /assignments   GET /assignments/:id/dashboard   GET /assignments/:id/export.csv
Student     GET /me/assignments   POST /me/assignments/:id/start
            PUT /submissions/:id/responses/:questionId   POST /submissions/:id/submit
            GET /submissions/:id/result   (only after release; shape depends on resultVisibility)
Review      GET /assignments/:id/review-queue   POST /responses/:id/override
            POST /submissions/:id/reset   PUT /assignments/:id/accommodations/:studentId   POST /assignments/:id/release
AI          POST /ai/analyze-attempt   POST /ai/analyze-cohort   GET /ai/reports/:id
LLM admin   CRUD /admin/llm/endpoints   GET /admin/llm/endpoints/:id/models   POST /admin/llm/endpoints/:id/probe
            GET/PUT /admin/llm/roles   GET /admin/llm/stats   POST /admin/llm/evals/run
```

---

## 13. Open questions (for iteration)

1. **Question types beyond v1:** ordering, matching, fill-in-the-blank, image-based questions?
2. **Default model roles:** which role → endpoint/model assignments should a fresh install ship with? (Probably: everything unassigned, plus a setup wizard with the local reference setup preselected.)
3. **Fairness & quotas:** do we need per-user limits (questions/day, concurrent runs, cloud spend), or is the fair queue (§3B.2) enough?
4. **Embedding model:** which one to recommend (multilingual? math-aware?), and at what vector dimension? It's now required for the knowledge base. Changing it means a column migration plus re-embedding everything.
5. **Minimum model:** what's the minimum we document as supported for `authoring.generate` (e.g. "≥ 8B open-weight, `native_schema`, ≥ 16K context")? Decide after running the §3B.4 eval set on the 3060 box and on one cloud model. Also: vLLM or llama.cpp as the recommended local server?
6. **Source sharing & retention:** can a source be shared with other proctors/groups? How long are sources kept? (Students see cited passages only on `full_review` assignments, §9.2.)
7. **Deployment:** Docker Compose on one host (e.g. a Proxmox VM) is the v1 target (§11.5). Is anything beyond that needed (HA, managed Postgres, separate GPU host networking/TLS)?

8. **Test type presets:** fixed in code for v1. Should admins be able to define their own (e.g. "lab quiz") later?
9. **Multi-chapter quizzes:** the base format has a single `chapter` int. The proposal is an optional `chapters: int[]` extension (§4), with `chapter` set only for single-chapter quizzes. Or should `chapter` accept a list?
10. **Whitelist growth:** which tools come next (e.g. `scipy.stats` for statistics courses, `networkx` for graph problems), and who approves additions?
11. **Option parsing coverage:** SymPy's LaTeX parser plus our vector/matrix handling covers VMLS-style math. Should we build a test set of option formats from real quizzes before deciding it's enough?
12. **Unverified questions in proctored tests:** block publishing by default (current proposal), or warn only?
13. **Casbin adapter:** use an existing Postgres adapter for role grants, or a small custom adapter on Drizzle (only `g` lines live in the DB, so it's tiny)?
14. **UI string-function list (F4, §11.6):** confirm the names of our notification and live-region helpers once the component library is chosen, so the rule covers them from the start.
15. **Computable `multi_choice`:** excluded in v1 (§3A.3.1). Later, a program could return the set of correct options, e.g. by evaluating a predicate on each one?

---

## 14. Suggested phasing

| Phase | Scope |
|---|---|
| **P0 – Foundations** | Bun monorepo, Docker Compose (Postgres + pgvector, api, web, verify skeleton), Drizzle schema + migrations, pg-boss, auth (bcrypt, cached sessions), Casbin roles + route enforcement, first-admin bootstrap, base + extended Zod schemas, quiz normalizer + import preview/edit, Quiz/Result export. Test run: Fastify plugins on Bun. Cross-cutting from day one: audit log, i18n scaffolding (string catalogs, error codes), accessibility CI (axe), component library. `no-literal-ui-string` Biome plugin + fixtures + catalog check (§11.6), with its test run |
| **P1 – Practice** | Practice attempts (shuffle, immediate feedback, soft timer, flag, autosave, retake missed), grading + short-answer normalization, self-graded override, results, history, Result export |
| **P1.5 – LLM layer** | `packages/llm`, endpoints + model discovery + probe, role assignment, per-endpoint queue, structured-output modes + normalization/repair loop, eval harness, call logging. Verified against local Qwen on the 3060 box (vLLM and llama.cpp) and at least one cloud model |
| **P2 – Authoring** | Text/Markdown sources + revisions, **knowledge base** (chunking, embedding jobs, pgvector + full-text hybrid retrieval, retrieval logs), scope picker, objectives from headings, blueprint, generation, L1–L3 validation, review UI, revise loop, publish, provenance trail (question history, `QuestionEvent`). **Computable questions need P2.1**, so P2.1 is built before P2's generation step |
| **P2.1 – Answer computation & verification** | `apps/verify` sandbox + whitelist, `verify.solve` role, option parsing/comparison and the shared option formatter, L7 flow A (computed answers for generated questions) and flow B (checks for import and edits), suggested-fix flow, proctored publish gate. Test fixture: `tests/engr108_chapter1_new_20q_quiz.json` (Q7 must fail with the fix `-1`) |
| **P2.5 – Authoring depth** | L4/L5 coverage matrix/heatmap, L6 judge, revision compare view |
| **P3 – Proctoring** | Groups + join codes, assignments (to groups), single-attempt submissions, time limits, review queue, overrides, release action, cohort view, CSV export |
| **P3.1 – AI analysis** | Attempt analysis, cohort analysis on top of the cohort view |
| **P4 – Hardening** | Backups/restore drill, performance, full manual accessibility audit |

---

## 15. Contingencies & decision log

Several choices in this spec carry a known risk and have a planned fallback. When one is activated, the spec is updated **in the same commit**: the affected section is marked "Active: …", and a row is added to the log below. That way the spec always describes what is actually built.

### 15.1 Planned contingencies

| Area | Primary | Contingency | Trigger | Spec |
|---|---|---|---|---|
| i18n lint rule | Biome GritQL plugin | A: Biome JS plugin → B: ESLint (`eslint-plugin-i18next`) for this rule only → C: standalone TypeScript AST check | Test-run failure or later regression (triggers in §11.6) | §11.6 |
| API runtime | Bun | Node 22 LTS for the API process (Bun stays the package manager and test runner) | A Fastify plugin we need (sessions, multipart, swagger) misbehaves on Bun in the P0 test run or later | §11.0 |
| LLM client | Vercel AI SDK | Direct `openai`-SDK adapter behind the same `LlmRuntime` interface, per endpoint | A local server needs request options the AI SDK can't send, or structured output fails through the SDK but works directly | §3B.1, §11.2 |
| Casbin adapter | Existing Postgres adapter | Small custom adapter on Drizzle (only `g` lines in the DB) | The adapter doesn't work on Bun or with our schema | §5.2 |
| Option parsing (L7) | SymPy LaTeX parsing + our vector/matrix handling | Add a dedicated LaTeX→SymPy parser library to the whitelist (reviewed), or mark the format `unverified` (warn) | Real quizzes contain option formats the parser can't handle | §3A.3.1 |

### 15.2 Decision log

| Date | Area | Decision | Reason / evidence | Commit |
|---|---|---|---|---|
| — | — | *(no contingencies activated yet)* | — | — |
