// Flow A against recorded gen-v8 output, the real sandbox and a mock model (P2.1.md C15–C19, C22–C24).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type ComputableQuestion,
  checkConceptNotation,
  computeQuestion,
  hasNotation,
  questionSeed,
  renderQuestion,
} from "@gem/authoring";
import { AuditLog, LlmCallLog, VerificationRun } from "@gem/db";
import { desc, eq } from "drizzle-orm";
import { createL7Env, type L7Env, promptOf, RECORDED, replay, verifyPython } from "./l7-helpers.ts";

const dbReady = !!process.env.TEST_PG_ADMIN_URL;
const INNER = "result = x.dot(y)";
const vector = (name: string, size: number[] = [3]) => ({
  name,
  kind: "vector" as const,
  size,
  from: "sample" as const,
  sourceText: "",
});
const question = (over: Partial<ComputableQuestion>): ComputableQuestion => ({
  tempId: "t1",
  type: "single_choice",
  question: "What is the inner product of {x} and {y}?",
  inputs: [vector("x"), vector("y")],
  constraint: "",
  answerProgram: INNER,
  mistakes: [
    { whyWrong: "adds", program: "result = sum(x) + sum(y)" },
    { whyWrong: "forgets a term", program: "result = x[0]*y[0] + x[1]*y[1]" },
  ],
  evidence: [{ chunkId: "c1", quote: "the inner product" }],
  ...over,
});
const used = () => ({ keys: [], source: [] });
const blindSaying = (program: string) => () => JSON.stringify({ program });

describe.skipIf(!verifyPython || !dbReady)("L7 flow A", () => {
  let env: L7Env;
  let n = 0;
  const ref = () => ({ questionId: ++n });
  const compute = (q: ComputableQuestion, over: Partial<Parameters<typeof computeQuestion>[1]> = {}) =>
    computeQuestion(env.deps, {
      question: q,
      chunks: ["A passage."],
      batchSeed: "s",
      used: used(),
      ref: ref(),
      ...over,
    });
  const runsFor = async (questionId: number) =>
    env.t.db.select().from(VerificationRun).where(eq(VerificationRun.questionId, questionId));

  beforeAll(async () => {
    env = await createL7Env();
  }, 30_000);
  afterAll(async () => {
    await env?.close();
  });
  beforeEach(() => {
    env.mock.requests.length = 0;
  });

  test("C15: recorded gen-v8 output is Computed, for every computable question it holds", async () => {
    env.setReply(replay(RECORDED.flowA.replies));
    const usedSets = { keys: [] as string[], source: [] as string[] };
    const seen: string[] = [];
    for (const q of RECORDED.batch.questions) {
      if (!q.computable) continue;
      const r = await computeQuestion(env.deps, {
        question: q as unknown as ComputableQuestion,
        chunks: [RECORDED.chunk.text],
        batchSeed: RECORDED.batchSeed,
        used: usedSets,
        ref: ref(),
      });
      if (r.usedKey) usedSets.keys.push(r.usedKey);
      usedSets.source.push(...r.usedSource);
      seen.push(`${q.type}:${r.outcome}`);
      expect(r.check).toBe("pass");
      expect(r.verification).toMatchObject({ status: "computed", answerSource: "computed" });
      expect(r.correctAnswer).not.toBeNull();
      for (const input of q.inputs as { name: string }[]) expect(r.rendered).not.toContain(`{${input.name}}`);
      expect(r.verification.seed).toBe(questionSeed(RECORDED.batchSeed, q.tempId as string));
      expect(Object.keys(r.verification.inputs ?? {}).length).toBeGreaterThan(0);
    }
    expect(seen).toEqual(["single_choice:computed", "numeric:computed", "true_false:computed"]);
  }, 60_000);

  test("C15: Programs disagree fails, with both programs and values", async () => {
    env.setReply(blindSaying("result = 123456"));
    const r = await compute(question({}));
    expect(r).toMatchObject({ outcome: "disagree", check: "fail", reason: "programs_disagree", correctAnswer: null });
    expect(r.options).toBeNull();
    expect(r.verification.status).toBe("failed");
    expect(r.author?.program).toBe(INNER);
    expect(r.author?.result?.kind).toBe("integer");
    expect(r.blind?.result?.value).toBe("123456");
    expect(r.verification.program).toBe("result = 123456");
  });

  test("C15: Couldn't compute warns, unverified, with no answer", async () => {
    env.setReply(blindSaying("result = 1/0"));
    const r = await compute(question({}));
    expect(r).toMatchObject({ outcome: "couldnt_compute", check: "warn", correctAnswer: null, options: null });
    expect(r.verification.status).toBe("unverified");
    expect(r.blind?.status).toBe("program_error");
  });

  test("C15: a model that fails to write the blind program is Couldn't compute, too", async () => {
    env.setReply(() => ({ status: 400, body: { error: { message: "no" } } }));
    const r = await compute(question({}));
    expect(r).toMatchObject({ outcome: "couldnt_compute", check: "warn", reason: "llm_failed" });
  });

  // Reads the inputs from the rendered question, like a blind program would, so the values always agree.
  const solver = (expression: string) => (body: Record<string, unknown>) => {
    const { question: text } = promptOf(body);
    const vectors = [...text.matchAll(/\\begin\{bmatrix\}(.*?)\\end\{bmatrix\}/g)].map(
      (m) =>
        `Matrix([${(m[1] as string)
          .split("&")
          .map((s) => s.trim())
          .join(", ")}])`,
    );
    const [x, y] = vectors;
    return JSON.stringify({ program: `from sympy import Matrix\nx = ${x}\ny = ${y}\nresult = ${expression}` });
  };

  test("C16: single_choice gets 4 built options, the answer among them once", async () => {
    env.setReply(solver("x.dot(y)"));
    const r = await compute(question({}));
    expect(r.outcome).toBe("computed");
    expect(r.options).toHaveLength(4);
    expect(r.options?.filter((o) => o.isCorrect)).toHaveLength(1);
    expect(r.options?.find((o) => o.isCorrect)?.text).toBe(r.correctAnswer as string);
    expect(r.verification.distractors?.length).toBe(3);
    expect(r.verification.distractors?.some((d) => d.source === "random")).toBe(true);
    expect(r.verification.distractors?.filter((d) => d.source === "common").every((d) => d.program)).toBe(true);
  });

  test("C16: true_false gets True and False, and the matching one is correct", async () => {
    env.setReply(solver("x.dot(y) == 0"));
    const r = await compute(
      question({ type: "true_false", answerProgram: "result = x.dot(y) == 0", mistakes: [], tempId: "tf" }),
    );
    expect(r.outcome).toBe("computed");
    expect(r.options?.map((o) => o.text)).toEqual(["True", "False"]);
    expect(r.options?.find((o) => o.isCorrect)?.text).toBe(r.correctAnswer as string);
  });

  test("C16: numeric: an exact value has tolerance 0, a float 1e-6", async () => {
    env.setReply(solver("x.dot(y)"));
    const exact = await compute(question({ type: "numeric", mistakes: [] }));
    expect(exact.outcome).toBe("computed");
    expect(exact.numericTolerance).toBe(0);
    expect(exact.correctAnswer).toMatch(/^-?\d+$/);
    env.setReply(solver("x.norm() + 0.0"));
    const float = await compute(
      question({ type: "numeric", answerProgram: "result = x.norm() + 0.0", mistakes: [], tempId: "f" }),
    );
    expect(float.outcome).toBe("computed");
    expect(float.numericTolerance).toBe(1e-6);
    expect(Number(float.correctAnswer)).toBeGreaterThan(0);
  });

  test("C16: short_answer's answer is the formatted value", async () => {
    env.setReply(solver("x + y"));
    const r = await compute(question({ type: "short_answer", answerProgram: "result = x + y", mistakes: [] }));
    expect(r.outcome).toBe("computed");
    expect(r.correctAnswer).toContain(String.raw`\begin{bmatrix}`);
    expect(r.options).toBeNull();
  });

  test("C16: multi_choice can't be computable", async () => {
    const r = await compute(question({ type: "multi_choice" }));
    expect(r).toMatchObject({ outcome: "failed", check: "fail", reason: "not_computable_type" });
    expect(env.mock.chatRequests()).toHaveLength(0);
  });

  test("C16: a true_false question whose program returns a number is repaired, not accepted", async () => {
    let asked = 0;
    env.setReply((body) => {
      const p = promptOf(body);
      if (p.kind === "repair") {
        asked++;
        return JSON.stringify({ program: "result = x.dot(y) == 0" });
      }
      return solver("x.dot(y) == 0")(body);
    });
    const r = await compute(
      question({ type: "true_false", answerProgram: "result = x.dot(y)", mistakes: [], tempId: "ty" }),
    );
    expect(asked).toBe(1);
    expect(r.outcome).toBe("computed");
    expect(r.author?.repaired).toBe(true);
  });

  test("C17: what the model states is discarded; a differing value is modelClaim; no model value is an option", async () => {
    env.setReply(solver("x.dot(y)"));
    const claimed = question({
      options: [
        { text: "987654", isCorrect: true },
        { text: "111111", isCorrect: false },
      ],
    });
    const r = await compute(claimed);
    expect(r.outcome).toBe("computed");
    expect(r.verification.modelClaim).toBe("987654");
    const texts = r.options?.map((o) => o.text) ?? [];
    expect(texts).not.toContain("987654");
    expect(texts).not.toContain("111111");

    const numeric = await compute(
      question({ type: "numeric", mistakes: [], numericAnswer: { value: 987654, tolerance: 0 }, tempId: "n2" }),
    );
    expect(numeric.verification.modelClaim).toBe("987654");
    expect(numeric.correctAnswer).not.toBe("987654");
  });

  test("C17: a stated value equal to the computed one is no claim", async () => {
    env.setReply(blindSaying("result = 6"));
    const r = await compute(
      question({
        type: "numeric",
        inputs: [{ name: "a", kind: "integer", size: [], from: "source", sourceText: "6" }],
        evidence: [{ chunkId: "c1", quote: "there are 6 of them" }],
        question: "How many are there, {a}?",
        answerProgram: "result = a",
        mistakes: [],
        numericAnswer: { value: 6, tolerance: 0 },
      }),
    );
    expect(r.outcome).toBe("computed");
    expect(r.verification.modelClaim).toBeUndefined();
  });

  test("C18: the blind request has only the rendered question and the passage", async () => {
    env.setReply(solver("x.dot(y)"));
    const q = question({
      options: [{ text: "SECRET-OPTION", isCorrect: true }],
      numericAnswer: { value: 424242, tolerance: 0 },
      acceptedAnswers: ["SECRET-ACCEPTED"],
      answerProgram: `${INNER} # SECRET-AUTHOR`,
      mistakes: [{ whyWrong: "SECRET-WHY", program: "result = 1 # SECRET-MISTAKE" }],
    });
    const r = await compute(q, { chunks: ["PASSAGE-TEXT"] });
    const [blind] = env.mock.chatRequests().filter((c) => promptOf(c.body).kind === "blind");
    const sent = JSON.stringify(blind?.body.messages);
    for (const secret of ["SECRET-", "424242", "x.dot(y)", "answerProgram", "mistakes"]) {
      expect(sent).not.toContain(secret);
    }
    expect(sent).toContain("PASSAGE-TEXT");
    expect(promptOf(blind?.body as Record<string, unknown>).question).toBe(r.rendered as string);
    expect(r.rendered).toContain(String.raw`\begin{bmatrix}`);
    expect(r.rendered).not.toContain("{x}");
  });

  test("C19: each of SPEC's four notation forms is detected, and plain text isn't", () => {
    expect(hasNotation("Let $x$ be a vector.")).toBe(true);
    expect(hasNotation(String.raw`Let \(x\) be a vector.`)).toBe(true);
    expect(hasNotation(String.raw`The \alpha value`)).toBe(true);
    expect(hasNotation("the list [1, 2] here")).toBe(true);
    expect(hasNotation("the point (1, −2, 2) here")).toBe(true);
    expect(hasNotation("so 3 + 4 is")).toBe(true);
    expect(hasNotation("where 2 = 2")).toBe(true);
    expect(hasNotation("the entry x_1 of it")).toBe(true);
    expect(hasNotation("the transpose x^T of it")).toBe(true);
    expect(hasNotation("Which statement about vectors is true?")).toBe(false);
    expect(hasNotation("Chapter 3 covers 12 topics, (see notes)")).toBe(false);
  });

  test("C19: a computable result fails with the reason; the answer the model marked isn't used", async () => {
    const replied = JSON.stringify({ reason: "uses given vectors", computable: true });
    env.setReply(() => replied);
    const r = await checkConceptNotation(env.deps, "Let $x = [1, 2]$, $y = [-2, 1]$. Which statement is true?", [
      "They are orthogonal",
      "They are parallel",
    ]);
    expect(r).toEqual({ outcome: "fail", classified: true, reason: "calculation_as_concept" });
  });

  test("C19: a symbol-only definition passes, after classification", async () => {
    env.setReply(() => JSON.stringify({ reason: "a definition", computable: false }));
    const r = await checkConceptNotation(env.deps, "What is $x^T y = x_1 y_1 + \\dots$ called?", [
      "Inner product",
      "Norm",
    ]);
    expect(r).toEqual({ outcome: "pass", classified: false, reason: "ok" });
    expect(env.mock.chatRequests()).toHaveLength(1);
  });

  test("C19: no notation means no model call", async () => {
    const r = await checkConceptNotation(env.deps, "Which statement about vectors is true?", ["One", "Two"]);
    expect(r).toEqual({ outcome: "pass", classified: null, reason: "ok" });
    expect(env.mock.chatRequests()).toHaveLength(0);
  });

  test.each([
    ["a syntax error", "result = x.dot(y"],
    ["a NameError", "result = nothing_here"],
    ["an ImportError", "import not_a_module\nresult = 1"],
    ["the wrong result type", "result = 'text'"],
  ])("C22: repairs %s once", async (_name, broken) => {
    let repairs = 0;
    env.setReply((body) => {
      if (promptOf(body).kind === "repair") {
        repairs++;
        return JSON.stringify({ program: INNER });
      }
      return solver("x.dot(y)")(body);
    });
    const r = await compute(question({ answerProgram: broken, tempId: `r${n}` }));
    expect(repairs).toBe(1);
    expect(r.outcome).toBe("computed");
    expect(r.author?.repaired).toBe(true);
    expect(r.verification.authorProgram).toBe(INNER);
  });

  test("C22: a timeout isn't repaired", async () => {
    let repairs = 0;
    env.setReply((body) => {
      if (promptOf(body).kind === "repair") repairs++;
      return solver("x.dot(y)")(body);
    });
    const r = await compute(question({ answerProgram: "while True:\n    pass" }));
    expect(r).toMatchObject({ outcome: "couldnt_compute", check: "warn", reason: "program_timeout" });
    expect(repairs).toBe(0);
  }, 30_000);

  test("C22: a denial isn't repaired", async () => {
    let repairs = 0;
    env.setReply((body) => {
      if (promptOf(body).kind === "repair") repairs++;
      return solver("x.dot(y)")(body);
    });
    const r = await compute(question({ answerProgram: "import os\nos.fork()\nresult = 1" }));
    expect(r.outcome).toBe("denied");
    expect(repairs).toBe(0);
  }, 30_000);

  test("C22: a mistake program isn't repaired: a failed one is dropped", async () => {
    let repairs = 0;
    env.setReply((body) => {
      if (promptOf(body).kind === "repair") repairs++;
      return solver("x.dot(y)")(body);
    });
    const r = await compute(question({ mistakes: [{ whyWrong: "breaks", program: "result = nothing_here" }] }));
    expect(r.outcome).toBe("computed");
    expect(repairs).toBe(0);
    expect(r.mistakesDropped.map((d) => d.whyWrong)).toEqual(["breaks"]);
    expect(r.options).toHaveLength(4);
  });

  test("C22: a repair that fails leaves it unverified", async () => {
    env.setReply((body) =>
      promptOf(body).kind === "repair" ? JSON.stringify({ program: "still broken(" }) : solver("x.dot(y)")(body),
    );
    const r = await compute(question({ answerProgram: "broken(" }));
    expect(r).toMatchObject({ outcome: "couldnt_compute", check: "warn", correctAnswer: null });
    expect(r.verification.status).toBe("unverified");
    expect(r.author?.repaired).toBe(true);
  });

  test("C23: a sandbox denial fails the question and writes the audit row, with no program text", async () => {
    env.setReply(solver("x.dot(y)"));
    const hostile = "import os\nos.fork()\nresult = 1";
    const questionRef = ref();
    const r = await compute(question({ answerProgram: hostile }), { ref: questionRef });
    expect(r).toMatchObject({ outcome: "denied", check: "fail", reason: "sandbox_denial", correctAnswer: null });
    expect(r.verification.status).toBe("failed");
    const [audit] = await env.t.db
      .select()
      .from(AuditLog)
      .where(eq(AuditLog.action, "verify.sandbox_denial"))
      .orderBy(desc(AuditLog.at))
      .limit(1);
    expect(audit).toMatchObject({ actorId: null, targetType: "question", targetId: String(questionRef.questionId) });
    const [run] = await runsFor(questionRef.questionId);
    expect(run?.status).toBe("sandbox_denial");
    expect(audit?.after).toEqual({ runId: run?.id, questionId: questionRef.questionId });
    expect(JSON.stringify(audit)).not.toContain("fork");
  }, 30_000);

  test("C23: a denial in a constraint or a mistake program fails the question too", async () => {
    env.setReply(solver("x.dot(y)"));
    const before = (await env.t.db.select().from(AuditLog).where(eq(AuditLog.action, "verify.sandbox_denial"))).length;
    const inConstraint = await compute(question({ constraint: "import os\nos.fork()\nvalid = True" }));
    expect(inConstraint.outcome).toBe("denied");
    const inMistake = await compute(
      question({ mistakes: [{ whyWrong: "hostile", program: "import os\nos.fork()\nresult = 1" }] }),
    );
    expect(inMistake.outcome).toBe("denied");
    const after = (await env.t.db.select().from(AuditLog).where(eq(AuditLog.action, "verify.sandbox_denial"))).length;
    expect(after).toBe(before + 2);
  }, 30_000);

  test("C23: an ordinary math error isn't a denial", async () => {
    env.setReply(solver("x.dot(y)"));
    const before = (await env.t.db.select().from(AuditLog).where(eq(AuditLog.action, "verify.sandbox_denial"))).length;
    const r = await compute(question({ answerProgram: "result = 1/0" }));
    expect(r.outcome).toBe("couldnt_compute");
    const after = (await env.t.db.select().from(AuditLog).where(eq(AuditLog.action, "verify.sandbox_denial"))).length;
    expect(after).toBe(before);
  });

  test("C24: every run writes a VerificationRun with sandboxVersion; every call is logged with bodies", async () => {
    env.setReply(solver("x.dot(y)"));
    const before = await env.t.db.select().from(LlmCallLog);
    const questionRef = ref();
    const r = await compute(question({}), { ref: questionRef });
    expect(r.outcome).toBe("computed");
    const runs = await runsFor(questionRef.questionId);
    expect(runs.map((x) => x.programKind).sort()).toEqual(["author", "author", "author", "blind"]);
    for (const run of runs) {
      expect(run.sandboxVersion).toContain("sympy/");
      expect(run.program.length).toBeGreaterThan(0);
      expect(run.durationMs).toBeGreaterThanOrEqual(0);
    }
    const logs = await env.t.db.select().from(LlmCallLog);
    const added = logs.slice(before.length);
    expect(added).toHaveLength(env.mock.chatRequests().length);
    for (const log of added) {
      expect(log.role).toBe("verify.solve");
      expect(log.requestBody).not.toBeNull();
      expect(log.responseBody).not.toBeNull();
    }
  });

  test("C24: a hostile result string is stored and returned as text", async () => {
    const hostile = "<script>alert(1)</script>";
    const program = `from sympy import Symbol\nresult = Symbol(${JSON.stringify(hostile)})`;
    env.setReply(blindSaying(program));
    const questionRef = ref();
    const r = await compute(question({ type: "short_answer", answerProgram: program, mistakes: [] }), {
      ref: questionRef,
    });
    expect(r.outcome).toBe("computed");
    expect(r.correctAnswer).toContain("script");
    const runs = await runsFor(questionRef.questionId);
    expect(JSON.stringify(runs.map((x) => x.result))).toContain("alert(1)");
  });

  test("C24: nothing on the TypeScript side evaluates a result", () => {
    const roots = ["apps/api/src", "packages/authoring/src", "packages/shared/src", "packages/llm/src"];
    const pattern = /\beval\s*\(|\bsympify\b|new Function\(/;
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const path = join(dir, f);
        return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
      });
    const root = join(import.meta.dir, "../../..");
    const hits = roots.flatMap((r) => walk(join(root, r))).filter((f) => pattern.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });

  test("renders placeholders outside and inside math", () => {
    const latex = { x: "1", y: String.raw`\begin{bmatrix}1\end{bmatrix}` };
    expect(renderQuestion("Add {x} and ${y}$, and $x = {x}$.", latex)).toBe(
      String.raw`Add $1$ and $\begin{bmatrix}1\end{bmatrix}$, and $x = 1$.`,
    );
    expect(renderQuestion(String.raw`Costs \$3 and {x}`, latex)).toBe(String.raw`Costs \$3 and $1$`);
    expect(renderQuestion("no {z} here", latex)).toBe("no {z} here");
  });

  test("the same seed gives the same question; a different tempId doesn't", async () => {
    env.setReply(solver("x.dot(y)"));
    const a = await compute(question({ tempId: "same" }));
    const b = await compute(question({ tempId: "same" }));
    const c = await compute(question({ tempId: "other" }));
    expect(b.rendered).toBe(a.rendered as string);
    expect(b.options).toEqual(a.options);
    expect(c.rendered).not.toBe(a.rendered as string);
  });
});
