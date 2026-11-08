import { z } from "zod";
import { ErrorCode } from "./errors.ts";

/** Sources and the knowledge base (SPEC §3C, P2.md §4–§5), shared by `packages/knowledge`, the API and the web app. */

export const SOURCE_EMBED_STATUSES = ["pending", "embedding", "ready", "failed"] as const;
export const SourceEmbedStatus = z.enum(SOURCE_EMBED_STATUSES);
export type SourceEmbedStatus = z.infer<typeof SourceEmbedStatus>;

export const SOURCE_FORMATS = ["markdown", "text"] as const;
export const SourceFormat = z.enum(SOURCE_FORMATS);
export type SourceFormat = z.infer<typeof SourceFormat>;

/** Fixes `SourceRevision.embedError`: what the API would have sent. */
export const EmbedError = z.object({
  code: ErrorCode,
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
export type EmbedError = z.infer<typeof EmbedError>;

export const SOURCE_WARNING_CODES = [
  "no_headings",
  "long_section",
  "duplicate_heading",
  "unit_too_large",
  // Found by the PDF converter and our clean-up of its Markdown (docs/P2.2.md §5).
  "figures_dropped",
  "low_text",
  "unbalanced_math",
  "pages_skipped",
  "math_unparsed",
  "math_repaired",
] as const;
export const SourceWarning = z.object({
  code: z.enum(SOURCE_WARNING_CODES),
  /** The heading it's about, when there is one. */
  heading: z.string().optional(),
  tokens: z.number().int().optional(),
  /** A number the message is about: figures dropped, pages left out. */
  count: z.number().int().optional(),
});
export type SourceWarning = z.infer<typeof SourceWarning>;

/** One heading in a preview: nothing is saved, so its place in the list is its identity. */
export const SectionPreview = z.object({
  order: z.number().int(),
  parentOrder: z.number().int().nullable(),
  level: z.number().int(),
  title: z.string(),
  tokens: z.number().int(),
  chunks: z.number().int(),
});
export type SectionPreview = z.infer<typeof SectionPreview>;

export const SourcePreview = z.object({
  sections: z.array(SectionPreview),
  warnings: z.array(SourceWarning),
  chunks: z.number().int(),
  tokens: z.number().int(),
  format: SourceFormat,
});
export type SourcePreview = z.infer<typeof SourcePreview>;

/** The upload limits and thresholds an admin can change. */
export const AuthoringSettings = z.object({
  /** Largest source, in bytes (SPEC §3C.1). */
  maxSourceBytes: z.number().int().min(1024).max(50_000_000),
  /** L2's fuzzy match: below this a quote counts as not found (P2.md §5). */
  groundingThreshold: z.number().min(0.5).max(1),
});
export type AuthoringSettings = z.infer<typeof AuthoringSettings>;

export const DEFAULT_AUTHORING_SETTINGS: AuthoringSettings = {
  maxSourceBytes: 5 * 1024 * 1024,
  groundingThreshold: 0.9,
};

/**
 * The conservative estimate for text with no count from the endpoint (SPEC §3C.2): characters ÷ 3, or ÷ 1.5 for
 * CJK-heavy text, which ÷ 3 undercounts (P1.5 audit, F2).
 */
export function estimateTokens(text: string): number {
  const cjk = text.match(/[぀-ヿ㐀-鿿가-힯豈-﫿]/gu)?.length ?? 0;
  const perToken = cjk / Math.max(text.length, 1) >= 0.3 ? 1.5 : 3;
  return Math.ceil(text.length / perToken);
}

/** A citation as the UI shows it: "VMLS §1.4 Inner product (rev 2)" (SPEC §3C.4). */
export const Citation = z.object({
  sourceId: z.string(),
  citationLabel: z.string(),
  headingPath: z.array(z.string()),
  revision: z.number().int(),
});
export type Citation = z.infer<typeof Citation>;

/**
 * Whether a section is a set of exercises: "Exercises", "3.2 Problems", "Practice problems", "Review questions",
 * "Homework". These pose problems and don't state their answers, so a question made from one has nothing in the source
 * to be right about: an authoring session leaves them out unless they're ticked (SPEC §3C.4). The whole title has to be
 * that, so "Exercises in linear algebra" or a chapter on "Problems of scale" is a section like any other.
 */
export function isExerciseSection(title: string): boolean {
  const plain = title
    .replace(/[*_`#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return /^(?:(?:chapter\s+)?\d+(?:\.\d+)*[.:)]?\s+)?(?:exercises?|problems?|practice\s+(?:exercises?|problems?)|review\s+(?:exercises?|questions?)|homework(?:\s+problems?)?|end[- ]of[- ]chapter\s+(?:exercises?|problems?|questions?))\s*[.:]?$/i.test(
    plain,
  );
}

/**
 * The sections that are exercises: one titled so (`isExerciseSection`) and everything under it. A book keeps its
 * exercises at the end of each chapter, so there is one such section per chapter, and its own subsections.
 */
export function exerciseSectionIds(
  sections: readonly { id: string; parentId: string | null; title: string }[],
): string[] {
  const byId = new Map(sections.map((s) => [s.id, s]));
  const inExercises = (id: string) => {
    for (let at: string | null | undefined = id; at; at = byId.get(at)?.parentId) {
      if (isExerciseSection(byId.get(at)?.title ?? "")) return true;
    }
    return false;
  };
  return sections.filter((s) => inExercises(s.id)).map((s) => s.id);
}
