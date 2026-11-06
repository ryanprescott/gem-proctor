// P2.2 F3 (M20–M24a): choosing a PDF on the add-source page, against the real API and pg-boss with the mock converter.
import { expect, type Page, test } from "@playwright/test";
import { createUser, expectNoAxeViolations, liveRegionText, newSignedInPage, tabTo } from "./helpers.ts";

test.describe.configure({ mode: "serial" });
test.skip(!process.env.E2E_CONVERT, "needs the mock converter that `bun run e2e` starts");

let proctorEmail = "";
const baseURL = () => process.env.E2E_BASE_URL as string;

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL: baseURL() });
  const anon = await playwright.request.newContext({ baseURL: baseURL() });
  await request.post("/api/v1/auth/login", {
    data: { email: process.env.E2E_ADMIN_EMAIL, password: process.env.E2E_ADMIN_PASSWORD },
  });
  proctorEmail = await createUser(request, anon, "pdfreader", "proctor");
  await request.dispose();
  await anon.dispose();
});

const pdf = (flags: string) => Buffer.from(`%PDF-1.7\n${flags}\n%%EOF\n`);

async function choose(page: Page, name: string, flags: string) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose a PDF" }).click();
  await (await chooser).setFiles({ name, mimeType: "application/pdf", buffer: pdf(flags) });
}

test("M20 M22 a PDF is read, announced, shown with equations and warnings, edited, saved, and downloadable", async ({
  browser,
}) => {
  const page = await newSignedInPage(browser, proctorEmail);
  await page.goto("/sources");
  await page.getByLabel("Pages (optional)").fill("1-2");
  await choose(page, "vectors.pdf", "%MOCK:doc=chapter\n%MOCK:pages=2\n%MOCK:figures=1");

  await expect.poll(() => liveRegionText(page)).toContain("Reading vectors.pdf");
  await expect(page.getByText("Finished reading vectors.pdf: 2 pages", { exact: false }).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect.poll(() => liveRegionText(page)).toContain("Finished reading vectors.pdf");

  const result = page.getByRole("region", { name: "What was read from the PDF" });
  await expect(result.getByText("figures or images were left out")).toBeVisible();
  // Equations are rendered, with MathML for screen readers, and the one KaTeX can't read is listed as written (M22).
  await expect(result.locator(".katex-mathml math").first()).toBeAttached();
  await expect(result.getByText("couldn't be displayed")).toBeVisible();
  await expect(result.locator("code", { hasText: "\\notacommand{x}" })).toBeVisible();
  await expect(page.getByLabel("Title")).toHaveValue("vectors");
  await expectNoAxeViolations(page, "/sources with a converted PDF");

  const text = page.getByLabel("Markdown or plain text");
  await expect(text).toHaveValue(/inner product/);
  await text.fill(`${await text.inputValue()}\nAn edited closing line.\n`);
  await page.getByLabel("Citation label").fill("VEC");
  await page.getByRole("button", { name: "Save source" }).click();
  await expect(page).toHaveURL(/\/sources\/[0-9a-f-]+/);

  const link = page.getByRole("link", { name: "Download the PDF for revision 1" });
  await expect(link).toBeVisible();
  const original = await page.request.get((await link.getAttribute("href")) as string);
  expect(original.status()).toBe(200);
  expect(original.headers()["content-type"]).toBe("application/pdf");
  expect((await original.body()).toString()).toContain("%MOCK:doc=chapter");
  await page.context().close();
});

test("M21 a failure says why in words, and can be retried; a scan with little text says so", async ({ browser }) => {
  const page = await newSignedInPage(browser, proctorEmail);
  await page.goto("/sources");
  await choose(page, "damaged.pdf", "%MOCK:fail=bad_pdf");
  const alert = page.getByRole("alert").filter({ hasText: "couldn't be opened" });
  await expect(alert).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => liveRegionText(page)).toContain("couldn't be opened");
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  await expectNoAxeViolations(page, "/sources with a failed PDF");
  await page.context().close();

  const scan = await newSignedInPage(browser, proctorEmail);
  await scan.goto("/sources");
  await choose(scan, "scan.pdf", "%MOCK:pages=3");
  await expect(scan.getByText("Very little text was found")).toBeVisible({ timeout: 20_000 });
  await scan.context().close();
});

test("M24a a page range that isn't a range is refused before anything is sent", async ({ browser }) => {
  const page = await newSignedInPage(browser, proctorEmail);
  await page.goto("/sources");
  await page.getByLabel("Pages (optional)").fill("abc");
  await expect(page.getByText("Write pages like 5-23 or 1,4,9-12.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose a PDF" })).toBeDisabled();
  await page.context().close();
});

test("M23 M24 the whole flow works by keyboard, and at 320 px with no sideways scroll", async ({ browser }) => {
  const page = await newSignedInPage(browser, proctorEmail);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/sources");
  const pages = page.getByLabel("Pages (optional)");
  await tabTo(page, pages);
  await page.keyboard.type("1");
  const button = page.getByRole("button", { name: "Choose a PDF" });
  await tabTo(page, button);
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await chooser).setFiles({
    name: "kb.pdf",
    mimeType: "application/pdf",
    buffer: pdf("%MOCK:doc=chapter\n%MOCK:pages=1"),
  });
  await expect.poll(() => liveRegionText(page), { timeout: 20_000 }).toContain("Finished reading kb.pdf");
  await tabTo(page, page.getByLabel("Citation label"));
  await page.keyboard.type("KB");
  await tabTo(page, page.getByRole("button", { name: "Save source" }));
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/sources\/[0-9a-f-]+/);
  await expectNoAxeViolations(page, "source from a PDF at 320 px");

  await page.goto("/sources");
  await choose(page, "wide.pdf", "%MOCK:doc=chapter");
  await expect(page.getByRole("region", { name: "What was read from the PDF" })).toBeVisible({ timeout: 20_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expectNoAxeViolations(page, "/sources with a converted PDF at 320 px");
  await page.context().close();
});

test("uploads list: leave while it's read, come back to its progress over the stream, continue, save; retry and remove", async ({
  browser,
}) => {
  const page = await newSignedInPage(browser, proctorEmail);
  await page.goto("/sources");
  await choose(page, "later.pdf", "%MOCK:doc=chapter\n%MOCK:pages=2");
  // Away while it's read, and back: the list has it, and follows it to the end without a reload.
  await page.goto("/");
  await page.goto("/sources");
  const uploads = page.getByRole("region", { name: "PDFs" });
  const row = uploads.getByRole("row", { name: /^later\.pdf/ });
  await expect(row).toBeVisible();
  await expect(row.getByRole("cell", { name: /^Read: 2 pages/ })).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => liveRegionText(page)).toContain("Finished reading later.pdf. It's in the PDFs list");
  await expectNoAxeViolations(page, "/sources with the uploads list");

  await row.getByRole("button", { name: "Continue with later.pdf" }).click();
  await expect(page.getByLabel("Title")).toBeFocused();
  await expect(page.getByLabel("Title")).toHaveValue("later");
  await expect(page.getByLabel("Markdown or plain text")).not.toHaveValue("");
  await expect.poll(() => liveRegionText(page)).toContain("The text read from later.pdf is in the form below");
  await page.getByLabel("Citation label").fill("LT");
  await page.getByRole("button", { name: "Save source" }).click();
  await expect(page).toHaveURL(/\/sources\/[0-9a-f-]+/);
  await page.goto("/sources");
  await expect(page.getByRole("row", { name: /^later\.pdf/ })).toHaveCount(0);

  // A failed one offers a retry and can be removed, after a question.
  await choose(page, "broken.pdf", "%MOCK:fail=bad_pdf");
  const broken = page.getByRole("region", { name: "PDFs" }).getByRole("row", { name: /^broken\.pdf/ });
  await expect(broken.getByRole("cell", { name: /couldn't be opened/ })).toBeVisible({ timeout: 20_000 });
  await expect(broken.getByRole("button", { name: "Try again with broken.pdf" })).toBeVisible();
  await broken.getByRole("button", { name: "Remove broken.pdf" }).click();
  await page.getByRole("alertdialog", { name: "Remove broken.pdf?" }).getByRole("button", { name: "Remove" }).click();
  await expect(broken).toHaveCount(0);
  await expect.poll(() => liveRegionText(page)).toContain("broken.pdf removed.");
  await page.context().close();
});
