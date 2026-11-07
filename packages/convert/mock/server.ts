import {
  CONVERT_ERROR_STATUS,
  CONVERT_OPTIONS_HEADER,
  type ConvertErrorCode,
  ConvertOptions,
  type ConvertPage,
  type ConvertReply,
  type OutlineEntry,
} from "@gem/shared";

/**
 * A mock converter (docs/P2.2.md §5 "Mock"): the same two routes as `apps/convert`, with a delay and a switch for each
 * failure, so no test needs Marker or a GPU. Like the stub engine, it reads what to do from the PDF's own bytes, so a
 * test says `%MOCK:pages=3` in its "PDF" and nothing else is configured.
 */

export interface MockConvertOptions {
  /** Markdown to answer with; the default has a heading and an equation. */
  markdown?: string;
  /** Named documents: a PDF that says `%MOCK:doc=name` is answered with `documents[name]`. */
  documents?: Record<string, string>;
  /** Answers a real PDF, which can't carry flags (the fixtures, for `convert-smoke`): Markdown, or undefined to fall through. */
  answer?: (pdf: Buffer, options: ConvertOptions) => string | undefined;
  /** Page by page instead: the Markdown for one page (from 1), or undefined for a blank one. */
  pageAnswer?: (page: number, options: ConvertOptions) => string | undefined;
  /** The PDF's bookmarks; a PDF can also say `%MOCK:outline=Title:level:page;…`. */
  outline?: OutlineEntry[];
  /** Every conversion waits this long. */
  delayMs?: number;
  /** Every conversion fails with this code. */
  fail?: ConvertErrorCode;
  /** A failure for one request: given its options and its number (from 1), a code, or undefined to answer. */
  failWhen?: (options: ConvertOptions, n: number) => ConvertErrorCode | undefined;
  maxBytes?: number;
  maxPages?: number;
}

export interface CapturedConversion {
  bytes: number;
  options: ConvertOptions;
}

const DEFAULT_MARKDOWN = "# Mock\n\nThe mock read this. $x^T y = 0$.\n";
const flag = (text: string, name: string) => new RegExp(`%MOCK:${name}(?:=([^\\r\\n]*))?`).exec(text)?.[1];
/** Whether the flag is there at all, with or without a value. */
const has = (text: string, name: string) => new RegExp(`%MOCK:${name}(?:=|[\\r\\n]|$)`).test(text);

/** The pages a range selects (from 1), or null for one past the end. */
function pagesOf(range: string | undefined, pageCount: number): number[] | null {
  if (!range) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const pages = new Set<number>();
  for (const part of range.split(",")) {
    const [low, high = low] = part.split("-").map(Number) as [number, number?];
    if (low < 1 || (high as number) < low || (high as number) > pageCount) return null;
    for (let p = low; p <= (high as number); p++) pages.add(p);
  }
  return [...pages].sort((a, b) => a - b);
}

const outlineOf = (text: string | undefined): OutlineEntry[] =>
  (text ?? "")
    .split(";")
    .filter(Boolean)
    .map((part) => {
      const [title = "", level = "0", page = ""] = part.split(":");
      return { title, level: Number(level), page: page === "" ? null : Number(page) };
    });

export class MockConvertServer {
  readonly conversions: CapturedConversion[] = [];
  inFlight = 0;
  maxInFlight = 0;
  private readonly server: ReturnType<typeof Bun.serve>;

  constructor(readonly options: MockConvertOptions = {}) {
    this.server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: (req) => this.handle(req) });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  stop() {
    this.server.stop(true);
  }

  private error(code: ConvertErrorCode, message = code.replace(/_/g, " ")) {
    return Response.json({ code, message }, { status: CONVERT_ERROR_STATUS[code] });
  }

  private async handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && path === "/health") {
      return Response.json({
        ok: true,
        engine: "stub",
        engineVersion: "mock",
        models: "ready",
        busy: this.inFlight > 0,
        queued: Math.max(this.inFlight - 1, 0),
        conversions: this.conversions.length,
        workerStarts: 1,
        limits: {
          maxBytes: this.options.maxBytes ?? 50 * 1024 * 1024,
          maxPages: this.options.maxPages ?? 400,
          baseSeconds: 60,
          secondsPerPage: 40,
        },
      });
    }
    if (req.method !== "POST" || path !== "/convert") return this.error("bad_request", "no such route");

    let options: ConvertOptions;
    try {
      options = ConvertOptions.parse(JSON.parse(req.headers.get(CONVERT_OPTIONS_HEADER) ?? "{}"));
    } catch {
      return this.error("bad_request", `${CONVERT_OPTIONS_HEADER} does not match the contract`);
    }
    const pdf = Buffer.from(await req.arrayBuffer());
    if (pdf.length > (this.options.maxBytes ?? 50 * 1024 * 1024)) return this.error("too_large");
    if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) return this.error("not_pdf");
    const text = pdf.toString("latin1");

    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      this.conversions.push({ bytes: pdf.length, options });
      if (this.options.delayMs) await Bun.sleep(this.options.delayMs);
      const fail =
        this.options.fail ??
        this.options.failWhen?.(options, this.conversions.length) ??
        (flag(text, "fail") as ConvertErrorCode | undefined);
      if (fail) return this.error(fail);
      const pageCount = Number(flag(text, "pages") ?? 1);
      if (pageCount > (this.options.maxPages ?? 400)) return this.error("too_many_pages");
      const selected = pagesOf(options.pageRange, pageCount);
      if (!selected) return this.error("bad_range");
      const named = this.options.documents?.[flag(text, "doc") ?? ""];
      const answered = this.options.answer?.(pdf, options);
      // The canned Markdown is the whole document, and page 1's: later pages read alone are blank, as the API's
      // batches ask for them (the real converter answers `empty` for a request of blank pages).
      const canned = named ?? this.options.markdown ?? DEFAULT_MARKDOWN;
      const pages: ConvertPage[] = selected.map((page, i) => ({
        page,
        markdown: has(text, "empty")
          ? ""
          : this.options.pageAnswer
            ? (this.options.pageAnswer(page, options) ?? "")
            : answered !== undefined
              ? i === 0
                ? answered
                : ""
              : page === 1
                ? canned
                : "",
      }));
      const markdown = pages
        .map((p) => p.markdown)
        .filter((m) => m.trim() !== "")
        .join("\n\n");
      if (markdown.trim() === "") return this.error("empty");
      const reply: ConvertReply = {
        markdown,
        pages,
        outline: this.options.outline ?? outlineOf(flag(text, "outline")),
        pageCount,
        pagesConverted: selected.length,
        figures: Number(flag(text, "figures") ?? 0),
        strategy: options.strategy ?? "rasterize",
        converter: { name: "mock", version: "0" },
        seconds: 0,
      };
      return Response.json(reply);
    } finally {
      this.inFlight -= 1;
    }
  }
}
