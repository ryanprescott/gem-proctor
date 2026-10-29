import { createConnection } from "node:net";
import { z } from "zod";

/** The verify worker's health reply (P0.md §5, SPEC §3A.3.1). Validated, never evaluated. */
export const VerifyHealth = z.object({ ok: z.literal(true), sympy: z.string().max(50), numpy: z.string().max(50) });
export type VerifyHealth = z.infer<typeof VerifyHealth>;

const MAX_REPLY_BYTES = 64 * 1024;

export interface VerifyClient {
  health(): Promise<VerifyHealth | null>;
}

/** Newline-delimited JSON over the Unix socket in the shared volume. */
export class SocketVerifyClient implements VerifyClient {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = 2000,
  ) {}

  health(): Promise<VerifyHealth | null> {
    return new Promise((resolve) => {
      let buf = "";
      let done = false;
      const finish = (v: VerifyHealth | null) => {
        if (done) return;
        done = true;
        sock.destroy();
        resolve(v);
      };
      const sock = createConnection(this.socketPath);
      sock.setTimeout(this.timeoutMs, () => finish(null));
      sock.on("error", () => finish(null));
      sock.on("connect", () => sock.write(`${JSON.stringify({ kind: "health" })}\n`));
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        if (buf.length > MAX_REPLY_BYTES) return finish(null);
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        try {
          const parsed = VerifyHealth.safeParse(JSON.parse(buf.slice(0, nl)));
          finish(parsed.success ? parsed.data : null);
        } catch {
          finish(null);
        }
      });
      sock.on("end", () => finish(null));
    });
  }
}
