import { createHash } from "node:crypto";
import { estimateTokens } from "@gem/shared";
import type { ParsedSection, ParsedSource, Unit } from "./parse.ts";
import { slugify } from "./parse.ts";

/**
 * Sections → chunks (SPEC §3C.2, P2.md §5). A chunk is a slice of the revision's text, so its offsets give back
 * exactly its text, and LaTeX stays as it was written. Code blocks, tables and `$$` blocks are never cut.
 */

export const TARGET_TOKENS = 500;
/** Each chunk repeats up to this much of the end of the one before. */
export const OVERLAP_TOKENS = 60;

export interface ChunkDraft {
  section: number;
  chunkKey: string;
  charStart: number;
  charEnd: number;
  text: string;
  contentHash: string;
  tokenCount: number;
}

export interface ChunkOptions {
  citationLabel: string;
  /** The embeddings role's `maxInputTokens` minus the document prefix; none while the role isn't assigned. */
  maxTokens?: number;
}

/** A unit that can't be split and doesn't fit. Fails ingest, never embedded truncated (SPEC §3C.2). */
export class UnitTooLargeError extends Error {
  constructor(
    readonly heading: string,
    readonly tokens: number,
    readonly maxTokens: number,
  ) {
    super("knowledge_unit_too_large");
  }
}

export const hashText = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** Where sentences end in `text[start, end)`, outside `$…$`: the ends of the sentences. */
function sentenceEnds(text: string, start: number, end: number): number[] {
  const ends: number[] = [];
  let inMath = false;
  for (let i = start; i < end; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "$") inMath = !inMath;
    else if (!inMath && (c === "." || c === "!" || c === "?") && /\s/.test(text[i + 1] ?? "")) ends.push(i + 1);
    else if (!inMath && c === "\n") ends.push(i);
  }
  return ends;
}

/** Where words end, outside `$…$`, for a sentence too long to keep whole. */
function wordEnds(text: string, start: number, end: number): number[] {
  const ends: number[] = [];
  let inMath = false;
  for (let i = start; i < end; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "$") inMath = !inMath;
    else if (!inMath && /\s/.test(c as string)) ends.push(i);
  }
  return ends;
}

function cutAt(text: string, unit: Unit, ends: number[], limit: number): Unit[] {
  const out: Unit[] = [];
  let from = unit.start;
  let last = from;
  for (const end of [...ends, unit.end]) {
    if (estimateTokens(text.slice(from, end)) > limit && last > from) {
      out.push({ ...unit, start: from, end: last });
      from = last;
      while (from < unit.end && /\s/.test(text[from] as string)) from++;
    }
    last = end;
  }
  if (unit.end > from) out.push({ ...unit, start: from, end: unit.end });
  return out;
}

/** A paragraph over the limit goes by sentences, and a sentence over the limit by words. */
function splitUnit(text: string, unit: Unit, limit: number): Unit[] {
  if (unit.atomic || estimateTokens(text.slice(unit.start, unit.end)) <= limit) return [unit];
  return cutAt(text, unit, sentenceEnds(text, unit.start, unit.end), limit).flatMap((piece) =>
    estimateTokens(text.slice(piece.start, piece.end)) <= limit
      ? [piece]
      : cutAt(text, piece, wordEnds(text, piece.start, piece.end), limit),
  );
}

/** Where the next chunk starts, to repeat the last sentences of `last`. Null when it can't be small. */
function overlapStart(text: string, last: Unit): number | null {
  if (last.atomic) return null;
  if (estimateTokens(text.slice(last.start, last.end)) <= OVERLAP_TOKENS) return last.start;
  const ends = sentenceEnds(text, last.start, last.end).filter((e) => e < last.end);
  for (const e of ends) {
    let s = e;
    while (s < last.end && /\s/.test(text[s] as string)) s++;
    if (estimateTokens(text.slice(s, last.end)) <= OVERLAP_TOKENS) return s;
  }
  return null;
}

function chunkSection(text: string, section: ParsedSection, opts: ChunkOptions, prefix: string): ChunkDraft[] {
  if (!section.units.some((u) => !u.heading)) return [];
  const max = opts.maxTokens ?? Number.POSITIVE_INFINITY;
  const room = Math.min(TARGET_TOKENS, max);
  // Split text leaves room for the heading it may follow and the overlap it may start with.
  const heading = section.units.find((u) => u.heading);
  const headingTokens = heading ? estimateTokens(text.slice(heading.start, heading.end)) + 1 : 0;
  const reserve = headingTokens + (room > OVERLAP_TOKENS * 2 ? OVERLAP_TOKENS : 0);
  const limit = Math.max(1, room - reserve);
  const pieces: Unit[] = [];
  for (const unit of section.units) {
    for (const piece of splitUnit(text, unit, limit)) {
      const tokens = estimateTokens(text.slice(piece.start, piece.end));
      if (tokens > max) throw new UnitTooLargeError(section.headingPath.join(" › "), tokens, max);
      pieces.push(piece);
    }
  }

  const ranges: [number, number][] = [];
  let start: number | null = null;
  let end = 0;
  let previous: Unit | null = null;
  for (const piece of pieces) {
    if (start !== null && estimateTokens(text.slice(start, piece.end)) > room && !previous?.heading) {
      ranges.push([start, end]);
      const repeat: number | null = previous ? overlapStart(text, previous) : null;
      const fits: boolean = repeat !== null && estimateTokens(text.slice(repeat, piece.end)) <= room;
      start = fits && repeat !== null && repeat > start ? repeat : piece.start;
    }
    start ??= piece.start;
    end = piece.end;
    previous = piece;
  }
  if (start !== null) ranges.push([start, end]);

  return ranges.map(([charStart, charEnd], n) => {
    const chunk = text.slice(charStart, charEnd);
    return {
      section: section.order,
      chunkKey: `${prefix}:${section.slugPath}:c${n + 1}`,
      charStart,
      charEnd,
      text: chunk,
      contentHash: hashText(chunk),
      tokenCount: estimateTokens(chunk),
    };
  });
}

export function chunkSource(text: string, parsed: ParsedSource, opts: ChunkOptions): ChunkDraft[] {
  const prefix = slugify(opts.citationLabel, "source");
  return parsed.sections.flatMap((s) => chunkSection(text, s, opts, prefix));
}
