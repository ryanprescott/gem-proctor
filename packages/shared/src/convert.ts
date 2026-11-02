import { z } from "zod";

/**
 * The converter contract (docs/P2.2.md §5). Zod here is the source; its JSON Schema is exported to
 * `apps/convert/gem_convert/contract.json`, the converter validates its requests and its own replies against it with a
 * small stdlib validator, and the API validates what it gets back. A PDF goes in as the raw request body
 * (`content-type: application/pdf`), with the options as JSON in the `x-gem-options` header; Markdown comes back.
 */

/** The converter's own cap on a reply; over it is `failed`, and nothing is sent. */
export const CONVERT_MAX_REPLY_BYTES = 16 * 1024 * 1024;
/** The name of the header that carries `ConvertOptions`. */
export const CONVERT_OPTIONS_HEADER = "x-gem-options";

export const CONVERT_STRATEGIES = ["rasterize", "text"] as const;
export const ConvertStrategy = z.enum(CONVERT_STRATEGIES);
export type ConvertStrategy = z.infer<typeof ConvertStrategy>;

/** "5-23", "1,4,9-12": 1-based pages, as a reader counts them. */
export const PAGE_RANGE_PATTERN = "^\\d+(-\\d+)?(,\\d+(-\\d+)?)*$";

/** What an admin can change; the converter's own limits (pages, time) are its environment's (docs/P2.2.md §4). */
export const ConvertSettings = z.object({
  /** Largest PDF, in bytes. */
  maxFileBytes: z
    .number()
    .int()
    .min(1024 * 1024)
    .max(500 * 1024 * 1024),
  /** `rasterize` reads whole pages with the vision model; `text` keeps the PDF's own text layer. */
  strategy: z.enum(["rasterize", "text"]),
});
export type ConvertSettings = z.infer<typeof ConvertSettings>;

export const DEFAULT_CONVERT_SETTINGS: ConvertSettings = { maxFileBytes: 50 * 1024 * 1024, strategy: "rasterize" };

export const ConvertOptions = z.strictObject({
  pageRange: z.string().max(100).regex(new RegExp(PAGE_RANGE_PATTERN)).optional(),
  /** Absent: the converter's own default (`rasterize`). */
  strategy: ConvertStrategy.optional(),
});
export type ConvertOptions = z.infer<typeof ConvertOptions>;

export const ConvertReply = z.strictObject({
  /** Marker's Markdown, with equations as `$…$` and `$$…$$`; cleaned up by the API, not here. */
  markdown: z.string(),
  /** Pages in the document, and how many of them were read. */
  pageCount: z.number().int().min(1),
  pagesConverted: z.number().int().min(1),
  /** Images Marker found and the text dropped (P2.2.md §3: figures aren't kept). */
  figures: z.number().int().min(0),
  strategy: ConvertStrategy,
  converter: z.strictObject({ name: z.string().max(40), version: z.string().max(40) }),
  seconds: z.number().min(0),
});
export type ConvertReply = z.infer<typeof ConvertReply>;

export const CONVERT_ERROR_CODES = [
  "bad_request",
  "too_large",
  "not_pdf",
  "too_many_pages",
  "bad_pdf",
  "bad_range",
  "empty",
  "timeout",
  "failed",
  "busy",
] as const;
export const ConvertErrorCode = z.enum(CONVERT_ERROR_CODES);
export type ConvertErrorCode = z.infer<typeof ConvertErrorCode>;

/** What each code is, as an HTTP status. */
export const CONVERT_ERROR_STATUS: Record<ConvertErrorCode, number> = {
  bad_request: 400,
  too_large: 413,
  not_pdf: 415,
  too_many_pages: 422,
  bad_pdf: 422,
  bad_range: 422,
  empty: 422,
  timeout: 504,
  failed: 500,
  busy: 503,
};

export const ConvertError = z.strictObject({ code: ConvertErrorCode, message: z.string().max(500) });
export type ConvertError = z.infer<typeof ConvertError>;

export const CONVERT_ENGINES = ["marker", "stub"] as const;

export const ConvertHealth = z.strictObject({
  /** The service answers. `models` says whether it can convert yet. */
  ok: z.literal(true),
  engine: z.enum(CONVERT_ENGINES),
  engineVersion: z.string().max(40),
  models: z.enum(["loading", "ready", "failed"]),
  /** A conversion is running, and how many requests wait behind it. */
  busy: z.boolean(),
  queued: z.number().int().min(0),
  /** Conversions since the worker started, and the limit before it is replaced. */
  conversions: z.number().int().min(0),
  workerStarts: z.number().int().min(1),
  limits: z.strictObject({
    maxBytes: z.number().int(),
    maxPages: z.number().int(),
    baseSeconds: z.number().int(),
    secondsPerPage: z.number().int(),
  }),
});
export type ConvertHealth = z.infer<typeof ConvertHealth>;
