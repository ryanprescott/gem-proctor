// C33–C37: the admin LLM page against the real API and a mock model server (scripts/e2e.ts). In order: each
// test builds on the state the one before left, starting from an empty page (C37).
import { expect, type Page, test } from "@playwright/test";
import { expectNoAxeViolations, liveRegionText, newSignedInPage } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

const KEY = "sk-e2e-never-shown";
const LOCAL = "Mock local";
const CLOUD = "Mock cloud";
const llmUrl = () => process.env.E2E_LLM_URL as string;

let page: Page;

/** A Select's button is named "<value> <label>". */
async function choose(p: Page, label: string, option: string) {
  await p.getByRole("button", { name: new RegExp(` ${label}$`) }).click();
  // The selected option's name starts with its "✓ " mark.
  await p.getByRole("option", { name: new RegExp(`${option}$`) }).click();
}

async function createEndpoint(label: string, location: "Local" | "Cloud", apiKey?: string) {
  await page.getByRole("button", { name: "New endpoint" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Label").fill(label);
  await dialog.getByLabel("Base URL").fill(llmUrl());
  await choose(page, "Location", location);
  await choose(page, "Server", "ollama");
  if (apiKey) await dialog.getByLabel("API key").fill(apiKey);
  await dialog.getByRole("button", { name: "Save endpoint" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("rowheader", { name: label, exact: true })).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
  page = await newSignedInPage(
    browser,
    process.env.E2E_ADMIN_EMAIL as string,
    process.env.E2E_ADMIN_PASSWORD as string,
  );
});

test.afterAll(async () => {
  await page.context().close();
});

test("C37 empty state; the nav reaches the page", async () => {
  await page.goto("/");
  await page.getByRole("link", { name: "LLM", exact: true }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "LLM" })).toBeVisible();
  await expect(page.getByText("No endpoints yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Assign Analysis" })).toBeDisabled();
  await expectNoAxeViolations(page, "/admin/llm empty");
});

test("C33 create and edit: the key is write-only, shows 'key set', and can be cleared", async () => {
  await page.getByRole("button", { name: "New endpoint" }).click();
  await expectNoAxeViolations(page, "/admin/llm endpoint dialog");
  await page.keyboard.press("Escape");

  await createEndpoint(LOCAL, "Local", KEY);
  const row = page.getByRole("row", { name: new RegExp(LOCAL) });
  await expect(row.getByText("Key set")).toBeVisible();
  await expect(row.getByText("ollama")).toBeVisible();

  await page.getByRole("button", { name: `Edit ${LOCAL}` }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("New API key")).toHaveValue("");
  await expect(dialog.getByText("Key set")).toBeVisible();
  expect(await page.content()).not.toContain(KEY);
  await dialog.getByLabel("Concurrency").fill("2");
  await dialog.getByRole("button", { name: "Save endpoint" }).click();
  await expect(dialog).toBeHidden();
  await expect(row.getByText("Key set")).toBeVisible();

  await page.getByRole("button", { name: `Edit ${LOCAL}` }).click();
  await dialog.getByRole("button", { name: "Clear key" }).click();
  await expect(dialog.getByText("The key will be cleared when you save.")).toBeVisible();
  await dialog.getByRole("button", { name: "Save endpoint" }).click();
  await expect(dialog).toBeHidden();
  await expect(row.getByText("No key")).toBeVisible();

  await createEndpoint("Throwaway", "Local");
  await page.getByRole("button", { name: "Delete Throwaway" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("rowheader", { name: "Throwaway" })).toBeHidden();
});

test("C34 models and probes; 'Use these values' prefills the role dialog", async () => {
  await page.getByRole("button", { name: `Models and probe for ${LOCAL}` }).click();
  await page.getByRole("button", { name: "List models" }).click();
  await expect(page.getByRole("rowheader", { name: "mock-chat" })).toBeVisible();
  await page.getByRole("button", { name: "Probe this: mock-chat" }).click();
  await expect(page.getByLabel("Model id")).toHaveValue("mock-chat");
  await page.getByLabel("Parameters (JSON)").fill('{ "reasoning_effort": "none" }');
  await page.getByRole("button", { name: "Run probe" }).click();
  await expect(page.getByRole("rowheader", { name: "Native schema" })).toBeVisible();
  await expect(page.getByText("Reported context: 32,768")).toBeVisible();
  await expectNoAxeViolations(page, "/admin/llm chat probe results");

  await choose(page, "For role", "Authoring: generate");
  await page.getByRole("button", { name: "Use these values" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Assign Authoring: generate" })).toBeVisible();
  await expect(dialog.getByLabel("Model", { exact: false }).first()).toHaveValue("mock-chat");
  await expect(dialog.getByRole("button", { name: / Mode$/ })).toContainText("Native schema");
  await expect(dialog.getByLabel("Context window")).toHaveValue("32768");
  await expect(dialog.getByLabel("Parameters (JSON)")).toHaveValue(/"reasoning_effort": "none"/);
  await expectNoAxeViolations(page, "/admin/llm role dialog");
  await dialog.getByRole("button", { name: "Save assignment" }).click();
  await expect(dialog).toBeHidden();
  const assigned = page.getByRole("row", { name: /Authoring: generate/ });
  await expect(assigned.getByRole("cell", { name: "mock-chat" })).toBeVisible();

  await page.getByLabel("Model id").fill("mock-embed");
  await page.getByLabel("Parameters (JSON)").fill("");
  await choose(page, "Probe", "Embeddings");
  await page.getByRole("button", { name: "Run probe" }).click();
  await expect(page.getByText("Dimensions")).toBeVisible();
  await expect(page.getByText("768", { exact: true })).toBeVisible();
  await expectNoAxeViolations(page, "/admin/llm embeddings probe results");
  await page.getByRole("button", { name: "Use these values" }).click();
  await expect(dialog.getByRole("heading", { name: "Assign Embeddings" })).toBeVisible();
  await expect(dialog.getByLabel("Dimensions")).toHaveValue("768");
  const measured = Number(await dialog.getByLabel("Max input tokens").inputValue());
  expect(Math.abs(measured - 2048)).toBeLessThanOrEqual(2048 * 0.05);
  await dialog.getByRole("button", { name: "Save assignment" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("row", { name: /^Embeddings/ }).getByRole("cell", { name: "mock-embed" })).toBeVisible();
});

test("C33 the in-use 409 shows its catalog message", async () => {
  await page.getByRole("button", { name: `Delete ${LOCAL}` }).click();
  const confirm = page.getByRole("alertdialog");
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(confirm.getByRole("alert")).toHaveText("A role uses this endpoint. Assign the role elsewhere first.");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("rowheader", { name: LOCAL })).toBeVisible();
});

test("C35 cloud notice, local-only 409 with roles listed, unassign", async () => {
  await createEndpoint(CLOUD, "Cloud");
  await page.getByRole("button", { name: "Assign Analysis" }).click();
  const dialog = page.getByRole("dialog");
  await choose(page, "Endpoint", CLOUD);
  await dialog.getByLabel("Model", { exact: false }).first().fill("cloud-model");
  await dialog.getByLabel("Context window").fill("8192");
  await dialog.getByLabel("Max output tokens").fill("1024");
  await dialog.getByLabel("Parameters (JSON)").fill("[1]");
  await dialog.getByRole("button", { name: "Save assignment" }).click();
  await expect(dialog.getByText("Enter a JSON object, or leave this empty.")).toBeVisible();
  await dialog.getByLabel("Parameters (JSON)").fill('{ "temperature": 0.2 }');
  await dialog.getByRole("button", { name: "Save assignment" }).click();
  await expect(dialog).toBeHidden();

  // Text, not color: the notice names the endpoint and the row says "Cloud".
  await expect(
    page.getByText(`Cloud notice: Analysis uses the cloud endpoint ${CLOUD}.`, { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("row", { name: /^Analysis/ }).getByText("Cloud", { exact: true })).toBeVisible();

  const localOnly = page.getByRole("switch", { name: "Local endpoints only" });
  await localOnly.click({ force: true });
  await expect(
    page.getByText("Local endpoints only can't be turned on while these roles use a cloud endpoint: analysis."),
  ).toBeVisible();
  await expect(localOnly).not.toBeChecked();
  await expectNoAxeViolations(page, "/admin/llm with cloud notice and 409");

  await page.getByRole("button", { name: "Unassign Analysis" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Unassign" }).click();
  await expect(page.getByRole("row", { name: /^Analysis/ }).getByText("Not assigned")).toBeVisible();
  await expect(page.getByText("Cloud notice:")).toBeHidden();

  // The other roles, each assigned and unassigned the same way.
  for (const role of ["Authoring: objectives", "Authoring: judge", "Verify: solve"]) {
    const row = page.getByRole("row", { name: new RegExp(`^${role}`) });
    await page.getByRole("button", { name: `Assign ${role}` }).click();
    await dialog.getByLabel("Model", { exact: false }).first().fill("mock-chat");
    await dialog.getByLabel("Context window").fill("8192");
    await dialog.getByLabel("Max output tokens").fill("1024");
    await dialog.getByRole("button", { name: "Save assignment" }).click();
    await expect(row.getByRole("cell", { name: "mock-chat" })).toBeVisible();
    await page.getByRole("button", { name: `Unassign ${role}` }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Unassign" }).click();
    await expect(row.getByText("Not assigned")).toBeVisible();
  }

  await localOnly.click({ force: true });
  await expect(localOnly).toBeChecked();
  await localOnly.click({ force: true });
  await expect(localOnly).not.toBeChecked();
});

test("C36 evals poll to completion and announce it; stats render with Intl", async () => {
  await page.getByLabel("Trials").fill("2");
  await page.getByRole("button", { name: "Start evaluation" }).click();
  const row = page.getByRole("row", { name: /^generate-smoke/ }).first();
  await expect(row.getByRole("cell", { name: /Queued|Running/ }).first()).toBeVisible();
  await expect(row.getByRole("cell", { name: "Done", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => liveRegionText(page)).toBe("Evaluation generate-smoke: Done.");

  await expect(page.getByRole("heading", { name: "Report: generate-smoke on mock-chat" })).toBeVisible();
  await expect(page.getByRole("row", { name: "Valid first try 100%" })).toBeVisible();
  await expect(page.getByRole("row", { name: /Seconds per question [\d.]+ sec/ })).toBeVisible();
  await expectNoAxeViolations(page, "/admin/llm eval report");

  const stats = page.getByRole("row", { name: /Authoring: generate Mock local mock-chat 2 / });
  await expect(stats).toBeVisible();
  await expect(stats.getByRole("cell", { name: "0%" }).first()).toBeVisible();
  await expect(stats.getByRole("cell", { name: /sec$/ }).first()).toBeVisible();
});

test("C37 320 px", async () => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "LLM" })).toBeVisible();
  await expectNoAxeViolations(page, "/admin/llm at 320 px");
  await page.getByRole("button", { name: "New endpoint" }).click();
  await expectNoAxeViolations(page, "/admin/llm dialog at 320 px");
  await page.keyboard.press("Escape");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
