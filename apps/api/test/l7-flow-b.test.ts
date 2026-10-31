// Flow B on the real sandbox with a mock model (P2.1.md C20, C21, C23), and the gate.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { checkProctorReady, checkQuestion, type ImportedQuestion, importedQuestion } from "@gem/authoring";
import { AuditLog, VerificationRun } from "@gem/db";
import { type L7EvalSet, loadEvalSet, runEval } from "@gem/llm";
import { EVAL_METRICS } from "@gem/shared";
import { eq } from "drizzle-orm";
import { l7Runner } from "../src/llm-evals.ts";
import { createL7Env, type L7Env, promptOf, verifyPython } from "./l7-helpers.ts";

const dbReady = !!process.env.TEST_PG_ADMIN_URL;

const q = (over: Partial<ImportedQuestion>): ImportedQuestion => ({
  id: 7,
  question: "What is the inner product?",
  options: ["5", "3", "7", "-1"],
  correctAnswer: "-1",
  acceptedAnswers: [],
  type: null,
  passage: "",
  ...over,
});

describe.skipIf(!verifyPython || !dbReady)("L7 flow B", () => {
  let env: L7Env;
  let n = 1000;

  /** A model that classifies as told and answers with `program`. */
  const model = (computable: boolean, program = "result = -1", option = 1) => {
    env.setReply((body) => {
      const p = promptOf(body);
      if (p.kind === "classify") return JSON.stringify({ reason: "r", computable });
      if (p.kind === "pick") return JSON.stringify({ reason: "r", option });
      return JSON.stringify({ program });
    });
  };
  const check = (question: ImportedQuestion, opts = {}) =>
    checkQuestion(env.deps, question, { questionId: ++n, jobId: undefined }, opts);

  beforeAll(async () => {
    env = await createL7Env();
  }, 30_000);
  afterAll(async () => {
    await env?.close();
  });
  beforeEach(() => {
    env.mock.requests.length = 0;
  });

  test("C20 Verified: one option equals the result, and it's the stated answer", async () => {
    model(true);
    const r = await check(q({}));
    expect(r).toMatchObject({
      outcome: "verified",
      reason: "ok",
      computable: true,
      matchedOption: "-1",
      suggestedFix: null,
    });
    expect(r.verification).toMatchObject({
      status: "computed",
      answerSource: "stated",
      result: "-1",
      matchedOption: "-1",
    });
    expect(r.verification.program).toBe("result = -1");
  });

  test("C20 Wrong answer: sample Q7, a suggested fix and nothing applied", async () => {
    model(true);
    const question = q({ correctAnswer: "1" });
    const r = await check(question);
    expect(r).toMatchObject({ outcome: "wrong_answer", matchedOption: "-1", suggestedFix: "-1" });
    expect(r.verification.status).toBe("failed");
    expect(question.correctAnswer).toBe("1");
  });

  test("C20 No match: the result equals no option", async () => {
    model(true, "result = 100");
    const r = await check(q({}));
    expect(r).toMatchObject({ outcome: "no_match", suggestedFix: null, matchedOption: null });
    expect(r.verification.status).toBe("failed");
  });

  test("C20 Ambiguous: the result equals two options", async () => {
    model(true, "from fractions import Fraction\nresult = Fraction(1, 2)");
    const r = await check(q({ options: ["0.5", String.raw`$\frac{1}{2}$`, "3"], correctAnswer: "0.5" }));
    expect(r).toMatchObject({ outcome: "ambiguous", suggestedFix: null });
    expect(r.verification.status).toBe("failed");
  });

  test("C20 Couldn't check: the program failed", async () => {
    model(true, "result = 1/0");
    const r = await check(q({}));
    expect(r).toMatchObject({ outcome: "couldnt_check", reason: "program_failed" });
    expect(r.verification.status).toBe("unverified");
  });

  test("C20 Couldn't check: the program timed out", async () => {
    model(true, "while True:\n    pass");
    const r = await check(q({}));
    expect(r).toMatchObject({ outcome: "couldnt_check", reason: "program_timeout" });
  }, 30_000);

  test("C20 Couldn't check: an option couldn't be parsed and nothing matched", async () => {
    model(true, "result = 100");
    const r = await check(q({ options: ["5", String.raw`$\frac{$`], correctAnswer: "5" }));
    expect(r).toMatchObject({ outcome: "couldnt_check", reason: "option_unparseable" });
  });

  test("a word among the options doesn't stop the check (sample Q4's 'Undefined')", async () => {
    model(true, "result = 3");
    const r = await check(q({ options: ["3", "4", "Undefined"], correctAnswer: "3" }));
    expect(r.outcome).toBe("verified");
  });

  test("options that are all sentences aren't checked by computing, whatever the classification", async () => {
    model(true, "result = 3000", 1);
    const r = await check(q({ options: ["Total value", "Average price"], correctAnswer: "Total value" }));
    expect(r).toMatchObject({ outcome: "not_computable", computable: false });
    expect(env.mock.chatRequests().map((c) => promptOf(c.body).kind)).toEqual(["classify", "pick"]);
  });

  test("a program that picked an example n can't fail options written in n", async () => {
    model(true, "n = 5\nresult = 3 * n");
    const r = await check(q({ options: ["$3n$ flops", "$2n$ flops"], correctAnswer: "$2n$ flops" }));
    expect(r).toMatchObject({ outcome: "couldnt_check", reason: "comparison_symbolic" });
  });

  test("C20 Not computable: the model agrees: model_agreed, never a computed pass", async () => {
    model(false, "", 2);
    const r = await check(q({ options: ["A", "B"], correctAnswer: "B" }));
    expect(r).toMatchObject({ outcome: "not_computable", reason: "model_agreed", computable: false });
    expect(r.verification.status).toBe("model_agreed");
    expect(r.blind).toBeNull();
  });

  test("C20 Not computable: the model disagrees: a warn, not model_agreed", async () => {
    model(false, "", 1);
    const r = await check(q({ options: ["A", "B"], correctAnswer: "B" }));
    expect(r).toMatchObject({ outcome: "not_computable", reason: "model_disagreed" });
    expect(r.verification.status).toBe("unverified");
  });

  test("an imported computable: false flag isn't trusted: it's classified anyway", async () => {
    model(true);
    const question = importedQuestion(
      { id: 1, question: "Q", options: ["-1", "2"], correctAnswer: "-1", computable: false },
      0,
    );
    expect((await check(question)).outcome).toBe("verified");
    expect(env.mock.chatRequests().map((c) => promptOf(c.body).kind)).toEqual(["classify", "blind"]);
  });

  test("a hand-edited question keeps its classification: no classify call", async () => {
    model(true);
    await check(q({}), { knownComputable: true });
    expect(env.mock.chatRequests().map((c) => promptOf(c.body).kind)).toEqual(["blind"]);
  });

  test("multi_choice is never computable, and costs no model call", async () => {
    model(true);
    const r = await check(q({ type: "multi_choice" }));
    expect(r.outcome).toBe("not_computable");
    expect(env.mock.chatRequests()).toHaveLength(0);
  });

  test("the blind request never holds the options or the stated answer", async () => {
    model(true);
    await check(q({ options: ["11111", "-1"], correctAnswer: "-1", question: "Compute it." }));
    const blind = env.mock.chatRequests().find((c) => promptOf(c.body).kind === "blind");
    const sent = JSON.stringify(blind?.body.messages);
    expect(sent).not.toContain("11111");
    expect(sent).toContain("Compute it.");
  });

  test("C21: short answer compares with correctAnswer and acceptedAnswers", async () => {
    model(true, "from sympy import symbols\nn = symbols('n')\nresult = 2*n - 1");
    const stated = await check(q({ options: null, correctAnswer: "2n - 1", type: "short_answer" }));
    expect(stated).toMatchObject({ outcome: "verified", matchedOption: "2n - 1" });
    const accepted = await check(
      q({ options: null, correctAnswer: "n squared", acceptedAnswers: ["$2n - 1$ flops"], type: "short_answer" }),
    );
    expect(accepted).toMatchObject({ outcome: "verified", matchedOption: "$2n - 1$ flops" });
    const wrong = await check(q({ options: null, correctAnswer: "n + 1", type: "short_answer" }));
    expect(wrong).toMatchObject({ outcome: "wrong_answer", suggestedFix: "$2 n - 1$" });
  });

  test("C21: numeric compares the same way, and suggests a decimal", async () => {
    model(true, "from sympy import sqrt\nresult = sqrt(38)");
    const ok = await check(q({ options: null, correctAnswer: "6.164414002968976", type: "numeric" }));
    expect(ok.outcome).toBe("verified");
    const wrong = await check(q({ options: null, correctAnswer: "6.2", type: "numeric" }));
    expect(wrong.outcome).toBe("wrong_answer");
    expect(Number(wrong.suggestedFix)).toBeCloseTo(6.164414, 5);
  });

  test("C23: a denial on the blind program fails the question and is audited", async () => {
    model(true, "import os\nos.fork()\nresult = 1");
    const r = await check(q({}));
    expect(r).toMatchObject({ outcome: "denied", reason: "sandbox_denial" });
    expect(r.verification.status).toBe("failed");
    const audits = await env.t.db.select().from(AuditLog).where(eq(AuditLog.action, "verify.sandbox_denial"));
    expect(audits).toHaveLength(1);
  }, 30_000);

  test("C24: the run records the matched option, on the blind run", async () => {
    model(true);
    const id = ++n;
    await checkQuestion(env.deps, q({ correctAnswer: "1" }), { questionId: id });
    const [run] = await env.t.db.select().from(VerificationRun).where(eq(VerificationRun.questionId, id));
    expect(run).toMatchObject({ programKind: "blind", status: "ok", matchedOption: "-1" });
  });

  test("a question with no text is Couldn't check, and costs no call", async () => {
    model(true);
    const r = await check(importedQuestion({ id: 3 }, 2));
    expect(r).toMatchObject({ outcome: "couldnt_check", reason: "invalid_question" });
    expect(env.mock.chatRequests()).toHaveLength(0);
  });
});

describe("the proctored gate", () => {
  const computed = { status: "computed" as const };
  test("lists computable questions that aren't computed; unchecked questions count as not verified", () => {
    const result = checkProctorReady({
      questions: [
        { id: 1, computable: true, verification: computed },
        { id: 2, computable: false, verification: { status: "model_agreed" } },
        { id: 3, computable: true, verification: { status: "unverified" } },
        { id: 4, computable: true, verification: { status: "failed" } },
        { id: 5 },
      ],
    });
    expect(result.proctorReady).toBe(false);
    expect(result.blockers).toEqual([
      { questionId: 3, reason: "unverified" },
      { questionId: 4, reason: "failed" },
      { questionId: 5, reason: "not_verified" },
    ]);
  });
  test("ready when all are computed or not computable, and when the gate is off", () => {
    expect(checkProctorReady({ questions: [{ id: 1, computable: true, verification: computed }] })).toEqual({
      proctorReady: true,
      blockers: [],
    });
    expect(checkProctorReady({ questions: [{ id: 1 }] }, false).proctorReady).toBe(true);
  });
});

describe.skipIf(!verifyPython || !dbReady)("C33: l7-smoke", () => {
  let env: L7Env;
  beforeAll(async () => {
    env = await createL7Env();
  }, 30_000);
  afterAll(async () => {
    await env?.close();
  });

  /** A model that's right, from its fixtures: author programs, and the Q7 program. */
  const model = (set: L7EvalSet) => (body: Record<string, unknown>) => {
    const p = promptOf(body);
    if (p.kind === "classify") {
      const q = set.fixtures.classification.find((c) => c.question === p.question);
      return JSON.stringify({ reason: "r", computable: q?.computable ?? true });
    }
    const q = set.fixtures.questions.find((x) => x.question === p.question);
    return JSON.stringify({ program: q?.authorProgram ?? "result = -1" });
  };

  test("runs through runEval on the mock, and reports every metric", async () => {
    const set = loadEvalSet("l7-smoke");
    if (set.kind !== "l7") throw new Error("kind");
    env.setReply(model(set));
    const report = await runEval(env.deps.llm, set, {
      trials: 1,
      l7: l7Runner({ llm: env.deps.llm, verify: env.client }),
    });
    expect(report.summary).toEqual({
      trials: 1,
      blindValid: 1,
      agreement: 1,
      repairRate: 0,
      classification: 1,
      q7Outcome: 1,
    });
    for (const metric of set.metrics) expect(EVAL_METRICS).toContain(metric as never);
  }, 30_000);

  test("a wrong model shows in the numbers", async () => {
    const set = loadEvalSet("l7-smoke");
    if (set.kind !== "l7") throw new Error("kind");
    env.setReply((body) => {
      const p = promptOf(body);
      if (p.kind === "classify") return JSON.stringify({ reason: "r", computable: false });
      if (p.kind === "pick") return JSON.stringify({ reason: "r", option: 1 });
      return JSON.stringify({ program: "result = 12345" });
    });
    const report = await runEval(env.deps.llm, set, {
      trials: 1,
      l7: l7Runner({ llm: env.deps.llm, verify: env.client }),
    });
    expect(report.summary).toMatchObject({ blindValid: 1, agreement: 0, q7Outcome: 0, classification: 0.5 });
  }, 30_000);
});
