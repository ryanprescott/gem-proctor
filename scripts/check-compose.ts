// bun scripts/check-compose.ts [baseUrl] — checks a running Compose stack (P0.md A2, A33):
//  - GET /api/v1/health reports db, queue and verify all ok;
//  - the verify container is isolated as SPEC §3A.3.1 / §11.5 require.
// Needs `docker` (Docker Desktop WSL integration locally; the GitHub runner in CI).
const base = process.argv[2] ?? "http://localhost:3000";
const problems: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) problems.push(what);
};

function docker(args: string[]): string {
  const r = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`docker ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

// A2: health
let health: {
  ok?: boolean;
  db?: { ok: boolean };
  queue?: { ok: boolean };
  verify?: { ok: boolean; sympy?: string; numpy?: string };
} = {};
for (let i = 0; i < 180; i++) {
  try {
    health = (await (await fetch(`${base}/api/v1/health`)).json()) as typeof health;
    if (health.ok) break;
  } catch {}
  await Bun.sleep(1000);
}
check(health.db?.ok === true, "health: db ok");
check(health.queue?.ok === true, "health: queue ok (pg-boss heartbeat processed)");
check(health.verify?.ok === true, "health: verify ok over the Unix socket");

// A33: the verify container
const requirements = await Bun.file(new URL("../apps/verify/requirements.txt", import.meta.url)).text();
const pinned = Object.fromEntries([...requirements.matchAll(/^(\w+)==(\S+)$/gm)].map((m) => [m[1], m[2]]));
check(
  health.verify?.sympy === pinned.sympy && health.verify?.numpy === pinned.numpy,
  `health: pinned sympy ${pinned.sympy} / numpy ${pinned.numpy}`,
);

const id = docker(["compose", "ps", "-q", "verify"]).trim();
const [info] = JSON.parse(docker(["inspect", id])) as [
  {
    HostConfig: {
      NetworkMode: string;
      ReadonlyRootfs: boolean;
      CapDrop: string[] | null;
      CapAdd: string[] | null;
      SecurityOpt: string[] | null;
      PidsLimit: number | null;
      Memory: number;
      NanoCpus: number;
      Tmpfs: Record<string, string> | null;
    };
    Config: { Env: string[] | null };
  },
];
const hc = info.HostConfig;
check(hc.NetworkMode === "none", "verify: network_mode none");
check(hc.ReadonlyRootfs === true, "verify: read-only root filesystem");
check(!!hc.Tmpfs && "/tmp" in hc.Tmpfs, "verify: tmpfs on /tmp");
check(JSON.stringify(hc.CapDrop) === JSON.stringify(["ALL"]), "verify: cap_drop ALL");
check(
  JSON.stringify([...(hc.CapAdd ?? [])].sort().map((c) => c.replace(/^CAP_/, ""))) ===
    JSON.stringify(["SETGID", "SETUID"]),
  "verify: cap_add SETUID, SETGID only",
);
check(
  (hc.SecurityOpt ?? []).some((o) => o.startsWith("no-new-privileges")),
  "verify: no-new-privileges",
);
check((hc.PidsLimit ?? 0) > 0 && hc.Memory > 0 && hc.NanoCpus > 0, "verify: pids, memory and CPU limits");
const secretish = (info.Config.Env ?? []).filter((e) =>
  /SECRET|PASSWORD|DATABASE|KEY|TOKEN/i.test(e.split("=")[0] ?? ""),
);
check(secretish.length === 0, "verify: no secrets in the container config");
const py = (code: string) =>
  docker(["compose", "exec", "-T", "verify", "/usr/local/bin/python", "-I", "-B", "-c", code]).trim();
check(
  py("print(repr(open('/proc/1/environ').read()))") === "''",
  "verify: the parent process has no environment variables",
);
check(
  py("import socket; print(','.join(n for _, n in socket.if_nameindex()))") === "lo",
  "verify: no interface besides loopback",
);

if (problems.length > 0) {
  console.error(`\n${problems.length} check(s) failed`);
  process.exit(1);
}
console.log("\ncompose checks passed");
