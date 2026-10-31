// The API's socket client against the real parent (P2.1.md C8, C13): recycling, health wait, one retry, size guard.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError, VERIFY_MAX_PROGRAM_BYTES } from "@gem/shared";
import { findVerifyPython, type LocalVerify, superviseVerify } from "../../../scripts/verify-local.ts";
import { SocketVerifyClient } from "../src/verify-client.ts";

const python = findVerifyPython();

function codeOf(err: unknown) {
  return err instanceof AppError ? err.code : String(err);
}

describe.skipIf(!python)("VerifyClient (real parent)", () => {
  let dir: string;
  let socket: string;
  let verify: LocalVerify;
  let client: SocketVerifyClient;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "gem-client-"));
    socket = join(dir, "verify", "verify.sock");
    verify = superviseVerify(python as string, socket);
    client = new SocketVerifyClient(socket, { timeoutMs: 1000 });
    for (let i = 0; i < 200 && !(await client.health()); i++) await Bun.sleep(100);
  }, 30_000);

  afterAll(async () => {
    await verify.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("C1: a Q7 run returns -1 with its LaTeX, through the validated contract", async () => {
    const reply = await client.run({
      program: "from sympy import Matrix\nx = Matrix([2, 4, -3]); y = Matrix([5, -2, 1])\nresult = x.dot(y)",
    });
    expect(reply).toMatchObject({ ok: true, status: "ok", value: { kind: "integer", value: "-1", latex: "-1" } });
    expect(reply.sandboxVersion).toContain("sympy/");
  });

  test("C8: after an anomaly the parent exits, and the next request waits for health and gets through", async () => {
    const starts = verify.starts();
    const denied = await client.run({ program: "import os\nos.fork()" });
    expect(denied.status).toBe("sandbox_denial");
    const next = await client.run({ program: "result = 1" });
    expect(next.value?.value).toBe("1");
    expect(verify.starts()).toBe(starts + 1);
  }, 30_000);

  test("C8: a request the runner never answers is retried once, then verify_unavailable", async () => {
    const dead = new SocketVerifyClient(join(dir, "nothing.sock"), { healthWaitMs: 300, timeoutMs: 100 });
    const started = Date.now();
    await expect(dead.run({ program: "result = 1" }).catch(codeOf)).resolves.toBe("verify_unavailable");
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  test("C8: recycleEvery comes from the settings and is sent with the request", async () => {
    const budget = new SocketVerifyClient(socket, { timeoutMs: 1000, recycleEvery: async () => 1 });
    const starts = verify.starts();
    await budget.run({ program: "result = 1" });
    await client.run({ program: "result = 2" });
    expect(verify.starts()).toBe(starts + 1);
  }, 30_000);

  test("a program over 4 KB is rejected before it's sent", async () => {
    const program = `result = 1 # ${"x".repeat(VERIFY_MAX_PROGRAM_BYTES)}`;
    await expect(
      Promise.resolve()
        .then(() => client.run({ program }))
        .catch(codeOf),
    ).resolves.toBe("verify_program_too_large");
  });

  test("C13: a request off the contract throws before it's sent", async () => {
    await expect(Promise.resolve().then(() => client.parseOptions({ texts: [] }))).rejects.toThrow();
  });

  test("the real entrypoint leaves a child its address space (no NumPy threads before the limits)", async () => {
    const reply = await client.run({
      program: "x = bytes(200_000_000)\nresult = int(open('/proc/self/status').read().split('Threads:')[1].split()[0])",
    });
    expect(reply).toMatchObject({ status: "ok", value: { value: "1" } });
    const parsed = await client.parseOptions({ texts: ["$n - 1$ flops", "$-3e_1 + 8e_2 + e_3$"] });
    expect(parsed.results?.map((r) => r.ok)).toEqual([true, true]);
  });

  test("parse, compare and build through the socket", async () => {
    const parsed = await client.parseOptions({ texts: ["0.5", String.raw`$\frac{1}{2}$`, "Undefined"] });
    const [a, b, c] = parsed.results ?? [];
    expect(c).toEqual({ ok: false, reason: "text" });
    if (!a?.ok || !b?.ok) throw new Error("parse failed");
    const compared = await client.compare({ a: a.value, candidates: [b.value], tolerance: 1e-6 });
    expect(compared.results).toEqual([{ equal: true, guard: false }]);
    const built = await client.buildOptions({ answer: a.value, mistakes: [], seed: "x", distractorCount: 3 });
    expect(built.options).toHaveLength(4);
  });
});
