// bun run ui:contrast: the colour tokens in src/styles/global.css, light and dark, checked against WCAG 2.2 AA. Text
// on its backgrounds needs 4.5:1; the borders of controls and the focus ring 3:1 against what they sit on (1.4.11).
// Exits 1 on any pair below its ratio, so a change of colour can't quietly fail contrast.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "..", "src", "styles", "global.css"), "utf8");

function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--(color-[a-z-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1], m[2]]));
}
const rootBlocks = [...css.matchAll(/:root\s*\{([\s\S]*?)\n\s*\}/g)].map((m) => m[1] ?? "");
const light = tokens(rootBlocks[0] ?? "");
const dark = { ...light, ...tokens(rootBlocks[1] ?? "") };

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

const SURFACES = ["color-bg", "color-surface", "color-surface-raised", "color-surface-muted"];
const pairs: [string, string, number][] = [
  ...["color-text", "color-text-muted", "color-text-subtle", "color-accent"].flatMap((fg) =>
    SURFACES.map((bg) => [fg, bg, 4.5] as [string, string, number]),
  ),
  ["color-accent-text", "color-accent", 4.5],
  ["color-accent-text", "color-accent-hover", 4.5],
  ["color-accent-subtle-text", "color-accent-subtle", 4.5],
  ["color-danger", "color-bg", 4.5],
  ["color-danger", "color-danger-bg", 4.5],
  ["color-warning", "color-bg", 4.5],
  ["color-warning", "color-warning-bg", 4.5],
  ["color-success", "color-bg", 4.5],
  ["color-success", "color-success-bg", 4.5],
  ["color-text", "color-mark-bg", 4.5],
  ...["color-border-strong", "color-focus"].flatMap((fg) =>
    SURFACES.map((bg) => [fg, bg, 3] as [string, string, number]),
  ),
];

let failed = 0;
for (const [theme, t] of [
  ["light", light],
  ["dark", dark],
] as const) {
  for (const [fg, bg, need] of pairs) {
    const a = t[fg];
    const b = t[bg];
    if (!a || !b) {
      console.log(`✘ ${theme}: --${fg} or --${bg} is missing`);
      failed++;
      continue;
    }
    const r = ratio(a, b);
    if (r < need) {
      console.log(`✘ ${theme}: --${fg} ${a} on --${bg} ${b} is ${r.toFixed(2)}:1, under ${need}:1`);
      failed++;
    }
  }
}
console.log(
  failed === 0 ? `✔ contrast: ${pairs.length * 2} pairs meet WCAG AA, light and dark` : `${failed} pairs fail`,
);
process.exit(failed === 0 ? 0 : 1);
