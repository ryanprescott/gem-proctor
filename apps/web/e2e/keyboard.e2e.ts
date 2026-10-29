// A31: keyboard only — sign in → import the fixture → fix Q7 → save → export.
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { adminRequest, createUser, FIXTURE_PATH, liveRegionText, PASSWORD, tabTo } from "./helpers.ts";

let proctorEmail = "";

test.beforeAll(async ({ browser }) => {
  const adminCtx = await browser.newContext();
  await adminRequest(adminCtx.request);
  const anon = await browser.newContext();
  proctorEmail = await createUser(adminCtx.request, anon.request, "keyboard", "proctor");
  await Promise.all([adminCtx.close(), anon.close()]);
});

test("keyboard-only flow", async ({ page }) => {
  await page.goto("/sign-in");

  // Sign in.
  await tabTo(page, page.getByLabel("Email"));
  await page.keyboard.type(proctorEmail);
  await page.keyboard.press("Tab");
  await page.keyboard.type(PASSWORD);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: /^Welcome/ })).toBeVisible();

  // Navigate to Import with the keyboard.
  await tabTo(page, page.getByRole("navigation").getByRole("link", { name: "Import" }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Import a quiz" })).toBeVisible();

  // Upload the fixture: Enter on the upload button opens the file chooser.
  await tabTo(page, page.getByRole("button", { name: "Upload a .json file" }));
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await chooser).setFiles(FIXTURE_PATH);
  await expect(page.getByText("1 error must be fixed before saving.")).toBeVisible();
  await expect.poll(() => liveRegionText(page)).toContain("Preview finished: 1 errors");

  // Fix Q7 in the editor with the keyboard: arrow down to its correctAnswer line and type the sign.
  const editor = page.getByLabel("Quiz JSON");
  await tabTo(page, editor);
  const text = await editor.inputValue();
  const lines = text.split("\n");
  const line = lines.findIndex((l) => l.trim() === '"correctAnswer": "1",');
  expect(line).toBeGreaterThan(0);
  await page.keyboard.press("Control+Home");
  for (let i = 0; i < line; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft"); // before 1 in "1",
  await page.keyboard.type("-");
  expect(await editor.inputValue()).toContain('"correctAnswer": "-1"');

  // Re-run the preview, then save.
  await tabTo(page, page.getByRole("button", { name: "Run preview again" }));
  await page.keyboard.press("Enter");
  await expect(page.getByText("No errors: the quiz can be saved.")).toBeVisible();
  await tabTo(page, page.getByRole("button", { name: "Save as a test" }));
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/tests\/[0-9a-f-]{36}$/);
  await expect.poll(() => liveRegionText(page)).toContain("Quiz saved as a test.");

  // Export: Enter on the export link downloads the quiz JSON.
  await tabTo(page, page.getByRole("link", { name: "Export quiz JSON" }));
  const download = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  const file = await (await download).path();
  const exported = JSON.parse(readFileSync(file, "utf8"));
  expect(exported.quiz_title).toBe("Stanford ENGR108 Chapter 1 Practice Quiz (Set 2)");
  expect(exported.questions[6].correctAnswer).toBe("-1");
  expect(exported.questions).toHaveLength(20);
});
