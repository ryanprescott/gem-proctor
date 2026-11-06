// P2.2 F3 (M20–M24a) and the PDFs section: PDFs are added and read on their own, followed in a list streamed over SSE,
// and made into sources through the add-source form. Against the real API and pg-boss, with the mock converter.
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

async function choose(page: Page, files: [name: string, flags: string][]) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose PDFs" }).click();
  await (await chooser).setFiles(
    files.map(([name, flags]) => ({ name, mimeType: "application/pdf", buffer: pdf(flags) })),
  );
}
const pdfs = (page: Page) => page.getByRole("region", { name: "PDFs" });
const row = (page: Page, name: string) =>
  pdfs(page).getByRole("row", { name: new RegExp(`^${name.replace(".", "\\.")}`) });

test("M20 M22 a PDF is read in the list, announced, made a source with equations and warnings, edited, saved, downloadable", async ({
  browser,
}) => {
  const page = await newSignedInPage(browser, proctorEmail);
  await page.goto("/sources");
  await page.getByLabel("Pages (optional)").fill("1-2");
  await choose(page, [["vectors.pdf", "%MOCK:doc=chapter\n%MOCK:pages=2\n%MOCK:figures=1"]]);
  await expect.poll(() => liveRegionText(page)).toContain("1 PDFs added");
  await expect(row(page, "vectors.pdf").getByRole("cell", { name: /^Read: 2 pages/ })).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => liveRegionText(page)).toContain("Finished reading vectors.pdf");
  // Reading touches nothing in the form.
  await expect(page.getByLabel("Title")).toHaveValue("");
  await expect(page.getByLabel("Markdown or plain text")).toHaveValue("");

  await row(page, "vectors.pdf").getByRole("button", { name: "Make a source from vectors.pdf" }).click();
  await expect(page.getByLabel("Title")).toBeFocused();
  await expect(page.getByLabel("Title")).toHaveValue("vectors");
  await expect(page.getByRole("button", { name: / Source text$/ })).toContainText("Read from vectors.pdf");
  // Choosing a PDF hides the typed text and the .md upload.
  await expect(page.getByLabel("Markdown or plain text")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Upload .md or .txt" })).toHaveCount(0);

  const result = page.getByRole("region", { name: "What was read from the PDF" });
  await expect(result.getByText("figures or images were left out")).toBeVisible();
  // Equations are rendered, with MathML for screen readers, and the one KaTeX can't read is listed as written (M22).
  await expect(result.locator(".katex-mathml math").first()).toBeAttached();
  await expect(result.getByText("couldn't be displayed")).toBeVisible();
  await expect(result.locator("code", { hasText: "\\notacommand{x}" })).toBeVisible();
  await expectNoAxeViolations(page, "/sources with a PDF chosen for the source");

  const text = page.getByLabel("Text read from vectors.pdf");
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
  // Saved, it has left the list.
  await page.goto("/sources");
  await expect(pdfs(page).getByText("No PDFs waiting")).toBeVisible();
  await page.context().close();
});

test("M21 a failure says why in words, and can be retried or removed; a scan with little text says so", async ({
  browser,
}) => {
  const page = await newSignedInPage(browser, proctorEmail);
  await page.goto("/sources");
  await choose(page, [["damaged.pdf", "%MOCK:fail=bad_pdf"]]);
  await expect(row(page, "damaged.pdf").getByRole("cell", { name: /couldn't be opened/ })).toBeVisible({
    timeout: 20_000,
  });
  await expect.poll(() => liveRegionText(page)).toContain("damaged.pdf couldn't be read: That PDF couldn't be opened");
  await expect(row(page, "damaged.pdf").getByRole("button", { name: "Try again with damaged.pdf" })).toBeVisible();
  await expectNoAxeViolations(page, "/sources with a failed PDF");
  await row(page, "damaged.pdf").getByRole("button", { name: "Remove damaged.pdf" }).click();
  await page.getByRole("alertdialog", { name: "Remove damaged.pdf?" }).getByRole("button", { name: "Remove" }).click();
  await expect(row(page, "damaged.pdf")).toHaveCount(0);
  await expect.poll(() => liveRegionText(page)).toContain("damaged.pdf removed.");

  await choose(page, [["scan.pdf", "%MOCK:pages=3"]]);
  await row(page, "scan.pdf").getByRole("button", { name: "Make a source from scan.pdf" }).click({ timeout: 20_000 });
  await expect(page.getByText("Very little text was found")).toBeVisible();
  await page.context().close();
});

test("several PDFs at once, read while away; the typed text survives choosing a PDF and back", async ({ browser }) => {
  const page = await newSignedInPage(browser, proctorEmail);
  await page.goto("/sources");
  await page.getByLabel("Markdown or plain text").fill("# Typed\n\nWritten by hand.");
  await choose(page, [
    ["one.pdf", "%MOCK:doc=chapter\n%MOCK:pages=2"],
    ["two.pdf", "%MOCK:doc=chapter\n%MOCK:pages=2"],
  ]);
  await expect.poll(() => liveRegionText(page)).toContain("2 PDFs added");
  // Away while they're read, and back: the list has them, and follows them to the end without a reload.
  await page.goto("/");
  await page.goto("/sources");
  for (const name of ["one.pdf", "two.pdf"]) {
    await expect(row(page, name).getByRole("cell", { name: /^Read: 2 pages/ })).toBeVisible({ timeout: 20_000 });
  }
  await expectNoAxeViolations(page, "/sources with the PDFs list");

  await page.getByLabel("Markdown or plain text").fill("# Typed\n\nWritten by hand.");
  await page.getByRole("button", { name: / Source text$/ }).click();
  await page.getByRole("option", { name: /Read from two\.pdf$/ }).click();
  await expect(page.getByLabel("Text read from two.pdf")).toHaveValue(/inner product/);
  await page.getByRole("button", { name: / Source text$/ }).click();
  await page.getByRole("option", { name: /Typed or pasted text/ }).click();
  await expect(page.getByLabel("Markdown or plain text")).toHaveValue("# Typed\n\nWritten by hand.");
  await page.context().close();
});

test("M24a a page range that isn't a range is refused before anything is sent", async ({ browser }) => {
  const page = await newSignedInPage(browser, proctorEmail);
  await page.goto("/sources");
  await page.getByLabel("Pages (optional)").fill("abc");
  await expect(page.getByText("Write pages like 5-23 or 1,4,9-12.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose PDFs" })).toBeDisabled();
  await page.context().close();
});

test("M23 M24 the whole flow works by keyboard, and at 320 px with no sideways scroll", async ({ browser }) => {
  const page = await newSignedInPage(browser, proctorEmail);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/sources");
  const pages = page.getByLabel("Pages (optional)");
  await tabTo(page, pages);
  await page.keyboard.type("1");
  await tabTo(page, page.getByRole("button", { name: "Choose PDFs" }));
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await chooser).setFiles({
    name: "kb.pdf",
    mimeType: "application/pdf",
    buffer: pdf("%MOCK:doc=chapter\n%MOCK:pages=1"),
  });
  await expect.poll(() => liveRegionText(page), { timeout: 20_000 }).toContain("Finished reading kb.pdf");
  await tabTo(page, page.getByRole("button", { name: "Make a source from kb.pdf" }));
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Title")).toBeFocused();
  await tabTo(page, page.getByLabel("Citation label"));
  await page.keyboard.type("KB");
  await tabTo(page, page.getByRole("button", { name: "Save source" }));
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/sources\/[0-9a-f-]+/);
  await expectNoAxeViolations(page, "source from a PDF at 320 px");

  await page.goto("/sources");
  await choose(page, [["wide.pdf", "%MOCK:doc=chapter"]]);
  await row(page, "wide.pdf").getByRole("button", { name: "Make a source from wide.pdf" }).click({ timeout: 20_000 });
  await expect(page.getByRole("region", { name: "What was read from the PDF" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expectNoAxeViolations(page, "/sources with a PDF chosen at 320 px");
  await page.context().close();
});
