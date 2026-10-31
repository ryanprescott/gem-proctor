import { createConnection } from "node:net";
import {
  AppError,
  VERIFY_MAX_PROGRAM_BYTES,
  VERIFY_MAX_REPLY_BYTES,
  type VerifyClient,
  type VerifyHealthReply,
  VerifyHealthReply as VerifyHealthSchema,
  type VerifyKind,
  VerifyReplies,
  type VerifyReply,
  VerifyRequest,
} from "@gem/shared";

export type { VerifyClient } from "@gem/shared";
export { VerifyHealthReply as VerifyHealth } from "@gem/shared";

export interface VerifyClientOptions {
  /** Health and connection checks. */
  timeoutMs?: number;
  /** One run: the wall clock is 10 s, and a child's reply follows it. */
  requestTimeoutMs?: number;
  /** After a dropped connection, how long to wait for a health reply before the retry (P2.1.md §5). */
  healthWaitMs?: number;
  /** `InstanceSettings.verify.recycleEvery`, sent with each request. */
  recycleEvery?: () => Promise<number>;
}

const HEALTH_POLL_MS = 250;

/** The API never evaluates what comes back: it's validated text (SPEC §3A.3.1). */
function checkProgram(...programs: string[]) {
  for (const program of programs) {
    const bytes = Buffer.byteLength(program, "utf8");
    if (bytes > VERIFY_MAX_PROGRAM_BYTES) {
      throw new AppError("verify_program_too_large", { bytes, maxBytes: VERIFY_MAX_PROGRAM_BYTES });
    }
  }
}

class Dropped extends Error {}

/**
 * Newline-delimited JSON over the Unix socket in the shared volume, one request per connection. The API holds no
 * Docker socket: when the runner recycles, it waits for `health` and retries the request once. A second failure
 * is `verify_unavailable`.
 */
export class SocketVerifyClient implements VerifyClient {
  private readonly timeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly healthWaitMs: number;
  private readonly opts: VerifyClientOptions;

  constructor(
    private readonly socketPath: string,
    options: VerifyClientOptions | number = {},
  ) {
    this.opts = typeof options === "number" ? { timeoutMs: options } : options;
    this.timeoutMs = this.opts.timeoutMs ?? 2000;
    this.requestTimeoutMs = this.opts.requestTimeoutMs ?? 20_000;
    this.healthWaitMs = this.opts.healthWaitMs ?? 30_000;
  }

  private exchange(request: object, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let buf = "";
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        sock.destroy();
        fn();
      };
      const drop = () => finish(() => reject(new Dropped()));
      const sock = createConnection(this.socketPath);
      sock.setTimeout(timeoutMs, drop);
      sock.on("error", drop);
      sock.on("end", drop);
      sock.on("connect", () => sock.write(`${JSON.stringify(request)}\n`));
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        if (buf.length > VERIFY_MAX_REPLY_BYTES + 1) return drop();
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        try {
          const parsed: unknown = JSON.parse(buf.slice(0, nl));
          finish(() => resolve(parsed));
        } catch {
          drop();
        }
      });
    });
  }

  async health(): Promise<VerifyHealthReply | null> {
    try {
      const parsed = VerifyHealthSchema.safeParse(await this.exchange({ kind: "health" }, this.timeoutMs));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private async waitForHealth(): Promise<boolean> {
    const deadline = Date.now() + this.healthWaitMs;
    while (Date.now() < deadline) {
      if (await this.health()) return true;
      await Bun.sleep(HEALTH_POLL_MS);
    }
    return false;
  }

  private async attempt<K extends VerifyKind>(kind: K, request: object): Promise<VerifyReply<K>> {
    const reply = await this.exchange(request, this.requestTimeoutMs);
    const parsed = VerifyReplies[kind].safeParse(reply);
    if (!parsed.success) throw new Dropped();
    return parsed.data as VerifyReply<K>;
  }

  private async request<K extends VerifyKind>(kind: K, body: object): Promise<VerifyReply<K>> {
    const recycleEvery = await this.opts.recycleEvery?.();
    const request = VerifyRequest.parse({ kind, ...body, ...(recycleEvery ? { recycleEvery } : {}) });
    try {
      return await this.attempt(kind, request);
    } catch (err) {
      if (!(err instanceof Dropped)) throw err;
    }
    if (!(await this.waitForHealth())) throw new AppError("verify_unavailable");
    try {
      return await this.attempt(kind, request);
    } catch (err) {
      if (!(err instanceof Dropped)) throw err;
      throw new AppError("verify_unavailable");
    }
  }

  run(request: Parameters<VerifyClient["run"]>[0]) {
    checkProgram(request.program);
    return this.request("run", request);
  }

  sampleInputs(request: Parameters<VerifyClient["sampleInputs"]>[0]) {
    checkProgram(request.constraint, request.answerProgram);
    return this.request("sample_inputs", request);
  }

  parseOptions(request: Parameters<VerifyClient["parseOptions"]>[0]) {
    return this.request("parse_options", request);
  }

  compare(request: Parameters<VerifyClient["compare"]>[0]) {
    return this.request("compare", request);
  }

  buildOptions(request: Parameters<VerifyClient["buildOptions"]>[0]) {
    return this.request("build_options", request);
  }
}
