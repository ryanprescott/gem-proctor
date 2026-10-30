import type { EndpointServer } from "@gem/shared";

/**
 * A mock OpenAI-compatible server (P1.5.md §5, "Live checks"): chat (plain and SSE), embeddings with silent
 * truncation at a cap, model discovery, each `server` value's context endpoint, and a mocked Anthropic
 * `/v1/messages`. Tokens are whitespace-separated words, so a test can size inputs exactly.
 */

export type ChatReply =
  | string
  | { text: string; delayMs?: number; finishReason?: string; chunks?: string[] }
  | { status: number; body?: unknown };

export interface MockOptions {
  server?: EndpointServer;
  /** Default 127.0.0.1. */
  hostname?: string;
  /** Required as `Authorization: Bearer …` or `x-api-key`; anything else is 401. */
  apiKey?: string;
  models?: string[];
  /** Reported context: `/api/show`, `/props` or `max_model_len`, depending on `server`. */
  contextLength?: number;
  /** No `/v1/models` at all. */
  noModels?: boolean;
  dimensions?: number;
  /** Embedding inputs are cut here, without an error, and `prompt_tokens` stops growing. */
  embedCap?: number;
  /** Fallback for chat requests when the reply list is empty. */
  reply?: (body: Record<string, unknown>) => ChatReply;
}

export interface CapturedRequest {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A deterministic unit vector; a change in any word gives an unrelated one. */
export function mockVector(text: string, dimensions: number): number[] {
  let h = 2166136261;
  for (const word of text.split(/\s+/).filter(Boolean)) h = hash(`${h}:${word}`);
  const out = Array.from({ length: dimensions }, (_, i) => hash(`${h}/${i}`) / 2 ** 31 - 1);
  const norm = Math.sqrt(out.reduce((n, x) => n + x * x, 0)) || 1;
  return out.map((x) => x / norm);
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MockLlmServer {
  readonly requests: CapturedRequest[] = [];
  /** Consumed one per chat request, then `options.reply`, then `{}`. */
  readonly replies: ChatReply[] = [];
  /** Vector length to send instead of `dimensions` (the wrong-length scenario). */
  wrongDimensions: number | undefined;
  inFlight = 0;
  maxInFlight = 0;
  private readonly server: ReturnType<typeof Bun.serve>;

  constructor(readonly options: MockOptions = {}) {
    const hostname = options.hostname ?? "127.0.0.1";
    this.server = Bun.serve({ port: 0, hostname, idleTimeout: 0, fetch: (req) => this.handle(req) });
  }

  get port(): number {
    return this.server.port as number;
  }
  get root(): string {
    return `http://127.0.0.1:${this.port}`;
  }
  get url(): string {
    return `${this.root}/v1`;
  }

  chatRequests(): CapturedRequest[] {
    return this.requests.filter((r) => r.path.endsWith("/chat/completions") || r.path.endsWith("/messages"));
  }

  stop() {
    this.server.stop(true);
  }

  private async handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const text = req.method === "GET" ? "" : await req.text();
    const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    this.requests.push({ path, headers: Object.fromEntries(req.headers), body });

    const { apiKey } = this.options;
    if (apiKey) {
      const given = req.headers.get("x-api-key") ?? req.headers.get("authorization")?.replace(/^Bearer /, "");
      if (given !== apiKey) return json({ error: { message: "bad key" } }, 401);
    }

    if (path === "/v1/chat/completions") return this.chat(body);
    if (path === "/v1/messages") return this.anthropic(body);
    if (path === "/v1/embeddings") return this.embeddings(body);
    if (path === "/v1/models" && !this.options.noModels) return this.models();
    if (path === "/api/show" && this.options.server === "ollama") {
      return json({ parameters: `temperature 0.7\nnum_ctx ${this.options.contextLength ?? 4096}\n`, model_info: {} });
    }
    if (path === "/props" && this.options.server === "llamacpp") {
      return json({ default_generation_settings: { n_ctx: this.options.contextLength ?? 4096 } });
    }
    return json({ error: { message: "not found" } }, 404);
  }

  private models(): Response {
    const ids = this.options.models ?? ["mock-model"];
    const extra = this.options.server === "vllm" ? { max_model_len: this.options.contextLength ?? 4096 } : {};
    return json({ object: "list", data: ids.map((id) => ({ id, object: "model", ...extra })) });
  }

  private nextReply(body: Record<string, unknown>): ChatReply {
    return this.replies.shift() ?? this.options.reply?.(body) ?? "{}";
  }

  private async withSlot(run: () => Promise<Response>): Promise<Response> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      return await run();
    } finally {
      this.inFlight--;
    }
  }

  private chat(body: Record<string, unknown>): Promise<Response> {
    return this.withSlot(async () => {
      const reply = this.nextReply(body);
      if (typeof reply === "object" && "status" in reply) {
        return json(reply.body ?? { error: { message: "mock error" } }, reply.status);
      }
      const r = typeof reply === "string" ? { text: reply } : reply;
      if (r.delayMs) await sleep(r.delayMs);
      const finish_reason = r.finishReason ?? "stop";
      const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
      const base = { id: "mock", object: "chat.completion", created: 1, model: String(body.model) };
      if (body.stream !== true) {
        const message = { role: "assistant", content: r.text };
        return json({ ...base, choices: [{ index: 0, message, finish_reason }], usage });
      }
      const chunks = r.chunks ?? [r.text];
      const frame = (delta: unknown, finish: string | null, extra = {}) =>
        `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
      async function* frames() {
        for (const c of chunks) {
          yield frame({ role: "assistant", content: c }, null);
          await sleep(5);
        }
        yield frame({}, finish_reason, { usage });
        yield "data: [DONE]\n\n";
      }
      return new Response((ReadableStream as unknown as { from(i: unknown): ReadableStream }).from(frames()), {
        headers: { "content-type": "text/event-stream" },
      });
    });
  }

  private anthropic(body: Record<string, unknown>): Promise<Response> {
    return this.withSlot(async () => {
      const reply = this.nextReply(body);
      if (typeof reply === "object" && "status" in reply) {
        return json(reply.body ?? { type: "error", error: { type: "api_error", message: "mock" } }, reply.status);
      }
      const text = typeof reply === "string" ? reply : reply.text;
      const tools = (body.tools ?? []) as { name: string }[];
      const content = tools[0]
        ? [{ type: "tool_use", id: "t1", name: tools[0].name, input: JSON.parse(text) }]
        : [{ type: "text", text }];
      return json({
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model: body.model,
        content,
        stop_reason: tools[0] ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 20 },
      });
    });
  }

  private embeddings(body: Record<string, unknown>): Response {
    const inputs = (Array.isArray(body.input) ? body.input : [body.input]) as string[];
    const dimensions = this.wrongDimensions ?? this.options.dimensions ?? 8;
    const cap = this.options.embedCap ?? Number.POSITIVE_INFINITY;
    let promptTokens = 0;
    const data = inputs.map((text, index) => {
      const words = text.split(/\s+/).filter(Boolean).slice(0, cap);
      promptTokens += words.length;
      return { object: "embedding", index, embedding: mockVector(words.join(" "), dimensions) };
    });
    return json({
      object: "list",
      model: body.model,
      data,
      usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
    });
  }
}
