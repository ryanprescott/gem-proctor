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

export const SOURCE_WARNING_CODES = ["no_headings", "long_section", "duplicate_heading", "unit_too_large"] as const;
export const SourceWarning = z.object({
  code: z.enum(SOURCE_WARNING_CODES),
  /** The heading it's about, when there is one. */
  heading: z.string().optional(),
  tokens: z.number().int().optional(),
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
