// bun scripts/check-convert.ts [baseUrl] [--hostile] [--image name] — checks a running Compose `convert` service
// (docs/P2.2.md M6, M7). Not part of `bun run ci`: the image is large, and it needs a Docker daemon and, for the last
// step, the vision model. Run it after changing the image, the Compose service or the engine.
//   - the container is isolated as §5 says (read-only, no capabilities, no secrets, limits, lowest CPU priority);
//   - --hostile: each PDF in apps/convert/tests/fixtures/hostile goes through the engine's parser in a container with no
//     network, a read-only root, no capabilities and a memory cap, then to the running service, which must stay healthy
//     and still convert a normal PDF afterwards.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvertClient, ConvertClientError } from "../packages/convert/src/index.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => args[args.indexOf(name) + 1];
const base = args.find((a) => a.startsWith("http")) ?? "http://localhost:8200";
const image = flag("--image") ? (option("--image") as string) : "gem-convert";
const FIXTURES = join(import.meta.dir, "..", "apps", "convert", "tests", "fixtures");

const problems: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) problems.push(what);
};

function docker(a: string[], timeout = 60_000) {
  const r = Bun.spawnSync(["docker", ...a], { stdout: "pipe", stderr: "pipe", timeout });
  return {
    code: r.exitCode,
    out: r.stdout.toString(),
    err: r.stderr.toString(),
    killed: r.exitedDueToTimeout === true,
  };
}
const must = (a: string[]) => {
  const r = docker(a);
  if (r.code !== 0) throw new Error(`docker ${a.join(" ")}: ${r.err}`);
  return r.out;
};

// ── the running service ──────────────────────────────────────────────

const client = new ConvertClient(base);
let ready = false;
for (let i = 0; i < 900 && !ready; i++) {
  ready = await client.ready();
  if (!ready) await Bun.sleep(1000);
}
check(ready, "health: the service answers and its models are loaded");

const id = must(["compose", "ps", "-q", "convert"]).trim();
if (id === "") throw new Error("no running `convert` service: docker compose --profile convert up");
const [info] = JSON.parse(must(["inspect", id])) as [
  {
    HostConfig: {
      ReadonlyRootfs: boolean;
      CapDrop: string[] | null;
      CapAdd: string[] | null;
      SecurityOpt: string[] | null;
      PidsLimit: number | null;
      Memory: number;
      NanoCpus: number;
      Tmpfs: Record<string, string> | null;
      PortBindings: Record<string, { HostIp: string }[]> | null;
    };
    Config: { Env: string[] | null; User: string };
    NetworkSettings: { Networks: Record<string, unknown> };
  },
];
const hc = info.HostConfig;
check(hc.ReadonlyRootfs === true, "convert: read-only root filesystem");
check(!!hc.Tmpfs && "/work" in hc.Tmpfs && "/cache" in hc.Tmpfs, "convert: tmpfs on /work and /cache");
check(
  JSON.stringify(hc.CapDrop) === JSON.stringify(["ALL"]) && (hc.CapAdd ?? []).length === 0,
  "convert: cap_drop ALL, nothing added",
);
check(
  (hc.SecurityOpt ?? []).some((o) => o.startsWith("no-new-privileges")),
  "convert: no-new-privileges",
);
check((hc.PidsLimit ?? 0) > 0 && hc.Memory > 0 && hc.NanoCpus > 0, "convert: pids, memory and CPU limits");
check(info.Config.User === "10003:10003", "convert: runs as uid 10003, not root");
const secretish = (info.Config.Env ?? []).filter((e) => {
  const name = e.split("=")[0] ?? "";
  return name !== "GPG_KEY" && /SECRET|PASSWORD|DATABASE|KEY|TOKEN/i.test(name);
});
check(secretish.length === 0, "convert: no secrets in the container config");
const binds = Object.values(hc.PortBindings ?? {}).flat();
check(
  binds.length > 0 && binds.every((b) => b.HostIp === "127.0.0.1"),
  "convert: its port is published on loopback only",
);
check(Object.keys(info.NetworkSettings.Networks).length === 1, "convert: attached to exactly one network");
const exec = (cmd: string) => must(["exec", id, "sh", "-c", cmd]).trim();
check(exec("id -u") === "10003", "convert: the process is uid 10003");
check(/CapEff:\s+0+$/m.test(exec("cat /proc/1/status")), "convert: the process holds no capabilities");
check(exec("cut -d' ' -f19 /proc/1/stat") === "19", "convert: the lowest CPU priority (nice 19)");
check(exec("echo $HF_HUB_OFFLINE") === "1", "convert: the weights are baked in and the image is offline for them");
check(
  Bun.spawnSync(["docker", "exec", id, "sh", "-c", "touch /app/x 2>/dev/null || touch /opt/baked/x 2>/dev/null"])
    .exitCode !== 0,
  "convert: nothing in the image can be written",
);

// ── hostile PDFs ─────────────────────────────────────────────────────

if (flag("--hostile")) {
  const dir = join(FIXTURES, "hostile");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".pdf"))
    .sort();
  console.log(`\nthe parser, ${files.length} hostile PDFs, no network, read-only, 2 GB, no capabilities:`);
  for (const file of files) {
    const r = docker(
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        "2g",
        "--memory-swap",
        "2g",
        "--pids-limit",
        "256",
        "--tmpfs",
        "/work:size=64m,uid=10003",
        "-v",
        `${dir}:/in:ro`,
        "--entrypoint",
        "python",
        image,
        "-m",
        "gem_convert.probe",
        `/in/${file}`,
      ],
      120_000,
    );
    const line = r.out.trim().split("\n").at(-1) ?? "";
    let verdict = r.killed
      ? "HUNG"
      : r.code === 0
        ? line
        : `crashed (exit ${r.code}); the container ended and the host is untouched`;
    check(!r.killed, `hostile ${file}: ${verdict}`);
    verdict = "";
  }

  console.log("\nthe running service:");
  const normal = readFileSync(join(FIXTURES, "linear-algebra.pdf"));
  for (const file of files) {
    const answer = await client
      .convert(readFileSync(join(dir, file)), { pageRange: "1" })
      .then(() => "converted")
      .catch((e: unknown) => (e instanceof ConvertClientError ? e.code : String(e)));
    check(answer !== "unreachable" && answer !== "invalid_reply", `service ${file}: ${answer}`);
    let healthy = false;
    for (let i = 0; i < 300 && !healthy; i++) {
      healthy = await client.ready();
      if (!healthy) await Bun.sleep(1000);
    }
    check(healthy, `service healthy after ${file}`);
  }
  const reply = await client.convert(normal, { pageRange: "1" }).catch((e: unknown) => e);
  check(
    !(reply instanceof Error),
    `a normal PDF still converts after all of them${reply instanceof Error ? ` (${reply.message})` : ""}`,
  );
}

if (problems.length > 0) {
  console.error(`\n${problems.length} check(s) failed`);
  process.exit(1);
}
console.log("\nconvert checks passed");
