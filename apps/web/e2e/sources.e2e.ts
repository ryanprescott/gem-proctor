// E16–E18: the Sources pages, against the real API and pg-boss, with the mock model for embeddings.
import { expect, type Page, test } from "@playwright/test";
import { createUser, expectNoAxeViolations, liveRegionText, newSignedInPage, tabTo } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

const SOURCE = `# Chapter 1: Vectors

A vector is an ordered list of numbers.

## Inner product

The inner product is $x^T y = x_1 y_1 + x_2 y_2$. Two vectors are orthogonal when it is zero.

## Norms

The norm is $\\|x\\| = \\sqrt{x^T x}$, and it is never negative.

# Chapter 2: Matrices

A matrix is a rectangular array of numbers.
`;

let proctorEmail = "";
let sourceUrl = "";

const baseURL = () => process.env.E2E_BASE_URL as string;

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL: baseURL() });
  const anon = await playwright.request.newContext({ baseURL: baseURL() });
  await request.post("/api/v1/auth/login", {
    data: { email: process.env.E2E_ADMIN_EMAIL, password: process.env.E2E_ADMIN_PASSWORD },
  });
  proctorEmail = await createUser(request, anon, "sourcer", "proctor");
  const created = await request.post("/api/v1/admin/llm/endpoints", {
    data: {
      label: "Embeddings mock",
      provider: "openai-compatible",
      baseUrl: process.env.E2E_LLM_URL,
      location: "local",
      server: "ollama",
    },
  });
  expect(created.status(), await created.text()).toBe(200);
  const put = await request.put("/api/v1/admin/llm/roles/embeddings", {
    data: {
      endpointId: (await created.json()).endpoint.id,
      model: "mock-embed",
      capabilities: {
        structuredOutput: "native_schema",
        contextWindow: 32_768,
        maxOutputTokens: 1024,
        maxInputTokens: 2048,
      },
      embedding: { dimensions: 768, queryPrefix: "q: ", documentPrefix: "d: " },
    },
  });
  expect(put.status(), await put.text()).toBe(200);
  await request.dispose();
  await anon.dispose();
});

async function fill(page: Page) {
  await page.getByLabel("Title").fill("Vectors book");
  await page.getByLabel("Citation label").fill("VB");
  await page.getByLabel("Markdown or plain text").fill(SOURCE);
}

test("E16 E18 add, preview, save, and watch embedding finish, announced", async ({ browser }) => {
  const page = await newSignedInPage(browser, proctorEmail);
  await page.goto("/sources");
  await expect(page.getByRole("heading", { name: "Sources", level: 1 })).toBeVisible();
  await expect(page.getByText("No sources yet.")).toBeVisible();
  await expectNoAxeViolations(page, "/sources empty");

  await fill(page);
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByText("Nothing has been saved yet.")).toBeVisible();
  await expect.poll(() => liveRegionText(page)).toContain("Preview ready");
  await expect(page.getByText("No problems found.")).toBeVisible();
  await expect(page.locator("section li").getByText("Inner product")).toBeVisible();
  await expectNoAxeViolations(page, "/sources preview");

  await page.getByRole("button", { name: "Save source" }).click();
  await expect(page).toHaveURL(/\/sources\/[0-9a-f-]+/);
  sourceUrl = new URL(page.url()).pathname;
  await expect(page.getByRole("heading", { name: "Vectors book", level: 1 })).toBeVisible();
  await expect
    .poll(() => liveRegionText(page), { timeout: 20_000, intervals: [50] })
    .toMatch(/Embedding: \d+ of \d+ chunks/);
  await expect.poll(() => liveRegionText(page), { timeout: 20_000 }).toContain("is ready to use");
  await expect(page.getByText("Ready", { exact: true }).first()).toBeVisible();
  await expectNoAxeViolations(page, "source ready");

  await page.goto("/sources");
  await expect(page.getByRole("link", { name: "Vectors book" })).toBeVisible();
  await page.context().close();
});

test("preview warnings show in text", async ({ browser }) => {
  const page = await newSignedInPage(browser, proctorEmail);
  await page.goto("/sources");
  await page.getByLabel("Markdown or plain text").fill("Just a line with no headings.");
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByText("This text has no headings")).toBeVisible();
  await expectNoAxeViolations(page, "/sources preview with a warning");
  await page.context().close();
});

test("E16 edit to a new revision, and view a highlighted passage", async ({ browser }) => {
  const page = await newSignedInPage(browser, proctorEmail);
  await page.goto(sourceUrl);
  await page.getByRole("button", { name: "Edit as a new revision" }).click();
  const box = page.getByLabel("Markdown or plain text");
  await expect(box).toHaveValue(/Chapter 1/);
  await box.fill(`${SOURCE}\n\nA new closing sentence.`);
  await page.getByRole("button", { name: "Save new revision" }).click();
  await expect(page.getByRole("link", { name: /Revision 2/ })).toBeVisible();
  await expect.poll(() => liveRegionText(page), { timeout: 20_000 }).toMatch(/Revision 2 saved|is ready to use/);
  await expect(page.getByRole("link", { name: /Revision 1/ })).toBeVisible();

  const id = sourceUrl.split("/").pop() as string;
  const chunks = await page.request.get(`/api/v1/sources/${id}/chunks?revision=1`);
  const chunk = (await chunks.json()).chunks.find((c: { text: string }) => c.text.includes("orthogonal"));
  await page.goto(
    `${sourceUrl}?revision=1&chunk=${chunk.id}&quote=${encodeURIComponent("Two vectors are orthogonal when it is zero.")}`,
  );
  const mark = page.locator("mark");
  await expect(mark).toHaveText("Two vectors are orthogonal when it is zero.");
  await expect(page.getByText("Cited passage:")).toBeVisible();
  await expect(page.getByText("VB § Chapter 1: Vectors › Inner product").first()).toBeVisible();
  await expectNoAxeViolations(page, "highlighted passage");
  await page.context().close();
});

test("E17 the scope tree works by keyboard, shows the estimate and fit, and math has MathML", async ({ browser }) => {
  const page = await newSignedInPage(browser, proctorEmail);
  await page.goto(`${sourceUrl}?revision=1`);
  await expect(page.locator(".katex-mathml math").first()).toBeAttached();
  await expect(page.locator("annotation").first()).toContainText("x^T y");

  const tree = page.getByRole("group", { name: "Sections" });
  const chapter = tree.getByRole("checkbox", { name: /Chapter 2: Matrices/ });
  await expect(chapter).toBeChecked();
  const before = await page.getByText(/^Selected:/).textContent();
  await tabTo(page, chapter);
  await page.keyboard.press("Space");
  await expect(chapter).not.toBeChecked();
  await expect(page.getByText(/^Selected:/)).not.toHaveText(before as string);

  // A heading stands for what's under it, and reads as mixed when part of it is ticked.
  const top = tree.getByRole("checkbox", { name: /Chapter 1: Vectors/ });
  const child = tree.getByRole("checkbox", { name: /Inner product/ });
  await tabTo(page, child);
  await page.keyboard.press("Space");
  await expect(child).not.toBeChecked();
  await expect.poll(() => top.evaluate((el) => (el as HTMLInputElement).indeterminate)).toBe(true);
  await tabTo(page, top);
  await page.keyboard.press("Space");
  await expect(child).toBeChecked();
  await expect(page.getByText(/^Authoring: generate: (fits in one call|too large|not assigned)/)).toBeVisible();
  await expectNoAxeViolations(page, "scope tree");
  await page.context().close();
});

test("E18 a failed embedding shows its reason and a retry, and passes axe", async ({ browser, playwright }) => {
  const admin = await playwright.request.newContext({ baseURL: baseURL() });
  await admin.post("/api/v1/auth/login", {
    data: { email: process.env.E2E_ADMIN_EMAIL, password: process.env.E2E_ADMIN_PASSWORD },
  });
  const assignment = (await (await admin.get("/api/v1/admin/llm/roles")).json()).roles.find(
    (r: { role: string }) => r.role === "embeddings",
  ).assignment;
  const assign = (dimensions: number) =>
    admin.put("/api/v1/admin/llm/roles/embeddings", {
      data: {
        endpointId: assignment.endpointId,
        model: assignment.model,
        capabilities: assignment.capabilities,
        embedding: { ...assignment.embedding, dimensions },
      },
    });
  expect((await assign(1024)).status()).toBe(200);

  const page = await newSignedInPage(browser, proctorEmail);
  const res = await page.request.post("/api/v1/sources", {
    data: { title: "Wrong size", citationLabel: "WS", text: SOURCE },
  });
  const { source } = await res.json();
  await page.goto(`/sources/${source.id}`);
  await expect(page.getByText("Embedding failed", { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("makes vectors of 1024 dimensions")).toBeVisible();
  await expectNoAxeViolations(page, "failed embedding");

  expect((await assign(768)).status()).toBe(200);
  await page.getByRole("button", { name: "Try embedding again" }).click();
  await expect.poll(() => liveRegionText(page), { timeout: 20_000 }).toContain("is ready to use");
  await page.context().close();
  await admin.dispose();
});

test("E18 320 px, and the delete dialog", async ({ browser }) => {
  const page = await newSignedInPage(browser, proctorEmail);
  await page.setViewportSize({ width: 320, height: 800 });
  for (const path of ["/sources", sourceUrl]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
    await expectNoAxeViolations(page, `${path} at 320 px`);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "Delete source" }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expectNoAxeViolations(page, "delete dialog");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page).toHaveURL(/\/sources$/);
  await expect.poll(() => liveRegionText(page)).toContain("Source deleted");
  await page.context().close();
});
