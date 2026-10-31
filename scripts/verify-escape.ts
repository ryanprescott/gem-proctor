// bun run verify:escape [--runtime runsc] — the escape suite (SPEC §3A.3.1, P2.1.md C7, C36), against the real
// `verify` service from docker/compose.yaml: the same image, limits, capabilities, read-only root, no network.
// Every hostile program must fail in the expected way, and the next normal run must give the right value.
// The client sits in a second container sharing the socket volume, as the API does.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./pg-local.ts";

type Reply = {
  ok?: boolean;
  status?: string;
  errorType?: string;
  error?: string;
  durationMs?: number;
  value?: { kind: string; value: string | string[] };
};

const runtime = process.argv.includes("--runtime") ? process.argv[process.argv.indexOf("--runtime") + 1] : undefined;
const project = `gem-escape-${process.pid}`;
const SOCKET_VOLUME = `${project}_verify-socket`;
// Compose checks every variable in the file, even for a service that doesn't use them.
const env = {
  ...(process.env as Record<string, string>),
  POSTGRES_PASSWORD: "unused",
  GEM_OWNER_PASSWORD: "unused",
  GEM_APP_PASSWORD: "unused",
  SESSION_SECRET: "unused",
};
const compose = ["compose", "-p", project, "-f", "docker/compose.yaml"];
if (runtime === "runsc") compose.push("-f", "docker/compose.prod.yaml");

function docker(args: string[], check = true): string {
  const r = Bun.spawnSync(["docker", ...args], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
  if (check && r.exitCode !== 0) throw new Error(`docker ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

if (runtime) {
  const runtimes = docker(["info", "--format", "{{json .Runtimes}}"]);
  if (!(runtime in JSON.parse(runtimes))) {
    console.error(
      `blocked: Docker has no \`${runtime}\` runtime here. Install gVisor and register it in daemon.json; the API reaches the runner over a Unix socket across containers, which gVisor restricts by default, so it may need \`runsc --host-uds=open\` (docs/P2.1.md §5).`,
    );
    process.exit(2);
  }
}

const CLIENT = readFileSync(join(ROOT, "apps/verify/tests/escape_client.py"), "utf8");
const Q7 = "from sympy import Matrix\nx = Matrix([2, 4, -3]); y = Matrix([5, -2, 1])\nresult = x.dot(y)";

let client: ReturnType<typeof startClient> | undefined;

function startClient(image: string) {
  const proc = Bun.spawn(
    [
      "docker",
      "run",
      "--rm",
      "-i",
      "--network",
      "none",
      "--user",
      "1000:1000",
      "-v",
      `${SOCKET_VOLUME}:/run/verify`,
      "--entrypoint",
      "/usr/local/bin/python",
      image,
      "-I",
      "-B",
      "-c",
      CLIENT,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  );
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const line = async (): Promise<string> => {
    while (!buf.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("the client container ended");
      buf += decoder.decode(value);
    }
    const at = buf.indexOf("\n");
    const out = buf.slice(0, at);
    buf = buf.slice(at + 1);
    return out;
  };
  return {
    proc,
    async send(raw: string): Promise<Reply | null> {
      proc.stdin.write(`${JSON.stringify({ raw })}\n`);
      await proc.stdin.flush();
      const out = JSON.parse(await line()) as { reply?: string; down?: string };
      if (out.reply === undefined || out.reply === "") return null;
      return JSON.parse(out.reply) as Reply;
    },
  };
}

const send = (request: object) => (client as NonNullable<typeof client>).send(JSON.stringify(request));
const run = (program: string, extra: object = {}) => send({ kind: "run", program, ...extra });

const containerId = () => docker([...compose, "ps", "-aq", "verify"]);
const restarts = () => Number(docker(["inspect", "-f", "{{.RestartCount}}", containerId()]));

async function healthy(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reply = await send({ kind: "health" }).catch(() => null);
    if (reply?.ok) return true;
    await Bun.sleep(150);
  }
  return false;
}

/**
 * After an anomaly the parent exits and the restart policy brings it back. Docker doubles its delay after each
 * quick exit, up to a minute, so past the checks that watch the policy itself the suite restarts the container
 * by hand, which resets the delay and is otherwise the same thing.
 */
async function backUp(watchPolicy: boolean): Promise<void> {
  if (await healthy(watchPolicy ? 90_000 : 4000)) return;
  docker([...compose, "restart", "verify"]);
  if (!(await healthy(30_000))) throw new Error("verify didn't come back");
}

const results: { name: string; ok: boolean; detail: string }[] = [];
function record(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
}

/** A hostile program, its expected end, then a normal run in a fresh child that must give -1. */
async function hostile(
  name: string,
  program: string,
  expected: (r: Reply) => boolean,
  opts: { anomaly?: boolean; watchPolicy?: boolean } = {},
) {
  const reply = await run(program);
  const describe = JSON.stringify({
    status: reply?.status,
    errorType: reply?.errorType,
    value: reply?.value?.value,
    ms: reply?.durationMs,
  });
  const expectedEnd = reply !== null && expected(reply);
  if (opts.anomaly) {
    // Its reply first, then the exit: wait for the socket to go, so the next health check isn't the old parent's.
    await Bun.sleep(150);
    await backUp(opts.watchPolicy ?? false);
  }
  const next = await run(Q7);
  const clean = next?.status === "ok" && next.value?.value === "-1";
  record(name, expectedEnd && clean, `${describe}, next run ${clean ? "right" : JSON.stringify(next)}`);
}

const denied = (r: Reply) => r.status === "sandbox_denial";
const SECRET_ENV = "import os\nresult = [len(os.environ), len(os.environb)]";

async function suite() {
  // C3: who a child is, read from inside it.
  const who = await run(
    `import os, re
status = open('/proc/self/status').read()
cap = int(re.search(r'CapEff:\\s+(\\w+)', status).group(1), 16)
prm = int(re.search(r'CapPrm:\\s+(\\w+)', status).group(1), 16)
fds = []
for fd in range(256):
    try:
        os.fstat(fd)
        fds.append(fd)
    except OSError:
        pass
result = [os.getuid(), os.geteuid(), os.getgid(), os.getegid(), len(os.getgroups()), cap, prm, len(os.environ), len(fds), fds[0]]`,
  );
  record(
    "C3 a child is runner, no capabilities, empty environment, only its pipe",
    JSON.stringify(who?.value?.value) ===
      JSON.stringify(["10002", "10002", "10002", "10002", "0", "0", "0", "0", "1", "3"]),
    JSON.stringify(who?.value?.value ?? who),
  );

  // C2: a fresh process per run.
  const a = await run("import os\nresult = os.getpid()");
  const b = await run("import os\nresult = os.getpid()");
  record(
    "C2 consecutive runs have different pids",
    a?.value?.value !== b?.value?.value,
    `${a?.value?.value}, ${b?.value?.value}`,
  );
  await run("import builtins\nbuiltins.LEAK = 41\nresult = 0");
  const leak = await run("import builtins\nresult = getattr(builtins, 'LEAK', 1)");
  record("C2 a global doesn't reach the next run", leak?.value?.value === "1", String(leak?.value?.value));

  // SPEC's list. The first two watch the restart policy itself.
  await hostile(
    "open a socket",
    "import socket\ns = socket.socket()\ns.settimeout(2)\ns.connect(('1.1.1.1', 80))\nresult = 1",
    denied,
    { anomaly: true, watchPolicy: true },
  );
  await hostile(
    "open a socket on loopback",
    "import socket\ns = socket.socket()\ns.settimeout(2)\ns.connect(('127.0.0.1', 5432))\nresult = 1",
    denied,
    { anomaly: true, watchPolicy: true },
  );
  await hostile("resolve a hostname", "import socket\nresult = len(socket.gethostbyname('example.com'))", denied, {
    anomaly: true,
  });
  await hostile("read /etc/passwd", "result = len(open('/etc/passwd').read())", denied, { anomaly: true });
  await hostile("read the parent's environment", "result = len(open('/proc/1/environ').read())", denied, {
    anomaly: true,
  });
  await hostile(
    "read the environment",
    SECRET_ENV,
    (r) => JSON.stringify(r.value?.value) === JSON.stringify(["0", "0"]),
  );
  await hostile("write outside /tmp", "open('/app/x', 'w').close()\nresult = 1", denied, { anomaly: true });
  await hostile("write in the socket directory", "open('/run/verify/x', 'w').close()\nresult = 1", denied, {
    anomaly: true,
  });
  await hostile(
    "write in /tmp over the limit",
    "with open('/tmp/big', 'w') as f:\n    f.write('x' * 100)\nresult = 1",
    denied,
    {
      anomaly: true,
    },
  );
  await hostile("fork bomb", "import os\nwhile True:\n    os.fork()", denied, { anomaly: true });
  await hostile(
    "thread bomb",
    "import threading\nwhile True:\n    threading.Thread(target=input).start()",
    (r) => r.status !== "ok",
  );
  await hostile("exhaust memory at once", "x = bytearray(2 * 1024 * 1024 * 1024)\nresult = 1", denied, {
    anomaly: true,
  });
  await hostile("exhaust memory slowly", "x = []\nwhile True:\n    x.append(bytearray(10_000_000))", denied, {
    anomaly: true,
  });
  await hostile(
    "spin forever (CPU limit)",
    "while True:\n    pass",
    (r) => r.status === "timeout" && (r.durationMs ?? 0) >= 4500 && (r.durationMs ?? 0) <= 7500,
    { anomaly: true },
  );
  await hostile(
    "sleep forever (wall clock)",
    "import time\ntime.sleep(600)",
    (r) => r.status === "timeout" && (r.durationMs ?? 0) >= 9500 && (r.durationMs ?? 0) <= 11_500,
    { anomaly: true },
  );
  await hostile(
    "signals off, spin forever (hard CPU limit)",
    "import signal\nsignal.signal(signal.SIGXCPU, signal.SIG_IGN)\nwhile True:\n    pass",
    (r) => r.status === "sandbox_denial" || r.status === "timeout",
    { anomaly: true },
  );
  await hostile(
    "load ctypes and call setuid(0)",
    "import ctypes\nresult = ctypes.CDLL(None).setuid(0)",
    (r) => r.value?.value === "-1",
  );
  await hostile(
    "ctypes kill(1, SIGKILL)",
    "import ctypes\nresult = ctypes.CDLL(None).kill(1, 9)",
    (r) => r.value?.value === "-1",
  );
  await hostile(
    "os.system",
    "import os\nresult = os.system('touch /tmp/pwned')",
    (r) => r.status === "ok" && r.value?.value !== "0",
  );
  const system = await run("import os\nresult = int(os.path.exists('/tmp/pwned'))");
  record("os.system ran nothing", system?.value?.value === "0", String(system?.value?.value));
  await hostile(
    "reach eval through sympify on a string",
    "from sympy import sympify\nresult = sympify(\"__import__('os').getuid()\")",
    (r) => r.value?.value === "10002",
  );
  await hostile("unlink the socket", "import os\nos.unlink('/run/verify/verify.sock')\nresult = 1", denied, {
    anomaly: true,
  });
  await hostile(
    "replace the socket",
    "import os\nos.rename('/run/verify/verify.sock', '/run/verify/old')\nresult = 1",
    denied,
    { anomaly: true },
  );
  await hostile(
    "connect to the parent's socket",
    "import socket\ns = socket.socket(socket.AF_UNIX)\ns.connect('/run/verify/verify.sock')\ns.sendall(b'{\"kind\": \"health\"}\\n')\nresult = len(s.recv(100))",
    (r) => r.status === "sandbox_denial" && r.errorType === "PeerRefused",
    { anomaly: true },
  );
  await hostile("signal the parent", "import os\nos.kill(1, 9)\nresult = 1", denied, { anomaly: true });
  await hostile("signal the parent by ppid", "import os\nos.kill(os.getppid(), 15)\nresult = 1", denied, {
    anomaly: true,
  });
  await hostile(
    "patch a SymPy function",
    "import sympy\nsympy.Matrix.dot = lambda *a, **k: 99\nresult = 0",
    (r) => r.value?.value === "0",
  );
  await hostile(
    "patch a module in the parent's image of it",
    "import sympy.core.numbers as n\nn.Integer.__add__ = lambda a, b: 99\nresult = 0",
    (r) => r.value?.value === "0",
  );
  await hostile("leave a file in /tmp", "open('/tmp/state', 'w').close()\nresult = 0", (r) => r.value?.value === "0");
  const state = await run("import os\nresult = os.path.getsize('/tmp/state')");
  record("C6 a later run reads nothing a run wrote", state?.value?.value === "0", String(state?.value?.value));
  await hostile(
    "emit a 10 MB result",
    "from sympy import Symbol\nresult = Symbol('x' * 10_000_000)",
    (r) => r.status === "invalid_output",
    { anomaly: true },
  );
  await hostile(
    "write 10 MB to the result pipe",
    "import os\nos.write(3, b'{' * 10_000_000)",
    (r) => r.status === "invalid_output",
    { anomaly: true },
  );
  await hostile(
    "write invalid JSON",
    "import os\nos.write(3, b'not json')\nos._exit(0)",
    (r) => r.status === "invalid_output",
    { anomaly: true },
  );
  await hostile("exit without a reply", "import os\nos._exit(0)", (r) => r.status === "invalid_output", {
    anomaly: true,
  });

  // C8: recycling. A marker left before the exit must be gone: the restart brings a fresh tmpfs.
  await run("open('/tmp/marker', 'w').close()\nresult = 0");
  const before = restarts();
  const left = await run("import os\nresult = int(os.path.exists('/tmp/marker'))", { recycleEvery: 3 });
  record("C8 the budget request runs", left?.value?.value === "1", String(left?.value?.value));
  await Bun.sleep(300);
  const up = await healthy(90_000);
  const after = await run("import os\nresult = int(os.path.exists('/tmp/marker'))", { recycleEvery: 500 });
  record(
    "C8 Compose restarted it at the run budget, with a fresh tmpfs",
    up && restarts() > before && after?.value?.value === "0",
    `restarts ${before} → ${restarts()}, marker ${after?.value?.value}`,
  );
  const parent = await run("import os\nresult = os.getppid()");
  record("the parent is PID 1 of the container", parent?.value?.value === "1", String(parent?.value?.value));
}

let failed = false;
try {
  docker([...compose, "up", "-d", "--build", "verify"]);
  const image = docker(["inspect", "-f", "{{.Image}}", containerId()]);
  client = startClient(image);
  if (!(await healthy(60_000))) throw new Error("verify never answered health");
  console.log(`escape suite on ${runtime ?? "the default runtime"}, image ${image.slice(0, 19)}`);
  await suite();
  failed = results.some((r) => !r.ok);
} catch (err) {
  failed = true;
  console.error(err);
  console.error(docker([...compose, "logs", "--no-color", "--tail", "40", "verify"], false));
} finally {
  // The client's container holds the socket volume: let it end first, or `down -v` leaves the volume behind.
  client?.proc.stdin.end();
  await client?.proc.exited;
  docker([...compose, "down", "-v", "--timeout", "2"], false);
}
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} escape checks passed`);
for (const r of bad) console.log(`FAIL ${r.name}: ${r.detail}`);
process.exit(failed ? 1 : 0);
