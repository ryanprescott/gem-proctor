// The real apps/verify parent, spawned locally, answered through the API's socket client (P0.md A33,
// health half). Needs a Python 3.12 with the pinned sympy/numpy/lark (VERIFY_PYTHON, or python3.12 on
// PATH / in ~/.local/bin); skipped otherwise. The container half of A33 is checked against Compose.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SocketVerifyClient } from "../src/verify-client.ts";

const VERIFY_DIR = join(import.meta.dir, "..", "..", "verify");
const candidates = [
  process.env.VERIFY_PYTHON,
  Bun.which("python3.12") ?? undefined,
  join(process.env.HOME ?? "", ".local", "bin", "python3.12"),
].filter((p): p is string => !!p && existsSync(p));

function hasLibs(python: string): boolean {
  const r = Bun.spawnSync([python, "-c", "import sympy, numpy, lark"], { stdout: "ignore", stderr: "ignore" });
  return r.exitCode === 0;
}
const python = candidates.find(hasLibs);
const pinned = Object.fromEntries(
  readFileSync(join(VERIFY_DIR, "requirements.txt"), "utf8")
    .split("\n")
    .filter((l) => /^[a-z]+==/.test(l))
    .map((l) => l.split("==") as [string, string]),
);

describe.skipIf(!python)("verify skeleton (real Python parent)", () => {
  test("health over the Unix socket returns the pinned sympy/numpy versions", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "gem-verify-")), "run", "verify.sock");
    // No environment at all, like the container (-I: isolated mode, -B: no .pyc writes).
    const proc = Bun.spawn([python as string, "-I", "-B", join(VERIFY_DIR, "gem_verify", "server.py"), sock], {
      cwd: VERIFY_DIR,
      env: {},
      stdout: "pipe",
      stderr: "inherit",
    });
    try {
      const reader = proc.stdout.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(JSON.parse(first)).toMatchObject({ event: "listening" });
      const health = await new SocketVerifyClient(sock, 5000).health();
      expect(health).toEqual({ ok: true, sympy: pinned.sympy as string, numpy: pinned.numpy as string });
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 30_000);
});
