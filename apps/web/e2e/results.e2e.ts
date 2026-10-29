// P1 F5: results, retake and history (B30–B35), and the home page entries.
import { readFileSync } from "node:fs";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import {
  adminRequest,
  createUser,
  expectNoAxeViolations,
  liveRegionText,
  newSignedInPage,
  PRACTICE_QUIZ,
} from "./helpers.ts";

test.describe.configure({ mode: "serial" });

let page: Page;
let studentEmail = "";
let testId = "";
let attemptId = "";

type Summary = { id: string; status: string; startedAt: string; score: number | null; durationMs: number | null };

async function call(request: APIRequestContext, method: "post" | "put" | "get", url: string, data?: unknown) {
  const res = await request[method](`/api/v1${url}`, data === undefined ? {} : { data });
  expect(res.status(), `${method} ${url}: ${await res.text()}`).toBe(200);
  return res.json();
}

const dateTime = (iso: string) =>
  new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

test.beforeAll(async ({ browser }) => {
  const adminCtx = await browser.newContext();
  await adminRequest(adminCtx.request);
  const anon = await browser.newContext();
  const proctor = await createUser(adminCtx.request, anon.request, "results", "proctor");
  const anon2 = await browser.newContext();
  studentEmail = await createUser(adminCtx.request, anon2.request, "resultsstudent", "student");
  page = await newSignedInPage(browser, proctor);
  const text = JSON.stringify(PRACTICE_QUIZ);
  testId = (await call(page.request, "post", "/imports", { originalText: text, text })).testId;
  // Known answers: q1 right, q2 (short) wrong, q3 wrong, q4 half right, q5 unanswered → 1.5 of 6.
  attemptId = (await call(page.request, "post", "/practice/attempts", { testId, kind: "full" })).attempt.id;
  const answers: [number, string | string[]][] = [
    [1, "b"],
    [2, "n minus 1"],
    [3, "4"],
    [4, ["e"]],
  ];
  for (const [q, answer] of answers) {
    await call(page.request, "put", `/practice/attempts/${attemptId}/responses/${q}`, { answer, check: true });
  }
  await call(page.request, "post", `/practice/attempts/${attemptId}/submit`);
  await Promise.all([adminCtx.close(), anon.close(), anon2.close()]);
});
test.afterAll(async () => page?.context().close());

test("B30: results show score, percentage, time, and each question with answers, explanation, evidence and points", async () => {
  await page.goto(`/practice/attempts/${attemptId}/results`);
  await expect(page.getByRole("heading", { level: 1, name: "Results: Practice e2e quiz" })).toBeVisible();
  await expect(page.getByTestId("results-score")).toHaveText("1.5 of 6 points (25%)");
  await expect(page.getByText("Time taken")).toBeVisible();
  const items = page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 3 }) });
  await expect(items).toHaveCount(5);
  // The test's own order.
  const q1 = items.nth(0);
  await expect(q1.getByRole("heading", { name: "Question 1 of 5" })).toBeVisible();
  await expect(q1.getByText("Which letter is b?")).toBeVisible();
  await expect(q1.getByText("Your answer:")).toBeVisible();
  await expect(q1.getByText("Correct", { exact: true })).toBeVisible();
  await expect(q1.getByText("(1 of 1 points)")).toBeVisible();
  await expect(q1.getByText("Because b is b.")).toBeVisible();
  const q4 = items.nth(3);
  await expect(q4.getByText("Partly correct")).toBeVisible();
  await expect(q4.getByText("(0.5 of 1 points)")).toBeVisible();
  await expect(q4.getByText("Correct answers:")).toBeVisible();
  const q5 = items.nth(4);
  await expect(q5.getByText("Not answered")).toBeVisible();
  await expect(q5.getByText("From the source:")).toBeVisible();
  await expect(q5.locator("blockquote")).toHaveText("The empty set is a subset of every set.");
  await expectNoAxeViolations(page, "results");
});

test("B31: the per-topic breakdown matches the stored grades", async () => {
  const table = page.getByRole("table", { name: /by question topic/ });
  const rows = await table
    .locator("tbody tr")
    .evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll("th, td")].map((c) => c.textContent?.trim())));
  expect(rows).toEqual([
    ["Vectors", "1 of 2", "1 of 2"],
    ["Complexity", "0 of 2", "0.5 of 3"],
    ["Sets", "0 of 1", "0 of 1"],
  ]);
  await expect(page.getByText("Topics covered:")).toBeVisible();
});

test("B32: “I was right” updates the score on screen and in history, shows self-graded, announces, and can be undone", async () => {
  const q2 = page.getByRole("listitem").filter({ hasText: "How many flops" });
  await q2.getByRole("button", { name: "I was right" }).click();
  await expect(page.getByTestId("results-score")).toHaveText("3.5 of 6 points (58.3%)");
  await expect(q2.getByText("Self-graded: you marked this answer as right.")).toBeVisible();
  await expect.poll(() => liveRegionText(page)).toContain("Marked as right (self-graded). Score: 3.5 of 6.");
  const table = page.getByRole("table", { name: /by question topic/ });
  await expect(table.getByRole("row", { name: /Complexity/ })).toContainText("2.5 of 3");

  await q2.getByRole("button", { name: "Undo “I was right”" }).click();
  await expect(page.getByTestId("results-score")).toHaveText("1.5 of 6 points (25%)");
  await expect.poll(() => liveRegionText(page)).toContain("Self-grade undone.");
  await q2.getByRole("button", { name: "I was right" }).click();
  await expect(page.getByTestId("results-score")).toHaveText("3.5 of 6 points (58.3%)");

  await page.goto(`/tests/${testId}`);
  const history = page.getByRole("table", { name: /attempt/ });
  await expect(history.getByRole("row").nth(1)).toContainText("3.5 of 6 (58.3%)");
});

test("B34: Export downloads a Result whose contents match the screen", async () => {
  await page.goto(`/practice/attempts/${attemptId}/results`);
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Export result (JSON)" }).click();
  const file = await (await download).path();
  const result = JSON.parse(readFileSync(file, "utf8"));
  expect(result).toMatchObject({ score: 3.5, maxScore: 6, percentage: 58.33, mode: "practice", attemptId });
  await expect(page.getByTestId("results-score")).toHaveText("3.5 of 6 points (58.3%)");
  expect(result.questions.map((q: { id: number }) => q.id)).toEqual([1, 2, 3, 4, 5]);
  const items = page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 3 }) });
  for (const [i, q] of (result.questions as { userAnswer: string; userIsCorrect: boolean }[]).entries()) {
    const item = items.nth(i);
    if (q.userAnswer === "") await expect(item.getByText("Not answered")).toBeVisible();
    else await expect(item).toContainText(q.userAnswer);
    await expect(
      item.getByText(q.userIsCorrect ? "Correct" : /^(Incorrect|Partly correct)$/, { exact: true }),
    ).toBeVisible();
  }
  expect(result.questions[1]).toMatchObject({ selfGraded: true, userIsCorrect: true });
});

test("B33: Retake missed starts exactly the missed questions; disabled when nothing was missed; Retake starts a full attempt", async () => {
  await page.getByRole("button", { name: "Retake missed (3 questions)" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Question 1 of 3" })).toBeVisible();
  const retakeId = page.url().split("/").pop() as string;
  const detail = await call(page.request, "get", `/practice/attempts/${retakeId}`);
  expect(detail.attempt.kind).toBe("retake_missed");
  expect([...detail.quizOrder]).toEqual([3, 4, 5]); // q2 was self-graded right
  for (const [q, answer] of [
    [3, "3.5"],
    [4, ["i", "e"]],
    [5, "True"],
  ] as const) {
    await call(page.request, "put", `/practice/attempts/${retakeId}/responses/${q}`, { answer, check: true });
  }
  await call(page.request, "post", `/practice/attempts/${retakeId}/submit`);
  await page.goto(`/practice/attempts/${retakeId}/results`);
  await expect(page.getByTestId("results-score")).toHaveText("3 of 3 points (100%)");
  await expect(page.getByRole("button", { name: "Retake missed (nothing missed)" })).toBeDisabled();
  await page.getByRole("button", { name: "Retake", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Question 1 of 5" })).toBeVisible();
});

test("B35: history lists attempts with score, date and duration, links to results, and Resume / Discard", async () => {
  await page.goto(`/tests/${testId}`);
  const { attempts } = (await call(page.request, "get", `/practice/attempts?testId=${testId}`)) as {
    attempts: Summary[];
  };
  expect(attempts.map((a) => a.status)).toEqual(["in_progress", "submitted", "submitted"]);
  const history = page.getByRole("table", { name: "3 attempts, newest first" });
  const rows = history.locator("tbody tr");
  await expect(rows).toHaveCount(3);
  const [inProgress, retake, first] = attempts as [Summary, Summary, Summary];
  await expect(rows.nth(0)).toContainText(dateTime(inProgress.startedAt));
  await expect(rows.nth(0)).toContainText("In progress");
  await expect(
    rows.nth(0).getByRole("link", { name: `Resume attempt of ${dateTime(inProgress.startedAt)}` }),
  ).toBeVisible();
  await expect(rows.nth(1)).toContainText("Retake missed (3 questions)");
  await expect(rows.nth(1)).toContainText("3 of 3 (100%)");
  await expect(rows.nth(2)).toContainText("3.5 of 6 (58.3%)");
  await expect(rows.nth(2)).toContainText(/\d+ sec|\d+ min/);
  expect(first.durationMs).not.toBeNull();
  await expect(rows.nth(1).getByRole("link", { name: `Results of ${dateTime(retake.startedAt)}` })).toHaveAttribute(
    "href",
    `/practice/attempts/${retake.id}/results`,
  );
  await expect(page.getByRole("link", { name: "Resume", exact: true })).toBeVisible();
  await expectNoAxeViolations(page, "test detail with history");

  await page.getByRole("button", { name: "Discard attempt" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Discard this attempt?" });
  await expect(dialog).toBeVisible();
  await expectNoAxeViolations(page, "test detail, discard dialog");
  await dialog.getByRole("button", { name: "Discard", exact: true }).click();
  await expect.poll(() => liveRegionText(page)).toContain("Attempt discarded.");
  await expect(page.getByRole("table", { name: "2 attempts, newest first" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Discard attempt" })).toHaveCount(0);
});

test("home: proctors see their recent attempts; students are told practice tests come from proctors", async ({
  browser,
}) => {
  await page.goto("/");
  const recent = page
    .getByRole("region", { name: "Recent practice" })
    .or(page.locator("section", { hasText: "Recent practice" }));
  await expect(recent.getByRole("link", { name: "Practice e2e quiz" })).toHaveCount(2);
  await expect(recent).toContainText("3 of 3 (100%)");
  await expectNoAxeViolations(page, "proctor home with recent attempts");
  const student = await newSignedInPage(browser, studentEmail);
  await student.goto("/");
  await expect(student.getByText("Practice tests appear here once a proctor shares one with you.")).toBeVisible();
  await expect(student.getByText("Recent practice")).toHaveCount(0);
  await student.context().close();
});
