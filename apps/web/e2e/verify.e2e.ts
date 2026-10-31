// C28, C30–C32: Verify answers on the import page, against the real API and sandbox, with a mock model that
// replays what the reference model wrote for the fixture (scripts/e2e.ts).
import { expect, type Page, test } from "@playwright/test";
import {
  createUser,
  expectNoAxeViolations,
  FIXED,
  FIXTURE,
  liveRegionText,
  newSignedInPage,
  PASSWORD,
  tabTo,
} from "./helpers.ts";

test.describe.configure({ mode: "serial" });

const llmUrl = () => process.env.E2E_LLM_URL as string;
const HOSTILE = JSON.stringify({
  quiz_title: "Hostile result",
  total_questions: 1,
  questions: [{ id: 1, topic: "t", question: "HOSTILE: what is it?", correctAnswer: "1" }],
});

let proctorEmail = "";
let adminEmail = "";
let adminPassword = "";
let endpointId = "";

const assign = () =>
  ({
    endpointId,
    model: "mock-chat",
    capabilities: { structuredOutput: "native_schema", contextWindow: 32_768, maxOutputTokens: 1024 },
  }) as const;

const baseURL = () => process.env.E2E_BASE_URL as string;

test.beforeAll(async ({ playwright }) => {
  adminEmail = process.env.E2E_ADMIN_EMAIL as string;
  adminPassword = process.env.E2E_ADMIN_PASSWORD as string;
  const request = await playwright.request.newContext({ baseURL: baseURL() });
  const anon = await playwright.request.newContext({ baseURL: baseURL() });
  await request.post("/api/v1/auth/login", { data: { email: adminEmail, password: adminPassword } });
  proctorEmail = await createUser(request, anon, "verifier", "proctor");
  const created = await request.post("/api/v1/admin/llm/endpoints", {
    data: {
      label: "Verify mock",
      provider: "openai-compatible",
      baseUrl: llmUrl(),
      location: "local",
      server: "ollama",
    },
  });
  expect(created.status(), await created.text()).toBe(200);
  endpointId = (await created.json()).endpoint.id;
  await request.dispose();
  await anon.dispose();
});

test.afterAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL: baseURL() });
  await request.post("/api/v1/auth/login", { data: { email: adminEmail, password: adminPassword } });
  await request.delete("/api/v1/admin/llm/roles/verify.solve");
  await request.delete(`/api/v1/admin/llm/endpoints/${endpointId}`);
  await request.dispose();
});

async function openImport(page: Page, text = FIXTURE) {
  await page.goto("/import");
  await page.getByLabel("Or paste the quiz text").fill(text);
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByRole("heading", { name: "2. Report" })).toBeVisible();
}

test("C28 no verify.solve: the button is disabled, the page says why, and a clean quiz still saves", async ({
  browser,
}) => {
  const page = await newSignedInPage(browser, proctorEmail, PASSWORD);
  await openImport(page);
  await expect(page.getByRole("button", { name: "Verify answers" })).toBeDisabled();
  await expect(page.getByText("none is assigned")).toBeVisible();
  await expectNoAxeViolations(page, "/import verify unassigned");
  await openImport(page, FIXED);
  await page.getByRole("button", { name: "Save as a test" }).click();
  await expect(page).toHaveURL(/\/tests\//);
  await expect(page.getByText("Not ready")).toBeVisible();
  await page.context().close();
});

test("C31 C32 verify → progress announced → Q7 badge in text and icon → Accept fix → save", async ({
  browser,
  playwright,
}) => {
  const request = await playwright.request.newContext({ baseURL: baseURL() });
  await request.post("/api/v1/auth/login", { data: { email: adminEmail, password: adminPassword } });
  const put = await request.put("/api/v1/admin/llm/roles/verify.solve", { data: assign() });
  expect(put.status(), await put.text()).toBe(200);
  await request.dispose();

  const page = await newSignedInPage(browser, proctorEmail, PASSWORD);
  await openImport(page);
  await expect(page.getByRole("button", { name: "Save as a test" })).toBeDisabled();
  await page.getByRole("button", { name: "Verify answers" }).click();
  await expect.poll(() => liveRegionText(page)).toMatch(/of 20 questions checked|Verification started/);
  await expectNoAxeViolations(page, "/import verifying");

  const q7 = page.getByRole("listitem").filter({ hasText: "Accept fix for question 7" });
  await expect(q7).toBeVisible({ timeout: 60_000 });
  await expect(q7.getByText("Wrong answer")).toBeVisible();
  await expect(q7.getByText("✕")).toBeVisible();
  await expect(q7.getByText("Suggested answer:")).toBeVisible();
  await expect.poll(() => liveRegionText(page), { timeout: 60_000 }).toContain("Verification finished: 20 questions");

  const verified = page.getByRole("listitem").filter({ hasText: "Verified" }).first();
  await expect(verified).toBeVisible();
  await page.getByText("Check program and result for question 7").click();
  await expect(q7.locator("pre")).toContainText("result");
  await expectNoAxeViolations(page, "/import verified");

  await expect(page.getByRole("button", { name: "Save as a test" })).toBeDisabled();
  await q7.getByRole("button", { name: "Keep mine for question 7" }).click();
  await expect(q7.getByText("You kept your answer")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save as a test" })).toBeDisabled();
  await q7.getByRole("button", { name: "Accept fix for question 7" }).click();
  await expect(q7.getByText("Fix accepted")).toBeVisible();

  await page.setViewportSize({ width: 320, height: 800 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expectNoAxeViolations(page, "/import verified 320px");
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.getByRole("button", { name: "Save as a test" }).click();
  await expect(page).toHaveURL(/\/tests\//);
  await expect(page.getByText("Proctored use")).toBeVisible();
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  await expect(page.getByText("Verification: Computed").first()).toBeVisible();
  await expect(page.getByText("Verification: Model agreed").first()).toBeVisible();
  await expectNoAxeViolations(page, "test detail with verification");
  await page.context().close();
});

test("C31 keyboard: Verify answers and a disclosure work without a pointer", async ({ browser }) => {
  const page = await newSignedInPage(browser, proctorEmail, PASSWORD);
  await openImport(page, HOSTILE);
  const run = page.getByRole("button", { name: "Verify answers" });
  await tabTo(page, run);
  await page.keyboard.press("Enter");
  const summary = page.getByText("Check program and result for question 1");
  await expect(summary).toBeVisible({ timeout: 30_000 });
  await tabTo(page, page.locator("summary").filter({ hasText: "Check program and result for question 1" }));
  await page.keyboard.press("Enter");
  await expect(page.locator("pre").filter({ hasText: "Symbol" })).toBeVisible();
  await page.context().close();
});

test("C31 a hostile result renders inertly: as text, no element, no link, no script", async ({ browser }) => {
  const page = await newSignedInPage(browser, proctorEmail, PASSWORD);
  let dialogs = 0;
  page.on("dialog", (d) => {
    dialogs += 1;
    void d.dismiss();
  });
  await openImport(page, HOSTILE);
  await page.getByRole("button", { name: "Verify answers" }).click();
  await page.getByText("Check program and result for question 1").click({ timeout: 30_000 });
  const details = page.locator("details").filter({ hasText: "Check program and result for question 1" });
  await expect(details.getByText("Result", { exact: true })).toBeVisible();
  expect(await details.locator('a, img, iframe, script, [href^="javascript"]').count()).toBe(0);
  expect(await page.locator('img[src="x"]').count()).toBe(0);
  expect(dialogs).toBe(0);
  await expectNoAxeViolations(page, "/import hostile result");
  await page.context().close();
});

test("C30 the admin switch turns the gate off and on, and a test page shows the state", async ({ browser }) => {
  const page = await newSignedInPage(browser, adminEmail, adminPassword);
  await page.goto("/admin/settings");
  const gate = page.getByRole("switch", { name: "Proctored publish gate" });
  await expect(gate).toBeChecked();
  await page.getByText("Proctored publish gate").click();
  await expect(page.getByText("Tests can be used for proctoring with unverified questions.")).toBeVisible();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect.poll(() => liveRegionText(page)).toContain("Settings saved.");
  await expectNoAxeViolations(page, "/admin/settings gate off");
  await page.getByText("Proctored publish gate").click();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(gate).toBeChecked();
  await page.context().close();
});
