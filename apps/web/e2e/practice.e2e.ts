// P1 F4: the test-taking UI (B23–B29).
import { expect, type Page, test } from "@playwright/test";
import {
  adminRequest,
  createUser,
  expectNoAxeViolations,
  liveRegionText,
  newSignedInPage,
  PRACTICE_QUIZ,
  tabTo,
} from "./helpers.ts";

test.describe.configure({ mode: "serial" });

type Q = { id: number; question: string; type?: string; options?: string[] };
type Detail = {
  attempt: { id: string; status: string };
  questions: Q[];
  responses: { questionId: number; timeSpentMs: number; flagged: boolean; autoResult: string | null }[];
};

let page: Page;
let testId = "";
let attemptId = "";
let detail: Detail;

const byId = (id: number) => detail.questions.findIndex((q) => q.id === id);
const navigator = () => page.getByRole("navigation", { name: "Questions" });
const navButton = (i: number) => navigator().getByRole("button", { name: new RegExp(`^Question ${i + 1},`) });
async function show(id: number) {
  const i = byId(id);
  await navButton(i).click();
  await expect(page.getByRole("heading", { level: 2, name: `Question ${i + 1} of 5` })).toBeVisible();
}
/** Click an option's label, as a user does (React Aria visually hides the native input). */
async function choose(role: "radio" | "checkbox", name: string) {
  await page.locator("label", { has: page.getByRole(role, { name, exact: true }) }).click();
  await expect(page.getByRole(role, { name, exact: true })).toBeChecked();
}
async function fetchDetail(): Promise<Detail> {
  return (await (await page.request.get(`/api/v1/practice/attempts/${attemptId}`)).json()) as Detail;
}

test.beforeAll(async ({ browser }) => {
  const adminCtx = await browser.newContext();
  await adminRequest(adminCtx.request);
  const anon = await browser.newContext();
  const proctor = await createUser(adminCtx.request, anon.request, "practice", "proctor");
  page = await newSignedInPage(browser, proctor);
  const text = JSON.stringify(PRACTICE_QUIZ);
  const created = await page.request.post("/api/v1/imports", { data: { originalText: text, text } });
  expect(created.status()).toBe(200);
  testId = (await created.json()).testId;
  await Promise.all([adminCtx.close(), anon.close()]);
});
test.afterAll(async () => page?.context().close());

test("B23: Take test shows question 1 of N in the seeded order, with real radio / checkbox groups and text fields", async () => {
  await page.goto(`/tests/${testId}`);
  await page.getByRole("button", { name: "Take test" }).click();
  await expect(page).toHaveURL(/\/practice\/attempts\/[0-9a-f-]{36}$/);
  attemptId = page.url().split("/").pop() as string;
  await expect(page.getByRole("heading", { level: 2, name: "Question 1 of 5" })).toBeVisible();
  detail = await fetchDetail();

  for (const [i, q] of detail.questions.entries()) {
    if (i > 0) await page.getByRole("button", { name: "Next question" }).click();
    await expect(page.getByRole("heading", { level: 2, name: `Question ${i + 1} of 5` })).toBeVisible();
    await expect(page.getByText(q.question, { exact: true })).toBeVisible();
    const type = q.type ?? (q.options ? "single_choice" : "short_answer");
    if (type === "single_choice" || type === "true_false") {
      const group = page.getByRole("radiogroup", { name: q.question });
      await expect(group).toBeVisible();
      // DOM order is the display (shuffled) order from the server.
      expect(
        await group.getByRole("radio").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value)),
      ).toEqual(q.options as string[]);
    } else if (type === "multi_choice") {
      const group = page.getByRole("group", { name: q.question });
      expect(
        await group.getByRole("checkbox").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value)),
      ).toEqual(q.options as string[]);
    } else {
      await expect(page.getByRole("textbox", { name: /^Your answer/ })).toBeVisible();
    }
  }
  await show(detail.questions[0]?.id as number);
  await expectNoAxeViolations(page, "attempt, unanswered");
});

test("B24: checking shows correct/incorrect in text and icon, the correct answer and explanation, and announces it", async () => {
  await show(1);
  await choose("radio", "a");
  await page.getByRole("button", { name: "Check answer" }).click();
  await expect(page.getByText("Incorrect", { exact: true })).toBeVisible();
  await expect(page.getByText("Correct answer:")).toBeVisible();
  await expect(page.getByText("Because b is b.")).toBeVisible();
  await expect(page.getByText("(0 of 1 points)")).toBeVisible();
  await expect.poll(() => liveRegionText(page)).toContain("Incorrect");
  // The options are labelled in text, and the group is read-only now.
  await expect(page.getByText("Your answer", { exact: true })).toBeVisible();
  await expectNoAxeViolations(page, "attempt, after incorrect feedback");

  await show(5);
  await choose("radio", "True");
  await page.getByRole("button", { name: "Check answer" }).click();
  await expect(page.getByText("Correct", { exact: true })).toBeVisible();
  await expect.poll(() => liveRegionText(page)).toContain("Correct");
  await expectNoAxeViolations(page, "attempt, after correct feedback");

  await show(3);
  await page.getByRole("textbox", { name: /^Your answer/ }).fill("3.5");
  await page.getByRole("button", { name: "Check answer" }).click();
  await expect(page.getByText("Correct", { exact: true })).toBeVisible();
  // The server's grade is what the UI shows.
  const d = await fetchDetail();
  expect(d.responses.find((r) => r.questionId === 1)?.autoResult).toBe("incorrect");
  expect(d.responses.find((r) => r.questionId === 3)?.autoResult).toBe("correct");
});

test("B25: flag is a toggle button; the navigator shows state in text, works by keyboard and announces the position", async () => {
  await show(1);
  const flag = page.getByRole("button", { name: "Flag for review" });
  await expect(flag).toHaveAttribute("aria-pressed", "false");
  await flag.click();
  await expect(flag).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => liveRegionText(page)).toContain("Flagged for review.");
  const i1 = byId(1);
  await expect(navButton(i1)).toHaveAccessibleName(`Question ${i1 + 1}, answered, flagged for review`);
  await expect(navButton(i1)).toHaveAttribute("aria-current", "step");
  await expect(navButton(byId(4))).toHaveAccessibleName(`Question ${byId(4) + 1}, not answered`);
  await expectNoAxeViolations(page, "attempt, flagged");

  // Keyboard: Tab to another question in the navigator and press Enter.
  const target = byId(4);
  await tabTo(page, navButton(target));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 2, name: `Question ${target + 1} of 5` })).toBeFocused();
  await expect(navButton(target)).toHaveAttribute("aria-current", "step");
  await expect.poll(() => liveRegionText(page)).toContain(`Question ${target + 1} of 5`);
});

test("B26: the soft timer shows elapsed time (Intl) and keeps running; time per question reaches the server", async () => {
  const timer = page.getByRole("timer");
  await expect(timer).toHaveAttribute("aria-live", "off");
  await expect(page.getByText("Elapsed time")).toBeVisible();
  const first = await timer.textContent();
  expect(first).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  await expect.poll(async () => timer.textContent(), { timeout: 5_000 }).not.toBe(first);
  // On question 4 for a while, then away: its time is saved.
  await page.waitForTimeout(1_200);
  await show(2);
  await expect
    .poll(async () => (await fetchDetail()).responses.find((r) => r.questionId === 4)?.timeSpentMs ?? 0)
    .toBeGreaterThan(1_000);
});

test("B27: reload resumes the same attempt with checked answers, flags and an unchecked typed answer", async () => {
  await show(2);
  await page.getByRole("textbox", { name: /^Your answer/ }).fill("n minus 1");
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/practice/attempts/${attemptId}$`));
  // Resume opens the first unanswered question.
  const unanswered = detail.questions.findIndex((q) => q.id === 2 || q.id === 4);
  await expect(page.getByRole("heading", { level: 2, name: `Question ${unanswered + 1} of 5` })).toBeVisible();
  await show(2);
  await expect(page.getByRole("textbox", { name: /^Your answer/ })).toHaveValue("n minus 1");
  await show(1);
  await expect(page.getByText("Incorrect", { exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: /^a/ })).toBeChecked();
  await expect(page.getByRole("button", { name: "Flag for review" })).toHaveAttribute("aria-pressed", "true");
  await show(3);
  await expect(page.getByRole("textbox", { name: /^Your answer/ })).toHaveValue("3.5");
});

test("B29: zero axe violations at 320 px", async () => {
  await page.setViewportSize({ width: 320, height: 800 });
  await show(4);
  await expectNoAxeViolations(page, "attempt at 320 px");
  await show(1);
  await expectNoAxeViolations(page, "attempt at 320 px, with feedback");
  await page.setViewportSize({ width: 1280, height: 720 });
});

test("B28: submit with unanswered questions asks for confirmation in an accessible dialog, then shows the results", async () => {
  await page.getByRole("button", { name: "Submit attempt" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Submit this attempt?" });
  await expect(dialog).toBeVisible();
  // q4 is unanswered; q2 has a typed answer, which is saved and graded at submit.
  await expect(dialog.getByText("1 question is unanswered. It will score 0.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Keep working" })).toBeFocused();
  await expectNoAxeViolations(page, "attempt, submit dialog open");
  // Escape closes it and focus returns to the trigger.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Submit attempt" })).toBeFocused();

  await page.getByRole("button", { name: "Submit attempt" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/practice/attempts/${attemptId}/results$`));
  await expect(page.getByRole("heading", { level: 1, name: "Results: Practice e2e quiz" })).toBeVisible();
  const d = await fetchDetail();
  expect(d.attempt.status).toBe("submitted");
  expect(d.responses.find((r) => r.questionId === 2)?.autoResult).toBe("incorrect");
  // Reopening the attempt page goes to the results.
  await page.goto(`/practice/attempts/${attemptId}`);
  await expect(page).toHaveURL(new RegExp(`/practice/attempts/${attemptId}/results$`));
});
