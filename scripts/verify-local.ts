// The real apps/verify parent on this machine, for tests and `bun run e2e`: no container, so no `runner` user and
// no Compose restart. It exits to recycle, so this stands in for the restart policy. The security checks need the
// real container: `bun run verify:escape`.
import { existsSync } from "node:fs";
import { join } from "node:path";

const VERIFY_DIR = join(import.meta.dir, "..", "apps", "verify");

export function findVerifyPython(): string | undefined {
  const candidates = [
    process.env.VERIFY_PYTHON,
    Bun.which("python3.12"),
    join(process.env.HOME ?? "", ".local", "bin", "python3.12"),
  ];
  return candidates.find(
    (p): p is string =>
      !!p &&
      existsSync(p) &&
      Bun.spawnSync([p, "-c", "import sympy, numpy, lark"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0,
  );
}

export interface LocalVerify {
  stop(): Promise<void>;
  /** Parent starts so far. */
  starts(): number;
}

/** Starts the parent and restarts it whenever it exits, like `restart: unless-stopped`. */
export function superviseVerify(python: string, socket: string, args: string[] = []): LocalVerify {
  let current: ReturnType<typeof Bun.spawn>;
  let stopped = false;
  let starts = 0;
  const start = () => {
    starts += 1;
    // No environment at all, like the container (-I: isolated mode, -B: no .pyc writes).
    current = Bun.spawn([python, "-I", "-B", join(VERIFY_DIR, "gem_verify", "server.py"), ...args, socket], {
      env: {},
      stdout: "ignore",
      stderr: "inherit",
    });
    void current.exited.then(() => {
      if (!stopped) start();
    });
  };
  start();
  return {
    starts: () => starts,
    async stop() {
      stopped = true;
      current.kill();
      await current.exited;
    },
  };
}
