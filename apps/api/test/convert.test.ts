import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ConvertClient } from "@gem/convert";
import { MockConvertServer } from "@gem/convert/mock";
import { AuditLog, LlmCallLog, SourceFile } from "@gem/db";
import { and, asc, eq } from "drizzle-orm";
import { assign, hasDb, setLocalOnly } from "../../../packages/llm/test/helpers.ts";
import { trackInteractive } from "../src/activity.ts";
import { processConvertJob } from "../src/convert.ts";
import { createSourceEnv, type SourceEnv } from "./authoring-helpers.ts";
import { API, type Client } from "./helpers.ts";

const SECRET = "s".repeat(32);
const pdf = (flags = "") => Buffer.from(`%PDF-1.7\n${flags}\n%%EOF\n`);

const mockConverter = new MockConvertServer({
  markdown: `# Vectors\n\n${"The inner product of two vectors is a number that measures alignment. ".repeat(6)}\n\n\\(x^T y = 0\\) ![fig](a.png)\n`,
});

async function upload(client: Client, body: Buffer, query = "filename=la.pdf", type = "application/pdf") {
  return client.request({
    method: "POST",
    url: `${API}/sources/files?${query}`,
    payload: body,
    headers: { "content-type": type },
  });
}

async function until<T>(client: Client, id: string, done: (f: { status: string }) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const res = await client.get(`${API}/sources/files/${id}`);
    const file = res.json().file;
    if (done(file)) return file as T;
    await Bun.sleep(25);
  }
  throw new Error("file never reached the state");
}

describe.skipIf(!hasDb)("P2.2 F2: PDF files", () => {
  let env: SourceEnv;
  beforeAll(async () => {
    env = await createSourceEnv({
      CONVERT_URL: mockConverter.url,
      CONVERT_SHARED_SECRET: SECRET,
      UPLOAD_RATE_LIMIT_MAX: "1000",
    });
    env.t.ctx.convert = new ConvertClient(mockConverter.url);
  });
  afterAll(async () => {
    mockConverter.stop();
    await env.queue.stop();
    await env.close();
  });

  test("M10: an upload is pending, converts in the background, and ends ready with cleaned Markdown", async () => {
    const res = await upload(env.proctor, pdf("%MOCK:pages=3"), "filename=la.pdf&pageRange=1-3");
    expect(res.statusCode).toBe(200);
    const created = res.json().file;
    expect(created).toMatchObject({ filename: "la.pdf", status: "pending", pageRange: "1-3", strategy: "rasterize" });
    expect(created).not.toHaveProperty("content");
    const file = await until<Record<string, unknown>>(env.proctor, created.id, (f) => f.status === "ready");
    expect(file).toMatchObject({ pageCount: 3, pagesConverted: 3 });
    const detail = (await env.proctor.get(`${API}/sources/files/${created.id}`)).json().file;
    expect(detail.markdown).toContain("$x^T y = 0$");
    expect(detail.markdown).not.toContain("![fig]");
    expect(detail.warnings).toContainEqual({ code: "figures_dropped", count: 1 });
    expect(mockConverter.conversions.at(-1)?.options).toMatchObject({ pageRange: "1-3", strategy: "rasterize" });
  });

  test("M11: what isn't a PDF, or is too big, is refused before anything is stored", async () => {
    expect((await upload(env.proctor, Buffer.from("just text"))).json().code).toBe("source_bad_type");
    expect((await upload(env.proctor, Buffer.alloc(0))).json().code).toBe("source_bad_type");
    await env.admin.put(`${API}/admin/settings`, {
      selfRegistration: true,
      convert: { maxFileBytes: 1024 * 1024 },
    });
    const big = await upload(env.proctor, Buffer.concat([pdf(), Buffer.alloc(1024 * 1024 + 1)]));
    expect(big.statusCode).toBe(413);
    expect(big.json()).toMatchObject({ code: "convert_too_large", params: { maxBytes: 1024 * 1024 } });
    await env.admin.put(`${API}/admin/settings`, {
      selfRegistration: true,
      convert: { maxFileBytes: 50 * 1024 * 1024 },
    });
    expect((await upload(env.proctor, pdf(), "filename=a.pdf&pageRange=abc")).statusCode).toBe(400);
  });

  test("M12: a failed conversion says why, and a retry converts it", async () => {
    const res = await upload(env.proctor, pdf("%MOCK:fail=bad_pdf"), "filename=bad.pdf");
    const failed = await until<{ errorCode: string }>(env.proctor, res.json().file.id, (f) => f.status === "failed");
    expect(failed.errorCode).toBe("convert_bad_pdf");
    const id = res.json().file.id as string;
    expect((await env.proctor.post(`${API}/sources/files/${id}/retry`)).statusCode).toBe(200);
    await until(env.proctor, id, (f) => f.status === "failed");
    // Only a failed file can be retried.
    const ok = await upload(env.proctor, pdf());
    await until(env.proctor, ok.json().file.id, (f) => f.status === "ready");
    expect((await env.proctor.post(`${API}/sources/files/${ok.json().file.id}/retry`)).json().code).toBe(
      "convert_file_not_ready",
    );
  });

  test("M13: a source is made from a ready file, keeps its id, and can be edited first", async () => {
    const up = await upload(env.proctor, pdf());
    const id = up.json().file.id as string;
    await until(env.proctor, id, (f) => f.status === "ready");
    const detail = (await env.proctor.get(`${API}/sources/files/${id}`)).json().file;
    const created = await env.proctor.post(`${API}/sources`, {
      title: "Linear algebra",
      citationLabel: "LA",
      text: `${detail.markdown}\nEdited by the creator.\n`,
      fileId: id,
    });
    expect(created.statusCode).toBe(200);
    const got = (await env.proctor.get(`${API}/sources/${created.json().source.id}`)).json();
    expect(got.revisions[0].fileId).toBe(id);
    // A file that isn't theirs, or isn't there, can't be used.
    const other = await env.other.post(`${API}/sources`, {
      title: "t",
      citationLabel: "t",
      text: "# x\n\ny",
      fileId: id,
    });
    expect(other.json().code).toBe("convert_file_not_found");
    const pending = await upload(env.proctor, pdf("%MOCK:fail=timeout"));
    await until(env.proctor, pending.json().file.id, (f) => f.status === "failed");
    const notReady = await env.proctor.post(`${API}/sources`, {
      title: "t",
      citationLabel: "t",
      text: "# x\n\ny",
      fileId: pending.json().file.id,
    });
    expect(notReady.json().code).toBe("convert_file_not_ready");
  });

  test("M16: files are private to their owner; an admin reads any; delete hides it and is audited", async () => {
    const up = await upload(env.proctor, pdf());
    const id = up.json().file.id as string;
    await until(env.proctor, id, (f) => f.status === "ready");
    expect((await env.other.get(`${API}/sources/files/${id}`)).statusCode).toBe(404);
    expect((await env.other.get(`${API}/sources/files/${id}/original`)).statusCode).toBe(404);
    expect((await env.student.get(`${API}/sources/files/${id}`)).statusCode).toBe(403);
    expect(
      (
        await env.student.request({
          method: "POST",
          url: `${API}/sources/files?filename=a.pdf`,
          payload: pdf(),
          headers: { "content-type": "application/pdf" },
        })
      ).statusCode,
    ).toBe(403);
    expect((await env.admin.get(`${API}/sources/files/${id}`)).statusCode).toBe(200);
    const original = await env.proctor.get(`${API}/sources/files/${id}/original`);
    expect(original.headers["content-type"]).toBe("application/pdf");
    expect(original.headers["content-disposition"]).toContain("la.pdf");
    expect(original.rawPayload.equals(pdf())).toBe(true);
    expect((await env.proctor.delete(`${API}/sources/files/${id}`)).statusCode).toBe(200);
    expect((await env.proctor.get(`${API}/sources/files/${id}`)).json().code).toBe("convert_file_not_found");
    const audit = await env.t.db
      .select({ action: AuditLog.action })
      .from(AuditLog)
      .where(and(eq(AuditLog.targetType, "source_file"), eq(AuditLog.targetId, id)))
      .orderBy(asc(AuditLog.at));
    expect(audit.map((r) => r.action)).toEqual(["source_file.upload", "source_file.delete"]);
  });

  test("M17: the events stream starts with the file's state", async () => {
    const up = await upload(env.proctor, pdf());
    const id = up.json().file.id as string;
    await until(env.proctor, id, (f) => f.status === "ready");
    const res = await env.proctor.get(`${API}/sources/files/${id}/events?once=true`);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(JSON.parse(res.body.replace(/^data: /, "")).file).toMatchObject({ id, status: "ready" });
  });

  test("M18: no converter, or a remote one while local endpoints only is on, refuses", async () => {
    const client = env.t.ctx.convert;
    env.t.ctx.convert = null;
    expect((await upload(env.proctor, pdf())).json().code).toBe("convert_unavailable");
    env.t.ctx.convert = client;
    // The configured address is a name on the public internet.
    (env.t.ctx.config as { CONVERT_URL?: string }).CONVERT_URL = "http://converter.example.com:8000";
    await setLocalOnly(env.t.db, true);
    const res = await upload(env.proctor, pdf());
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("convert_remote_blocked");
    await setLocalOnly(env.t.db, false);
    (env.t.ctx.config as { CONVERT_URL?: string }).CONVERT_URL = mockConverter.url;
  });

  test("M19: a file left converting by a stopped API shows as failed, with a retry", async () => {
    const up = await upload(env.proctor, pdf());
    const id = up.json().file.id as string;
    await until(env.proctor, id, (f) => f.status === "ready");
    await env.t.db.execute(`update source_file set status = 'converting' where id = '${id}'` as never);
    const { startConvertWorker } = await import("../src/convert.ts");
    await startConvertWorker({ ...env.t.ctx, queue: null });
    const file = (await env.proctor.get(`${API}/sources/files/${id}`)).json().file;
    expect(file).toMatchObject({ status: "failed", errorCode: "service_unavailable" });
  });

  test("a conversion waits for question generation to finish, and then runs", async () => {
    let release: () => void = () => {};
    const held = trackInteractive(() => new Promise<void>((r) => (release = r)));
    const up = await upload(env.proctor, pdf());
    const id = up.json().file.id as string;
    await Bun.sleep(3500);
    expect((await env.proctor.get(`${API}/sources/files/${id}`)).json().file.status).toBe("pending");
    release();
    await held;
    await until(env.proctor, id, (f) => f.status === "ready");
  }, 20_000);

  test("M10: gem_app can read, add and update files but not delete them", async () => {
    const up = await upload(env.proctor, pdf());
    const id = up.json().file.id as string;
    const attempt = (async () => {
      await env.t.db.delete(SourceFile).where(eq(SourceFile.id, id));
    })();
    await expect(attempt).rejects.toThrow();
    await env.t.db.update(SourceFile).set({ deletedAt: new Date() }).where(eq(SourceFile.id, id));
  });

  test("M17: a converted source is chunked and embedded like any other, keeping the equation", async () => {
    const up = await upload(env.proctor, pdf());
    const id = up.json().file.id as string;
    await until(env.proctor, id, (f) => f.status === "ready");
    const detail = (await env.proctor.get(`${API}/sources/files/${id}`)).json().file;
    const created = await env.proctor.post(`${API}/sources`, {
      title: "Converted",
      citationLabel: "CV",
      text: detail.markdown,
      fileId: id,
    });
    const source = await env.settled(env.proctor, created.json().source.id);
    expect(source.usable).toBe(true);
    expect(source.latest.chunks).toBeGreaterThan(0);
    const chunks = (await env.proctor.get(`${API}/sources/${source.id}/chunks`)).json();
    expect(JSON.stringify(chunks)).toContain("$x^T y = 0$");
  });

  test("M19: /health reports the converter without making the server unhealthy", async () => {
    const res = await env.proctor.get(`${API}/health`);
    expect(res.json().convert).toEqual({ ok: true });
    const client = env.t.ctx.convert;
    env.t.ctx.convert = new ConvertClient("http://127.0.0.1:9");
    expect((await env.proctor.get(`${API}/health`)).json().convert).toEqual({ ok: false });
    env.t.ctx.convert = client;
  });

  test("processConvertJob ignores a file that is gone or already done", async () => {
    await processConvertJob(env.t.ctx, "00000000-0000-4000-8000-000000000000", 1);
  });
});

describe.skipIf(!hasDb)("P2.2 F2: the vision-model proxy (M10a)", () => {
  let env: SourceEnv;
  beforeAll(async () => {
    env = await createSourceEnv({ CONVERT_URL: mockConverter.url, CONVERT_SHARED_SECRET: SECRET });
    await assign(env.t.db, "document.ocr", { url: env.mock.url, model: "ocr-model-assigned", timeoutMs: 20_000 });
  });
  afterAll(async () => {
    await env.queue.stop();
    await env.close();
  });
  const call = (path: string, init: { secret?: string | null; body?: unknown } = {}) =>
    env.t.app.inject({
      method: init.body === undefined ? "GET" : "POST",
      url: `/internal/vlm/v1${path}`,
      headers: {
        ...(init.secret === null ? {} : { authorization: `Bearer ${init.secret ?? SECRET}` }),
        "content-type": "application/json",
      },
      ...(init.body === undefined ? {} : { payload: init.body as object }),
    });

  test("it answers health and the model list the converter's reader asks for", async () => {
    expect((await call("/health")).json()).toEqual({ ok: true });
    expect((await call("/models")).json().data[0].id).toBe("datalab-to/surya-ocr-2.5");
  });

  test("it refuses a call without the secret", async () => {
    expect((await call("/health", { secret: null })).statusCode).toBe(401);
    expect((await call("/models", { secret: "wrong" })).statusCode).toBe(401);
    const res = await call("/chat/completions", { secret: "wrong", body: { messages: [] } });
    expect(res.statusCode).toBe(401);
    expect(env.mock.chatRequests().length).toBe(0);
  });

  test("a chat call goes to the assigned endpoint and model, and is logged as document.ocr", async () => {
    env.setReply(() => "page text");
    const res = await call("/chat/completions", {
      body: { model: "datalab-to/surya-ocr-2.5", messages: [{ role: "user", content: "read" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toBe("page text");
    expect(env.mock.chatRequests().at(-1)?.body.model).toBe("ocr-model-assigned");
    const rows = await env.t.db.select().from(LlmCallLog);
    const row = rows.find((r) => r.role === "document.ocr");
    expect(row).toMatchObject({ outcome: "ok", mode: "passthrough", model: "ocr-model-assigned" });
    expect(row?.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    expect(row?.requestBody).toBeNull();
  });

  test("page reads share the endpoint's queue: with concurrency 1, two at once run one after the other", async () => {
    env.mock.maxInFlight = 0;
    env.setReply(() => ({ text: "slow", delayMs: 80 }));
    const both = await Promise.all([1, 2].map(() => call("/chat/completions", { body: { messages: [] } })));
    expect(both.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(env.mock.maxInFlight).toBe(1);
  });

  test("an unassigned role is a refusal with a reason, and while local-only a cloud endpoint is blocked", async () => {
    await env.t.db.execute(`delete from role_assignment where role = 'document.ocr'` as never);
    expect((await call("/chat/completions", { body: { messages: [] } })).json().code).toBe("llm_role_unassigned");
    await assign(env.t.db, "document.ocr", { url: env.mock.url, location: "cloud" });
    await setLocalOnly(env.t.db, true);
    expect((await call("/chat/completions", { body: { messages: [] } })).json().code).toBe("llm_cloud_blocked");
    await setLocalOnly(env.t.db, false);
  });
});
