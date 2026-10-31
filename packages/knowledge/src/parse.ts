import type { SourceFormat, SourceWarning } from "@gem/shared";
import { estimateTokens } from "@gem/shared";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

/** Markdown → sections and block units (SPEC §3C.2). Pure: nothing here touches a database or a model. */

/** A run of source text that can't be cut (`atomic`), or can be, between sentences. */
export interface Unit {
  start: number;
  end: number;
  atomic: boolean;
  /** Headings are kept with what follows them. */
  heading: boolean;
}

export interface ParsedSection {
  order: number;
  parent: number | null;
  level: number;
  title: string;
  slug: string;
  /** Titles from the top, this one included. */
  headingPath: string[];
  /** Slugs from the top, joined by `.`: the middle of a `chunkKey`. */
  slugPath: string;
  start: number;
  end: number;
  units: Unit[];
}

export interface ParsedSource {
  format: SourceFormat;
  sections: ParsedSection[];
  warnings: SourceWarning[];
}

/** A section past this is hard to review and retrieve: a warning, nothing more. */
const LONG_SECTION_TOKENS = 6000;

const ATOMIC = new Set(["code", "table", "math", "html"]);

interface Position {
  start: { offset?: number };
  end: { offset?: number };
}
interface MdNode {
  type: string;
  depth?: number;
  value?: string;
  children?: MdNode[];
  position?: Position;
}

export function slugify(text: string, fallback: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug || fallback;
}

function plainText(node: MdNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(plainText).join("");
}

function trimRange(text: string, start: number, end: number): [number, number] {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s] as string)) s++;
  while (e > s && /\s/.test(text[e - 1] as string)) e--;
  return [s, e];
}

function paragraphs(text: string): Unit[] {
  const units: Unit[] = [];
  const separator = /\n[^\S\n]*\n\s*/g;
  let at = 0;
  for (;;) {
    const m = separator.exec(text);
    const [s, e] = trimRange(text, at, m ? m.index : text.length);
    if (e > s) units.push({ start: s, end: e, atomic: false, heading: false });
    if (!m) return units;
    at = m.index + m[0].length;
  }
}

class SectionBuilder {
  readonly sections: ParsedSection[] = [];
  private readonly used = new Map<number | null, Set<string>>();

  open(level: number, title: string, start: number, stackParent: number | null): ParsedSection {
    const parent = stackParent === null ? null : (this.sections[stackParent] as ParsedSection);
    const order = this.sections.length;
    const siblings = this.used.get(stackParent) ?? new Set<string>();
    this.used.set(stackParent, siblings);
    const base = slugify(title, `s${order + 1}`);
    let slug = base;
    for (let n = 2; siblings.has(slug); n++) slug = `${base}-${n}`;
    siblings.add(slug);
    const section: ParsedSection = {
      order,
      parent: stackParent,
      level,
      title,
      slug,
      headingPath: [...(parent?.headingPath ?? []), title],
      slugPath: parent ? `${parent.slugPath}.${slug}` : slug,
      start,
      end: start,
      units: [],
    };
    this.sections.push(section);
    return section;
  }
}

function warningsFor(markdown: string, sections: ParsedSection[], hasHeadings: boolean): SourceWarning[] {
  const warnings: SourceWarning[] = [];
  if (!hasHeadings) warnings.push({ code: "no_headings" });
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const s of sections) {
    const tokens = estimateTokens(markdown.slice(s.start, s.end));
    if (tokens > LONG_SECTION_TOKENS) warnings.push({ code: "long_section", heading: s.title, tokens });
    const name = s.title.trim().toLowerCase();
    if (seen.has(name) && !reported.has(name)) {
      warnings.push({ code: "duplicate_heading", heading: s.title });
      reported.add(name);
    }
    seen.add(name);
  }
  return warnings;
}

/** Plain text: one section, split by paragraph (SPEC §3C.2). */
function parseText(text: string, title: string): ParsedSource {
  const builder = new SectionBuilder();
  const section = builder.open(1, title, 0, null);
  section.end = text.length;
  section.units = paragraphs(text);
  return { format: "text", sections: builder.sections, warnings: warningsFor(text, builder.sections, false) };
}

export function parseSource(text: string, opts: { title: string; format?: SourceFormat }): ParsedSource {
  if (opts.format === "text") return parseText(text, opts.title);
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(text) as unknown as MdNode;
  const builder = new SectionBuilder();
  const stack: { level: number; order: number }[] = [];
  let current: ParsedSection | null = null;
  let hasHeadings = false;
  for (const node of tree.children ?? []) {
    const nodeStart = node.position?.start.offset ?? 0;
    const nodeEnd = node.position?.end.offset ?? nodeStart;
    if (node.type === "heading") {
      hasHeadings = true;
      const level = node.depth ?? 1;
      while (stack.length > 0 && (stack[stack.length - 1]?.level as number) >= level) stack.pop();
      const parent = stack[stack.length - 1]?.order ?? null;
      if (current) current.end = nodeStart;
      current = builder.open(level, plainText(node).trim() || opts.title, nodeStart, parent);
      stack.push({ level, order: current.order });
      current.units.push({ start: nodeStart, end: nodeEnd, atomic: true, heading: true });
      continue;
    }
    // Text before the first heading is a section of its own, named after the source.
    current ??= builder.open(1, opts.title, nodeStart, null);
    const [start, end] = trimRange(text, nodeStart, nodeEnd);
    if (end > start) current.units.push({ start, end, atomic: ATOMIC.has(node.type), heading: false });
  }
  if (current) current.end = text.length;
  return { format: "markdown", sections: builder.sections, warnings: warningsFor(text, builder.sections, hasHeadings) };
}
