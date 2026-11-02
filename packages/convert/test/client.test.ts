// The converter's contract from the API's side (docs/P2.2.md M1, M2, M8): the client against the mock, and the same client
// against the real Python service with its stub engine, so the two languages are checked against each other.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockConvertServer } from "../mock/server.ts";
import { ConvertClient, type ConvertClientError } from "../src/index.ts";

const pdf = (...flags: string[]) =>
  new TextEncoder().encode(`%PDF-1.4\n${flags.map((f) => `%MOCK:${f}\n%STUB:${f}\n`).join("")}`);
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return (err as ConvertClientError).code;
  }
  return "none";
};

describe("the client against the mock", () => {
  let mock: MockConvertServer;
  let client: ConvertClient;
  beforeAll(() => {
    mock = new MockConvertServer({ maxBytes: 5000, maxPages: 5 });
    client = new ConvertClient(mock.url);
  });
  afterAll(() => mock.stop());

  test("M1 health, and a conversion, in the contract's shape", async () => {
    const health = await client.health();
    expect(health).toMatchObject({ ok: true, models: "ready", busy: false });
    expect(await client.ready()).toBe(true);
    const reply = await client.convert(pdf("pages=3"), { pageRange: "1-2", strategy: "text" });
    expect(reply).toMatchObject({ pageCount: 3, strategy: "text", converter: { name: "mock" } });
    expect(reply.markdown).toContain("$x^T y = 0$");
    expect(mock.conversions.at(-1)?.options).toEqual({ pageRange: "1-2", strategy: "text" });
  });

  test("each refusal arrives as its own code", async () => {
    expect(await code(client.convert(new TextEncoder().encode("MZ not a pdf")))).toBe("not_pdf");
    expect(await code(client.convert(new Uint8Array(6000).fill(65)))).toBe("too_large");
    expect(await code(client.convert(pdf("pages=9")))).toBe("too_many_pages");
    expect(await code(client.convert(pdf("empty")))).toBe("empty");
    expect(await code(client.convert(pdf("fail=timeout")))).toBe("timeout");
    expect(await code(client.convert(pdf("fail=failed")))).toBe("failed");
  });

  test("a converter that isn't there is `unreachable`, and not ready", async () => {
    const gone = new ConvertClient("http://127.0.0.1:1");
    expect(await code(gone.convert(pdf()))).toBe("unreachable");
    expect(await gone.ready()).toBe(false);
  });

  test("a reply that isn't the contract is `invalid_reply`", async () => {
    const odd = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ markdown: 5 }) });
    try {
      const c = new ConvertClient(`http://127.0.0.1:${odd.port}`);
      expect(await code(c.convert(pdf()))).toBe("invalid_reply");
      expect(await code(c.health())).toBe("invalid_reply");
    } finally {
      odd.stop(true);
    }
  });

  test("the mock takes one request at a time when it's slow, and shows how many were in flight", async () => {
    const slow = new MockConvertServer({ delayMs: 200 });
    try {
      const c = new ConvertClient(slow.url);
      await Promise.all([c.convert(pdf()), c.convert(pdf())]);
      expect(slow.maxInFlight).toBe(2);
    } finally {
      slow.stop();
    }
  });
});

const python = [
  process.env.VERIFY_PYTHON,
  Bun.which("python3.12"),
  join(process.env.HOME ?? "", ".local", "bin", "python3.12"),
].find((p): p is string => !!p && existsSync(p));

describe.skipIf(!python)("the client against the real service, with its stub engine", () => {
  let proc: ReturnType<typeof Bun.spawn>;
  let work: string;
  let client: ConvertClient;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "gem-convert-"));
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = probe.port as number;
    probe.stop(true);
    proc = Bun.spawn([python as string, "-B", "-m", "gem_convert"], {
      cwd: join(import.meta.dir, "..", "..", "..", "apps", "convert"),
      env: {
        ...process.env,
        CONVERT_ENGINE: "stub",
        CONVERT_PORT: String(port),
        CONVERT_WORK_DIR: work,
        CONVERT_MAX_BYTES: "5000",
        CONVERT_MAX_PAGES: "5",
        CONVERT_BASE_SECONDS: "5",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    client = new ConvertClient(`http://127.0.0.1:${port}`);
    for (let i = 0; i < 200 && !(await client.ready()); i++) await Bun.sleep(50);
  });
  afterAll(() => {
    proc?.kill();
    rmSync(work, { recursive: true, force: true });
  });

  test("M1 M2 the Python service's replies pass the TypeScript contract, and its refusals map to the same codes", async () => {
    expect(await client.health()).toMatchObject({
      engine: "stub",
      models: "ready",
      limits: { maxBytes: 5000, maxPages: 5 },
    });
    const reply = await client.convert(pdf("pages=4"), { pageRange: "2-3" });
    expect(reply).toMatchObject({
      pageCount: 4,
      pagesConverted: 2,
      strategy: "rasterize",
      converter: { name: "stub" },
    });
    expect(await code(client.convert(new TextEncoder().encode("MZ not a pdf")))).toBe("not_pdf");
    expect(await code(client.convert(new Uint8Array(6000).fill(65)))).toBe("too_large");
    expect(await code(client.convert(pdf("pages=9")))).toBe("too_many_pages");
    expect(await code(client.convert(pdf("pages=2"), { pageRange: "3-4" }))).toBe("bad_range");
    expect(await code(client.convert(pdf("empty")))).toBe("empty");
    expect(await code(client.convert(pdf("bad")))).toBe("bad_pdf");
    expect((await client.convert(pdf())).markdown).toContain("The stub read this");
  });
});
