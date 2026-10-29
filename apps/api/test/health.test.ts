import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Queue } from "../src/queue.ts";
import { SocketVerifyClient } from "../src/verify-client.ts";
import { API, createTestApp, hasDb, type TestApp } from "./helpers.ts";

function fakeVerifyServer(path: string, reply: (line: string) => string | null): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((sock) => {
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString();
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        const out = reply(buf.slice(0, nl));
        if (out !== null) sock.end(out);
      });
    });
    server.listen(path, () => resolve(server));
  });
}

describe("verify client", () => {
  test("health over the Unix socket, validated", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "gem-verify-")), "v.sock");
    let got = "";
    const server = await fakeVerifyServer(path, (line) => {
      got = line;
      return `${JSON.stringify({ ok: true, sympy: "1.13.3", numpy: "2.1.3" })}\n`;
    });
    try {
      expect(await new SocketVerifyClient(path).health()).toEqual({ ok: true, sympy: "1.13.3", numpy: "2.1.3" });
      expect(JSON.parse(got)).toEqual({ kind: "health" });
    } finally {
      server.close();
    }
  });

  test("malformed replies, timeouts and a missing socket are not ok", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gem-verify-"));
    expect(await new SocketVerifyClient(join(dir, "missing.sock")).health()).toBeNull();
    const bad = await fakeVerifyServer(join(dir, "bad.sock"), () => '{"ok": "yes"}\n');
    const silent = await fakeVerifyServer(join(dir, "silent.sock"), () => null);
    try {
      expect(await new SocketVerifyClient(join(dir, "bad.sock")).health()).toBeNull();
      expect(await new SocketVerifyClient(join(dir, "silent.sock"), 200).health()).toBeNull();
    } finally {
      bad.close();
      silent.close();
    }
  });
});

describe.skipIf(!hasDb)("S4: pg-boss heartbeat and /health", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.ctx.queue?.stop();
    await t?.close();
  });

  test("health is 503 until the queue has processed a heartbeat, then ok", async () => {
    const before = await t.app.inject({ method: "GET", url: `${API}/health` });
    expect(before.statusCode).toBe(503);
    expect(before.json()).toMatchObject({ ok: false, db: { ok: true }, queue: { ok: false } });

    t.ctx.queue = await Queue.start(t.database.appUrl, () => {});
    expect(await t.ctx.queue.waitForHeartbeat()).toBe(true);
    const after = await t.app.inject({ method: "GET", url: `${API}/health` });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toMatchObject({
      ok: true,
      db: { ok: true },
      queue: { ok: true },
      verify: { ok: true, sympy: "1.13.3" },
    });

    t.verify.reply = null;
    const noVerify = await t.app.inject({ method: "GET", url: `${API}/health` });
    expect(noVerify.statusCode).toBe(503);
    expect(noVerify.json().verify).toEqual({ ok: false });
  }, 30_000);
});
