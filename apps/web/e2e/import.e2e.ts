// A23–A26, A29, A32: the import flow in the browser.
import { expect, type Page, test } from "@playwright/test";
import { adminRequest, createUser, FIXED, FIXTURE_PATH, liveRegionText, newSignedInPage } from "./helpers.ts";

const MODEL_STYLE = `Sure! Here is a short quiz.

\`\`\`json
{
  "quizTitle": "Inner products (model)",
  "questions": [
    { "question_number": 1, "topic": "Inner product", "question": "What is $x^T y$ for $x = (1, 2)$, $y = (3, 4)$?",
      "choices": ["A) 10", "B) 11", "C) 12",], "answer": "B", },
    { "question_number": 2, "topic": "Inner product", "question": "Is $x^T y = y^T x$?",
      "choices": ["A) Always", "B) Never"], "answer": "a" },
  ],
}
\`\`\`
Hope this helps!`;

let proctorEmail = "";

test.beforeAll(async ({ browser }) => {
  const adminCtx = await browser.newContext();
  await adminRequest(adminCtx.request);
  const anon = await browser.newContext();
  proctorEmail = await createUser(adminCtx.request, anon.request, "importer", "proctor");
  await Promise.all([adminCtx.close(), anon.close()]);
});

async function upload(page: Page, path: string) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Upload a .json file" }).click();
  await (await chooser).setFiles(path);
}

test("A23 + A32: the fixture shows the Q7 error and blocks saving; fixing Q7 and re-running allows saving", async ({
  browser,
}) => {
  const page = await newSignedInPage(browser, proctorEmail);
  await page.goto("/import");
  await upload(page, FIXTURE_PATH);
  const report = page.locator("section", { has: page.getByRole("heading", { name: "2. Report" }) });
  await expect(report.getByText("1 error must be fixed before saving.")).toBeVisible();
  await expect(report.getByText("Question 7, correctAnswer")).toBeVisible();
  await expect(report.getByText("The correct answer “1” is not one of the options.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save as a test" })).toBeDisabled();
  await expect.poll(() => liveRegionText(page)).toContain("Preview finished: 1 errors");

  const editor = page.getByLabel("Quiz JSON");
  const text = await editor.inputValue();
  expect(text).toContain('"correctAnswer": "1"');
  await editor.fill(text.replace('"correctAnswer": "1"', '"correctAnswer": "-1"'));
  await expect(page.getByText("You changed the JSON. Run the preview again before saving.")).toBeVisible();
  await page.getByRole("button", { name: "Run preview again" }).click();
  await expect(report.getByText("No errors: the quiz can be saved.")).toBeVisible();
  await expect.poll(() => liveRegionText(page)).toContain("The quiz can be saved.");

  // A25 through the UI: save → test detail.
  await page.getByRole("button", { name: "Save as a test" }).click();
  await expect(page).toHaveURL(/\/tests\/[0-9a-f-]{36}$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Stanford ENGR108 Chapter 1 Practice Quiz (Set 2)" }),
  ).toBeVisible();
  await expect.poll(() => liveRegionText(page)).toContain("Quiz saved as a test.");
  await expect(page.getByRole("status").getByText("Quiz saved as a test.")).toBeVisible();
  await page.context().close();
});

test("A24: pasted model-style text previews successfully and lists every applied fix", async ({ browser }) => {
  const page = await newSignedInPage(browser, proctorEmail);
  await page.goto("/import");
  await page.getByLabel("Or paste the quiz text").fill(MODEL_STYLE);
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByText("No errors: the quiz can be saved.")).toBeVisible();
  const fixes = page.locator("details", { hasText: "automatic fix" });
  await expect(fixes).toHaveAttribute("open", "");
  for (const text of [
    "Took the JSON out of the surrounding text or code fence.",
    "Read JSON with small syntax errors",
    "Renamed the field “quizTitle” to “quiz_title”.",
    "Renamed the field “choices” to “options”.",
    "Renamed the field “answer” to “correctAnswer”.",
    "Removed letter prefixes such as “A)” from the options.",
    "Answer “B” was a letter: it is now the option “11”.",
    "Answer “a” was a letter: it is now the option “Always”.",
    "Set total_questions to 2",
  ]) {
    await expect(fixes.getByText(text).first()).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Save as a test" })).toBeEnabled();
  await page.context().close();
});

test("A26 + A29: test detail renders LaTeX with MathML; dates go through Intl", async ({ browser }) => {
  const page = await newSignedInPage(browser, proctorEmail);
  const created = await page.request.post("/api/v1/imports", { data: { originalText: FIXED, text: FIXED } });
  const { testId } = await created.json();
  await page.goto(`/tests/${testId}`);
  const q1 = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: /^Question 1\b/ }) });
  await expect(q1.locator(".katex").first()).toBeVisible();
  // MathML is in the DOM, with the LaTeX source kept as an annotation.
  expect(await page.locator("math").count()).toBeGreaterThan(20);
  const tex = page.locator('annotation[encoding="application/x-tex"]');
  await expect(tex.first()).toHaveText("z");
  await expect(tex.filter({ hasText: "\\begin{bmatrix}" }).first()).toBeAttached();
  // The correct answer is labelled in text, not only by colour.
  await expect(q1.getByText("Correct answer")).toBeVisible();

  const expected = await page.evaluate(() => new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date()));
  await expect(page.locator("dd").filter({ hasText: expected }).first()).toBeVisible();
  await page.goto("/tests");
  await expect(page.getByRole("cell", { name: expected }).first()).toBeVisible();
  await page.context().close();
});
