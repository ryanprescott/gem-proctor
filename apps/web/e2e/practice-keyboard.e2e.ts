// P1 B36: keyboard only — sign in → test detail → Take test → answer and check every question (one short
// answer wrong) → flag one → submit → "I was right" → Retake missed → finish → export.
import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import {
  adminRequest,
  createUser,
  liveRegionText,
  newSignedInPage,
  PASSWORD,
  PRACTICE_QUIZ,
  tabTo,
} from "./helpers.ts";

let proctorEmail = "";

test.beforeAll(async ({ browser }) => {
  const adminCtx = await browser.newContext();
  await adminRequest(adminCtx.request);
  const anon = await browser.newContext();
  proctorEmail = await createUser(adminCtx.request, anon.request, "practicekeys", "proctor");
  const proctor = await newSignedInPage(browser, proctorEmail);
  const text = JSON.stringify(PRACTICE_QUIZ);
  expect((await proctor.request.post("/api/v1/imports", { data: { originalText: text, text } })).status()).toBe(200);
  await Promise.all([adminCtx.close(), anon.close(), proctor.context().close()]);
});

type Q = { id: number; type?: string; options?: string[] };

/** The answers given: q2 (short answer) wrong, q4 (multi choice) half right, the rest right. */
const ANSWERS: Record<number, string | string[]> = { 1: "b", 2: "n minus 1", 3: "3.5", 4: ["e"], 5: "True" };

async function answerByKeyboard(page: Page, q: Q, answer: string | string[]) {
  const type = q.type ?? (q.options ? "single_choice" : "short_answer");
  if (type === "single_choice" || type === "true_false") {
    // Tab into the radio group, select the first option with Space, then arrow to the answer.
    await tabTo(page, page.getByRole("radio").first());
    await page.keyboard.press("Space");
    const target = (q.options ?? []).indexOf(answer as string);
    for (let i = 0; i < target; i++) await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("radio", { name: answer as string, exact: true })).toBeChecked();
  } else if (type === "multi_choice") {
    for (const a of answer as string[]) {
      await tabTo(page, page.getByRole("checkbox", { name: a, exact: true }));
      await page.keyboard.press("Space");
      await expect(page.getByRole("checkbox", { name: a, exact: true })).toBeChecked();
    }
  } else {
    await tabTo(page, page.getByRole("textbox", { name: /^Your answer/ }));
    await page.keyboard.type(answer as string);
  }
  await tabTo(page, page.getByRole("button", { name: "Check answer" }));
  await page.keyboard.press("Enter");
}

async function submitByKeyboard(page: Page) {
  await tabTo(page, page.getByRole("button", { name: "Submit attempt" }));
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByRole("button", { name: "Keep working" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Submit", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/results$/);
}

test("B36: keyboard-only practice flow", async ({ page }) => {
  await page.goto("/sign-in");
  await tabTo(page, page.getByLabel("Email"));
  await page.keyboard.type(proctorEmail);
  await page.keyboard.press("Tab");
  await page.keyboard.type(PASSWORD);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: /^Welcome/ })).toBeVisible();

  // Tests → the test → Take test.
  await tabTo(page, page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Tests" }));
  await page.keyboard.press("Enter");
  await tabTo(page, page.getByRole("link", { name: "Practice e2e quiz" }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Practice e2e quiz" })).toBeVisible();
  await tabTo(page, page.getByRole("button", { name: "Take test" }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 2, name: "Question 1 of 5" })).toBeVisible();
  const attemptId = page.url().split("/").pop() as string;
  const detail = (await (await page.request.get(`/api/v1/practice/attempts/${attemptId}`)).json()) as {
    questions: Q[];
  };

  // Answer and check every question in display order; flag the first one.
  for (const [i, q] of detail.questions.entries()) {
    await expect(page.getByRole("heading", { level: 2, name: `Question ${i + 1} of 5` })).toBeVisible();
    await answerByKeyboard(page, q, ANSWERS[q.id] as string | string[]);
    const expected = q.id === 2 ? "Incorrect" : q.id === 4 ? "Partly correct" : "Correct";
    await expect(page.getByText(expected, { exact: true })).toBeVisible();
    await expect.poll(() => liveRegionText(page)).toContain(expected);
    if (i === 0) {
      await tabTo(page, page.getByRole("button", { name: "Flag for review" }));
      await page.keyboard.press("Space");
      await expect(page.getByRole("button", { name: "Flag for review" })).toHaveAttribute("aria-pressed", "true");
    }
    if (i < detail.questions.length - 1) {
      await tabTo(page, page.getByRole("button", { name: "Next question" }));
      await page.keyboard.press("Enter");
    }
  }
  await submitByKeyboard(page);
  await expect(page.getByTestId("results-score")).toHaveText("3.5 of 6 points (58.3%)");

  // "I was right" on the short answer.
  await tabTo(page, page.getByRole("button", { name: "I was right" }));
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("results-score")).toHaveText("5.5 of 6 points (91.7%)");
  await expect.poll(() => liveRegionText(page)).toContain("Marked as right (self-graded).");

  // Retake missed: only the half-right multi-choice question.
  await tabTo(page, page.getByRole("button", { name: "Retake missed (1 question)" }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 2, name: "Question 1 of 1" })).toBeVisible();
  await answerByKeyboard(page, detail.questions.find((q) => q.id === 4) as Q, ["e", "i"]);
  await expect(page.getByText("Correct", { exact: true })).toBeVisible();
  await submitByKeyboard(page);
  await expect(page.getByTestId("results-score")).toHaveText("1 of 1 points (100%)");

  // Export with Enter on the link.
  await tabTo(page, page.getByRole("link", { name: "Export result (JSON)" }));
  const download = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  const result = JSON.parse(readFileSync(await (await download).path(), "utf8"));
  expect(result).toMatchObject({ mode: "practice", total_questions: 1, score: 1, percentage: 100 });
  expect(result.questions.map((q: { id: number }) => q.id)).toEqual([4]);
  expect(result.questions[0]).toMatchObject({ userAnswers: ["e", "i"], userIsCorrect: true });
});
