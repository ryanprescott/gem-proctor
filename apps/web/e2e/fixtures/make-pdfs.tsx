// bun apps/web/e2e/fixtures/make-pdfs.tsx — the PDF fixtures for P2.2 (docs/P2.2.md M25), made from the repo's own
// Markdown so the right answer is known. The text PDF is the Markdown rendered with KaTeX (real glyphs, so the equations
// are in the file as typeset math) and printed by the Chromium Playwright already installs. The "scan" is the same pages
// as pictures only: no text layer, so a converter has to read them. Both are small enough to commit.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const SOURCE = join(ROOT, "packages", "authoring", "test", "fixtures", "linear-algebra.md");
const OUT = join(ROOT, "apps", "convert", "tests", "fixtures");
const KATEX_CSS = join(ROOT, "apps", "web", "node_modules", "katex", "dist", "katex.min.css");
const DPI = 130;

const markdown = readFileSync(SOURCE, "utf8");
const body = renderToStaticMarkup(
  <Markdown remarkPlugins={[remarkMath]} rehypePlugins={[[rehypeKatex, { output: "html" }]]}>
    {markdown}
  </Markdown>,
);
const page = (inner: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="file://${KATEX_CSS}">
<style>
  body { font: 12pt/1.5 "Times New Roman", serif; margin: 0; }
  h1 { font-size: 20pt; } h2 { font-size: 15pt; margin-top: 1.4em; }
  @page { size: A4; margin: 0; }
  img { display: block; width: 210mm; height: 296mm; break-after: page; }
  img:last-child { break-after: auto; }
</style></head><body>${inner}</body></html>`;

// What a converter should find: every formula in the source, as written.
const formulas = [...markdown.matchAll(/\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g)].map((m) => (m[1] ?? m[2] ?? "").trim());
const headings = [...markdown.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((m) => ({
  level: m[1]?.length ?? 1,
  title: m[2] ?? "",
}));

const work = mkdtempSync(join(tmpdir(), "gem-pdf-"));
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  const ctx = await browser.newPage();
  const html = join(work, "text.html");
  writeFileSync(html, page(body));
  await ctx.goto(`file://${html}`);
  await ctx.pdf({
    path: join(OUT, "linear-algebra.pdf"),
    format: "A4",
    margin: { top: "20mm", bottom: "20mm", left: "20mm", right: "20mm" },
  });

  // The scan: rasterize each page, then print the pictures alone.
  const png = spawnSync("pdftoppm", ["-r", String(DPI), "-png", join(OUT, "linear-algebra.pdf"), join(work, "p")]);
  if (png.status !== 0) throw new Error(`pdftoppm: ${png.stderr.toString()}`);
  const pages = readdirSync(work)
    .filter((f) => /^p-\d+\.png$/.test(f))
    .sort()
    .map((f) => join(work, f));
  const images = pages.map((f) => `<img src="data:image/png;base64,${readFileSync(f).toString("base64")}">`).join("");
  const scan = join(work, "scan.html");
  writeFileSync(scan, page(images));
  await ctx.goto(`file://${scan}`);
  await ctx.pdf({
    path: join(OUT, "linear-algebra-scan.pdf"),
    format: "A4",
    margin: { top: "0", bottom: "0", left: "0", right: "0" },
  });
  writeFileSync(
    join(OUT, "linear-algebra.expected.json"),
    `${JSON.stringify({ source: "packages/authoring/test/fixtures/linear-algebra.md", pages: pages.length, headings, formulas }, null, 2)}\n`,
  );
  console.log(`${pages.length} pages, ${formulas.length} formulas, ${headings.length} headings → ${OUT}`);
} finally {
  await browser.close();
  rmSync(work, { recursive: true, force: true });
}
