import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Test, TestImportRecord, TestVersion } from "@gem/db";
import { IMPORT_MAX_BYTES } from "@gem/shared/contracts";
import { eq } from "drizzle-orm";
import { API, type Client, createTestApp, hasDb, registerUser, type TestApp } from "./helpers.ts";

const FIXTURE = readFileSync(
  join(import.meta.dir, "..", "..", "..", "tests", "engr108_chapter1_new_20q_quiz.json"),
  "utf8",
);
const FIXED = FIXTURE.replace('"correctAnswer": "1"', '"correctAnswer": "-1"');

/** Model-style output: prose, a fenced block, trailing commas, letter answers (P0.md A24). */
const MODEL_STYLE = `Sure! Here's a short quiz on inner products.

\`\`\`json
{
  "quizTitle": "Inner products",
  "questions": [
    { "question_number": 1, "topic": "Inner product", "question": "What is $x^T y$ for $x = (1, 2)$, $y = (3, 4)$?",
      "choices": ["A) 10", "B) 11", "C) 12",], "answer": "B", },
    { "question_number": 2, "topic": "Inner product", "question": "Is $x^T y = y^T x$?",
      "choices": ["A) Always", "B) Never"], "answer": "a" },
  ],
}
\`\`\`
Let me know if you want more!`;

describe.skipIf(!hasDb)("imports, tests and export", () => {
  let t: TestApp;
  let proctor: Client;

  beforeAll(async () => {
    t = await createTestApp();
    const admin = (await registerUser(t.app, "admin@example.com")).client;
    const p = await registerUser(t.app, "proctor@example.com");
    await admin.put(`${API}/admin/users/${p.user.id}/roles`, { role: "proctor" });
    proctor = p.client;
  });
  afterAll(async () => t?.close());

  test("preview of the fixture reports the Q7 error, blocks saving and saves nothing", async () => {
    const res = await proctor.post(`${API}/imports/preview`, { text: FIXTURE, filename: "engr108.json" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.report.canSave).toBe(false);
    expect(body.report.errors).toEqual([
      {
        severity: "error",
        code: "answer_not_in_options",
        path: ["questions", 6, "correctAnswer"],
        params: { id: 7, answer: "1" },
      },
    ]);
    expect(body.quiz).toBeNull();
    expect(body.normalizedText).toContain('"correctAnswer": "1"');
    expect(await t.db.select().from(Test)).toHaveLength(0);
    const save = await proctor.post(`${API}/imports`, { originalText: FIXTURE, text: FIXTURE });
    expect(save.statusCode).toBe(422);
    expect(save.json().code).toBe("import_invalid_quiz");
  });

  test("A24 (API): model-style text previews and lists every applied fix", async () => {
    const body = (await proctor.post(`${API}/imports/preview`, { text: MODEL_STYLE })).json();
    expect(body.report.canSave).toBe(true);
    const codes = body.report.fixes.map((f: { code: string }) => f.code);
    for (const c of [
      "extracted_json",
      "tolerant_parse",
      "key_alias",
      "option_prefix_stripped",
      "answer_letter_resolved",
      "total_questions_recomputed",
      "type_inferred",
    ]) {
      expect(codes).toContain(c);
    }
    expect(body.quiz.questions.map((q: { correctAnswer: string }) => q.correctAnswer)).toEqual(["11", "Always"]);
  });

  test("A25: a saved import creates Test + TestVersion + TestImportRecord with the raw text and report", async () => {
    const res = await proctor.post(`${API}/imports`, { originalText: FIXTURE, text: FIXED, filename: "engr108.json" });
    expect(res.statusCode).toBe(200);
    const { testId, versionId } = res.json();
    const [test] = await t.db.select().from(Test).where(eq(Test.id, testId));
    expect(test?.title).toBe("Stanford ENGR108 Chapter 1 Practice Quiz (Set 2)");
    const [version] = await t.db.select().from(TestVersion).where(eq(TestVersion.id, versionId));
    expect(version).toMatchObject({ testId, versionNumber: 1, provenance: null });
    expect((version?.content as { questions: unknown[] } | undefined)?.questions).toHaveLength(20);
    const [record] = await t.db.select().from(TestImportRecord).where(eq(TestImportRecord.testVersionId, versionId));
    expect(record?.sourceRaw).toBe(FIXTURE);
    expect(record?.originalFilename).toBe("engr108.json");
    expect(record?.report).toMatchObject({ canSave: true, errors: [], questionCount: 20 });
  });

  test("A9 (API): import → export → re-import → export is byte-for-byte equal; base names kept", async () => {
    const first = (await proctor.post(`${API}/imports`, { originalText: FIXED, text: FIXED })).json();
    const exp1 = await proctor.get(`${API}/tests/${first.testId}/export`);
    expect(exp1.statusCode).toBe(200);
    expect(exp1.headers["content-disposition"]).toContain("attachment");
    const second = (await proctor.post(`${API}/imports`, { originalText: exp1.body, text: exp1.body })).json();
    const exp2 = await proctor.get(`${API}/tests/${second.testId}/export`);
    expect(exp2.body).toBe(exp1.body);
    const parsed = JSON.parse(exp1.body);
    for (const k of ["quiz_title", "course", "chapter", "total_questions", "topics_covered", "questions"])
      expect(parsed).toHaveProperty(k);
    for (const k of ["id", "topic", "question", "options", "correctAnswer"])
      expect(parsed.questions[0]).toHaveProperty(k);
    expect(parsed.questions[6].correctAnswer).toBe("-1");
  });

  test("tests list, detail, versions, archive", async () => {
    const list = (await proctor.get(`${API}/tests`)).json().tests;
    expect(list.length).toBe(3);
    const id = list[0].id;
    const detail = (await proctor.get(`${API}/tests/${id}`)).json();
    expect(detail.content.questions).toHaveLength(20);
    expect(detail.version).toMatchObject({ versionNumber: 1, imported: true });
    expect((await proctor.get(`${API}/tests/${id}/versions`)).json().versions).toHaveLength(1);
    const patched = (
      await proctor.patch(`${API}/tests/${id}`, { title: "Renamed", tags: ["ch1", "ch1", "vectors"], archived: true })
    ).json();
    expect(patched.test).toMatchObject({ title: "Renamed", tags: ["ch1", "vectors"] });
    expect(patched.test.archivedAt).not.toBeNull();
    expect((await proctor.get(`${API}/tests`)).json().tests).toHaveLength(2);
    expect((await proctor.get(`${API}/tests?archived=only`)).json().tests).toHaveLength(1);
    await proctor.patch(`${API}/tests/${id}`, { archived: false });
    expect((await proctor.get(`${API}/tests`)).json().tests).toHaveLength(3);
    expect((await proctor.patch(`${API}/tests/${id}`, {})).json().code).toBe("validation_failed");
  });

  test("preview accepts a multipart file upload", async () => {
    const boundary = "----gemboundary";
    const payload =
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="quiz.json"\r\nContent-Type: application/json\r\n\r\n` +
      `${FIXED}\r\n--${boundary}--\r\n`;
    const res = await proctor.request({
      method: "POST",
      url: `${API}/imports/preview`,
      payload,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().report.canSave).toBe(true);
  });

  test("size limit and empty input return error codes", async () => {
    const big = "x".repeat(IMPORT_MAX_BYTES + 1);
    const res = await proctor.post(`${API}/imports/preview`, { text: big });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ code: "import_too_large", params: { maxBytes: IMPORT_MAX_BYTES } });
    expect((await proctor.post(`${API}/imports/preview`, { text: "  " })).json().code).toBe("import_empty");
    const garbage = (await proctor.post(`${API}/imports/preview`, { text: "not json at all" })).json();
    expect(garbage.report.errors[0].code).toBe("parse_failed");
    expect(garbage.normalizedText).toBeNull();
  });

  test("JSON schema endpoints are public and generated from the shared models", async () => {
    const quiz = await t.app.inject({ method: "GET", url: `${API}/schema/quiz.json` });
    expect(quiz.statusCode).toBe(200);
    expect(quiz.json().$id).toContain("quiz.json");
    const result = await t.app.inject({ method: "GET", url: `${API}/schema/result.json` });
    expect(result.json().properties).toHaveProperty("score");
  });

  test("validation and unknown routes return { code, params }", async () => {
    const bad = await proctor.post(`${API}/imports/preview`, { nope: 1 });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("validation_failed");
    const missing = await proctor.get(`${API}/nope`);
    expect(missing.json()).toEqual({ code: "route_not_found", params: {} });
  });
});
