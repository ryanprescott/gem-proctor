// A30: axe-core reports zero violations on every page in P0.md §6, as every applicable role.
import { expect, test } from "@playwright/test";
import { adminRequest, createUser, expectNoAxeViolations, FIXED, FIXTURE, newSignedInPage } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

let adminEmail = "";
let adminPassword = "";
let proctorEmail = "";
let studentEmail = "";
let testId = "";

test.beforeAll(async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const admin = await adminRequest(adminCtx.request);
  adminEmail = admin.email;
  adminPassword = admin.password;
  const anon = await browser.newContext();
  proctorEmail = await createUser(adminCtx.request, anon.request, "proctor", "proctor");
  const anon2 = await browser.newContext();
  studentEmail = await createUser(adminCtx.request, anon2.request, "student", "student");
  const proctorPage = await newSignedInPage(browser, proctorEmail);
  const created = await proctorPage.request.post("/api/v1/imports", {
    data: { originalText: FIXED, text: FIXED, filename: "engr108.json" },
  });
  expect(created.status()).toBe(200);
  testId = (await created.json()).testId;
  await Promise.all([adminCtx.close(), anon.close(), anon2.close(), proctorPage.context().close()]);
});

test("signed out: sign in, register, 404", async ({ page }) => {
  for (const path of ["/sign-in", "/register", "/no-such-page"]) {
    await page.goto(path);
    await expect(page.locator("h1")).toBeVisible();
    await expectNoAxeViolations(page, `signed out ${path}`);
  }
  // Pages that need a role send signed-out users to sign in.
  await page.goto("/tests");
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("student: home, and the refusal on proctor pages", async ({ browser }) => {
  const page = await newSignedInPage(browser, studentEmail);
  for (const path of ["/", "/import", "/tests", `/tests/${testId}`, "/admin/users", "/no-such-page"]) {
    await page.goto(path);
    await expect(page.locator("h1")).toBeVisible();
    await expectNoAxeViolations(page, `student ${path}`);
  }
  await page.context().close();
});

test("proctor: home, import (empty, with a report), tests, test detail", async ({ browser }) => {
  const page = await newSignedInPage(browser, proctorEmail);
  for (const path of ["/", "/import", "/tests", `/tests/${testId}`]) {
    await page.goto(path);
    await expect(page.locator("h1")).toBeVisible();
    await expectNoAxeViolations(page, `proctor ${path}`);
  }
  await page.goto("/import");
  await page.getByLabel("Or paste the quiz text").fill(FIXTURE);
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByRole("heading", { name: "2. Report" })).toBeVisible();
  await expectNoAxeViolations(page, "proctor /import with report");
  await page.context().close();
});

test("admin: every page", async ({ browser }) => {
  const page = await newSignedInPage(browser, adminEmail, adminPassword);
  for (const path of [
    "/",
    "/import",
    "/tests",
    `/tests/${testId}`,
    "/admin/users",
    "/admin/settings",
    "/admin/llm",
    "/admin/audit-log",
    "/no-such-page",
  ]) {
    await page.goto(path);
    await expect(page.locator("h1")).toBeVisible();
    await expectNoAxeViolations(page, `admin ${path}`);
  }
  // Open widgets too: the role picker and the reset-password dialog.
  await page.goto("/admin/users");
  await page.getByRole("button", { name: "Reset password" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expectNoAxeViolations(page, "admin /admin/users reset dialog");
  await page.keyboard.press("Escape");
  await page.context().close();
});
