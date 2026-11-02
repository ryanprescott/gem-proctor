import {
  CONVERT_OPTIONS_HEADER,
  ConvertError,
  type ConvertErrorCode,
  ConvertHealth,
  type ConvertOptions,
  ConvertReply,
} from "@gem/shared";

/**
 * The API's side of the converter contract (docs/P2.2.md §5): a PDF goes in as the raw body, with the options as JSON
 * in a header, and Markdown comes back. Everything that comes back is checked with Zod, so a converter that drifts from
 * the contract fails loudly here and not later in a database.
 */

/** What can go wrong on this side: the converter's own codes, plus the two the client adds. */
export type ConvertClientCode = ConvertErrorCode | "unreachable" | "invalid_reply";

export class ConvertClientError extends Error {
  constructor(
    readonly code: ConvertClientCode,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "ConvertClientError";
  }
}

export interface ConvertClientOptions {
  /** A conversion takes minutes on a long document; the converter enforces its own limit, so this is only a backstop. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export class ConvertClient {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(baseUrl: string, opts: ConvertClientOptions = {}) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetcher = opts.fetch ?? fetch;
  }

  private async call(path: string, init: RequestInit & { timeoutMs?: number }): Promise<Response> {
    const { timeoutMs = this.timeoutMs, signal, ...rest } = init;
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      return await this.fetcher(`${this.base}${path}`, {
        ...rest,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new ConvertClientError("unreachable", `the converter at ${this.base} didn't answer: ${String(err)}`);
    }
  }

  async health(timeoutMs = 10_000): Promise<ConvertHealth> {
    const res = await this.call("/health", { method: "GET", timeoutMs });
    const body = await res.json().catch(() => null);
    const parsed = ConvertHealth.safeParse(body);
    if (!res.ok || !parsed.success) {
      throw new ConvertClientError("invalid_reply", "the converter's /health isn't what the contract says", res.status);
    }
    return parsed.data;
  }

  /** Whether the converter answers and can convert; never throws, for the health route. */
  async ready(): Promise<boolean> {
    try {
      return (await this.health(3000)).models === "ready";
    } catch {
      return false;
    }
  }

  async convert(pdf: Uint8Array, options: ConvertOptions = {}, signal?: AbortSignal): Promise<ConvertReply> {
    const res = await this.call("/convert", {
      method: "POST",
      headers: { "content-type": "application/pdf", [CONVERT_OPTIONS_HEADER]: JSON.stringify(options) },
      body: new Blob([pdf]),
      ...(signal ? { signal } : {}),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const error = ConvertError.safeParse(body);
      if (error.success) throw new ConvertClientError(error.data.code, error.data.message, res.status);
      throw new ConvertClientError("invalid_reply", `the converter answered ${res.status}`, res.status);
    }
    const parsed = ConvertReply.safeParse(body);
    if (!parsed.success) {
      throw new ConvertClientError("invalid_reply", "the converter's reply isn't what the contract says", res.status);
    }
    return parsed.data;
  }
}
