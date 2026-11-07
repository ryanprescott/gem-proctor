import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ConvertClient } from "@gem/convert";
import { MockConvertServer } from "@gem/convert/mock";
import { AuditLog, LlmCallLog, SourceFile, SourceFilePage, SourceRevision } from "@gem/db";
import { and, asc, eq } from "drizzle-orm";
import { assign, hasDb, setLocalOnly } from "../../../packages/llm/test/helpers.ts";
import { trackInteractive } from "../src/activity.ts";
import {
  CONVERT_BATCH_PAGES,
  firstPage,
  ownerFilesTopic,
  processConvertJob,
  rangeOf,
  selectedPages,
} from "../src/convert.ts";
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
    const before = mockConverter.conversions.length;
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
    // Two requests (the first page, then the rest); the mock's document, with its one figure, is the first page's.
    expect(detail.warnings).toContainEqual({ code: "figures_dropped", count: 1 });
    expect(mockConverter.conversions.slice(before).map((c) => c.options)).toEqual([
      { pageRange: "1", strategy: "rasterize" },
      { pageRange: "2-3", strategy: "rasterize" },
    ]);
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

describe.skipIf(!hasDb)("your uploads, as a list that updates itself", () => {
  let env: SourceEnv;
  const lister = new MockConvertServer({
    markdown: `# Read\n\n${"Prose read from the PDF, long enough. ".repeat(20)}\n`,
  });
  beforeAll(async () => {
    env = await createSourceEnv({
      CONVERT_URL: lister.url,
      CONVERT_SHARED_SECRET: SECRET,
      UPLOAD_RATE_LIMIT_MAX: "1000",
    });
    env.t.ctx.convert = new ConvertClient(lister.url);
  });
  afterAll(async () => {
    lister.stop();
    await env.queue.stop();
    await env.close();
  });
  const list = async (client: Client) =>
    (await client.get(`${API}/sources/files`)).json().files as { id: string; filename: string; status: string }[];
  const streamed = async (client: Client) => {
    const res = await client.get(`${API}/sources/files/events?once=true`);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    return JSON.parse(res.body.replace(/^data: /, "")).files as { id: string }[];
  };

  test("every state until it's a source, newest first; saved or removed, it leaves; nobody else's", async () => {
    lister.options.fail = "bad_pdf";
    const bad = (await upload(env.proctor, pdf(), "filename=bad.pdf")).json().file;
    await until(env.proctor, bad.id, (f) => f.status === "failed");
    lister.options.fail = undefined;
    const good = (await upload(env.proctor, pdf("%MOCK:pages=2"), "filename=good.pdf")).json().file;
    await until(env.proctor, good.id, (f) => f.status === "ready");
    const theirs = (await upload(env.other, pdf(), "filename=theirs.pdf")).json().file;

    expect((await list(env.proctor)).map((f) => [f.filename, f.status])).toEqual([
      ["good.pdf", "ready"],
      ["bad.pdf", "failed"],
    ]);
    // The stream starts with the same list.
    expect((await streamed(env.proctor)).map((f) => f.id)).toEqual([good.id, bad.id]);
    expect((await list(env.other)).map((f) => f.id)).toEqual([theirs.id]);
    // The list never carries the PDF or the text.
    expect(Object.keys((await list(env.proctor))[0] ?? {})).not.toContain("markdown");

    const detail = (await env.proctor.get(`${API}/sources/files/${good.id}`)).json().file;
    const made = await env.proctor.post(`${API}/sources`, {
      title: "Good",
      citationLabel: "G",
      text: detail.markdown,
      fileId: good.id,
    });
    expect(made.statusCode).toBe(200);
    expect((await env.proctor.delete(`${API}/sources/files/${bad.id}`)).statusCode).toBe(200);
    expect(await list(env.proctor)).toEqual([]);
  });

  test("the owner's stream is told of every change: upload, each batch, the finish, a retry, a removal, a save", async () => {
    let told = 0;
    const stop = env.t.ctx.events.subscribe(ownerFilesTopic(env.proctorId), () => {
      told += 1;
    });
    try {
      const file = (await upload(env.proctor, pdf("%MOCK:pages=25"), "filename=told.pdf")).json().file;
      await until(env.proctor, file.id, (f) => f.status === "ready");
      // Uploaded, started, the first page, pages 2-21, pages 22-25, ready.
      expect(told).toBe(6);
      const detail = (await env.proctor.get(`${API}/sources/files/${file.id}`)).json().file;
      await env.proctor.post(`${API}/sources`, {
        title: "Told",
        citationLabel: "T",
        text: detail.markdown,
        fileId: file.id,
      });
      expect(told).toBe(7);

      lister.options.fail = "timeout";
      const flaky = (await upload(env.proctor, pdf(), "filename=flaky.pdf")).json().file;
      await until(env.proctor, flaky.id, (f) => f.status === "failed");
      lister.options.fail = undefined;
      const before = told;
      await env.proctor.post(`${API}/sources/files/${flaky.id}/retry`);
      expect(told).toBe(before + 1);
      await until(env.proctor, flaky.id, (f) => f.status === "ready");
      await env.proctor.delete(`${API}/sources/files/${flaky.id}`);
      expect(told).toBeGreaterThan(before + 2);
      // Another user's files don't touch this stream.
      const quiet = told;
      const theirs = (await upload(env.other, pdf(), "filename=theirs2.pdf")).json().file;
      await until(env.other, theirs.id, (f) => f.status === "ready");
      expect(told).toBe(quiet);
    } finally {
      stop();
    }
  });
});

describe.skipIf(!hasDb)("a book: pages stored, a manifest, sources made from pages on the server", () => {
  let env: SourceEnv;
  // A small book as Marker reads it: page numbers and running headers at the tops, two chapters, an outline.
  const words = ["vectors", "matrices", "norms", "angles", "bases", "clusters", "inverses", "projections"];
  const pageText = (page: number) => {
    const body =
      page === 3
        ? "# Chapter 1\n\n# Vectors\n\nA vector is an ordered list of numbers, written $x = (x_1, x_2)$."
        : page === 7
          ? "# Chapter 2\n\n# Matrices\n\nA matrix is a rectangular array of numbers."
          : `This page is about ${words[page % 8]} and ${words[(page + 3) % 8]}, with $y_${page}$ in a sentence.`;
    if (page === 3 || page === 7) return body;
    const header = page < 7 ? "# 1 Vectors" : "# 2 Matrices";
    return `${page}\n\n${header}\n\n${body}`;
  };
  const OUTLINE = [
    { title: "Vectors", level: 0, page: 3 },
    { title: "Matrices", level: 0, page: 7 },
  ];
  const book = new MockConvertServer({ pageAnswer: (page) => pageText(page), outline: OUTLINE });
  beforeAll(async () => {
    env = await createSourceEnv({
      CONVERT_URL: book.url,
      CONVERT_SHARED_SECRET: SECRET,
      UPLOAD_RATE_LIMIT_MAX: "1000",
    });
    env.t.ctx.convert = new ConvertClient(book.url);
  });
  afterAll(async () => {
    book.stop();
    await env.queue.stop();
    await env.close();
  });
  let fileId = "";

  test("each page is stored as read, the outline goes in the manifest, and the text is put together from them", async () => {
    const res = await upload(env.proctor, pdf("%MOCK:pages=10"), "filename=book.pdf&pageRange=3-10");
    fileId = res.json().file.id;
    const file = await until<Record<string, unknown>>(
      env.proctor,
      fileId,
      (f) => f.status === "ready" || f.status === "failed",
    );
    expect(file).toMatchObject({ status: "ready", pageCount: 10, pagesConverted: 8 });
    const pages = await env.t.db.select().from(SourceFilePage).where(eq(SourceFilePage.fileId, fileId));
    expect(pages.map((p) => p.page).sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(pages.find((p) => p.page === 4)?.markdown).toContain("# 1 Vectors");
    const [row] = await env.t.db.select().from(SourceFile).where(eq(SourceFile.id, fileId));
    expect(row?.manifest).toEqual({ outline: OUTLINE });
    // The assembled text: the outline's headings, the running headers, page numbers and chapter labels gone.
    const md = row?.markdown ?? "";
    expect([...md.matchAll(/^#+ .+$/gm)].map((m) => m[0])).toEqual(["# Vectors", "# Matrices"]);
    expect(md).not.toContain("1 Vectors");
    expect(md).not.toContain("Chapter 1");
    expect(md).not.toMatch(/^\d+$/m);
    expect(md).toContain("$y_10$");
  });

  test("the summary has the outline with its pages and the text's sections, and no text", async () => {
    const res = await env.proctor.get(`${API}/sources/files/${fileId}/summary`);
    expect(res.statusCode).toBe(200);
    const summary = res.json();
    expect(summary.outline).toEqual([
      { title: "Vectors", level: 0, page: 3, lastPage: 6 },
      { title: "Matrices", level: 0, page: 7, lastPage: 10 },
    ]);
    expect(summary.preview.sections.map((s: { title: string }) => s.title)).toEqual(["Vectors", "Matrices"]);
    expect(summary.characters).toBeGreaterThan(100);
    expect(JSON.stringify(summary)).not.toContain("rectangular array");
    // Another user's file, as for every file route.
    expect((await env.other.get(`${API}/sources/files/${fileId}/summary`)).statusCode).toBe(404);
  });

  test("a source from the whole PDF or one chapter, made on the server from the stored pages", async () => {
    const listed = async () =>
      ((await env.proctor.get(`${API}/sources/files`)).json().files as { id: string }[]).map((f) => f.id);
    const chapter = await env.proctor.post(`${API}/sources`, {
      title: "Matrices",
      citationLabel: "BK2",
      fileId,
      pageRange: "7-10",
    });
    expect(chapter.statusCode).toBe(200);
    // A chapter made, the PDF stays in its owner's list for the next one; made whole, it leaves.
    expect(await listed()).toContain(fileId);
    const [rev] = await env.t.db
      .select()
      .from(SourceRevision)
      .where(eq(SourceRevision.sourceId, chapter.json().source.id));
    expect(rev).toMatchObject({ sourceFileId: fileId, sourcePageRange: "7-10" });
    const whole = await env.proctor.post(`${API}/sources`, { title: "Book", citationLabel: "BK", fileId });
    expect(whole.statusCode).toBe(200);
    expect(await listed()).not.toContain(fileId);
    const text = async (sourceId: string) =>
      (await env.t.db.select().from(SourceRevision).where(eq(SourceRevision.sourceId, sourceId)))[0]?.markdown ?? "";
    const [file] = await env.t.db.select().from(SourceFile).where(eq(SourceFile.id, fileId));
    expect(await text(whole.json().source.id)).toBe(file?.markdown as string);
    const ch = await text(chapter.json().source.id);
    expect(ch.startsWith("# Matrices")).toBe(true);
    expect(ch).not.toContain("ordered list");
    expect(ch).toContain("$y_10$");
    // Pages that weren't read can't be made into a source; text sent with the file is the creator's own, and wins.
    const outside = await env.proctor.post(`${API}/sources`, {
      title: "X",
      citationLabel: "X",
      fileId,
      pageRange: "1-2",
    });
    expect(outside.json().code).toBe("convert_bad_range");
    const own = await env.proctor.post(`${API}/sources`, {
      title: "Fixed",
      citationLabel: "FX",
      fileId,
      text: "# Vectors\n\nCorrected by hand.",
    });
    expect(await text(own.json().source.id)).toBe("# Vectors\n\nCorrected by hand.");
    // Neither text nor a file is refused; so is a page range without a file.
    expect((await env.proctor.post(`${API}/sources`, { title: "N", citationLabel: "N" })).statusCode).toBe(400);
    const loose = await env.proctor.post(`${API}/sources`, {
      title: "N",
      citationLabel: "N",
      text: "x",
      pageRange: "1",
    });
    expect(loose.statusCode).toBe(400);
  });
});

describe("a long PDF goes through in batches: the page helpers", () => {
  test("a range is its pages in order; none is every page; past the end is refused", () => {
    expect(selectedPages("5-7,2,6", 10)).toEqual([2, 5, 6, 7]);
    expect(selectedPages(null, 3)).toEqual([1, 2, 3]);
    expect(() => selectedPages("9-11", 10)).toThrow();
    expect(firstPage("9-11,4")).toBe(4);
    expect(firstPage(null)).toBe(1);
    expect(rangeOf([1, 2, 3, 5, 7, 8])).toBe("1-3,5,7-8");
    expect(rangeOf([4])).toBe("4");
  });
});

describe.skipIf(!hasDb)("a long PDF goes through in batches", () => {
  let env: SourceEnv;
  let failNext: ((range: string | undefined) => boolean) | null = null;
  // Each batch answers with the pages it was asked for, so the joined text shows what was read and in what order.
  const batches = new MockConvertServer({
    answer: (_pdf, options) =>
      `## Pages ${options.pageRange}\n\n${"Text from these pages, enough to read as prose. ".repeat(40)}\n`,
    failWhen: (options) => (failNext?.(options.pageRange) ? "timeout" : undefined),
  });
  beforeAll(async () => {
    env = await createSourceEnv({
      CONVERT_URL: batches.url,
      CONVERT_SHARED_SECRET: SECRET,
      UPLOAD_RATE_LIMIT_MAX: "1000",
    });
    env.t.ctx.convert = new ConvertClient(batches.url);
  });
  afterAll(async () => {
    batches.stop();
    await env.queue.stop();
    await env.close();
  });
  const ranges = (from: number) => batches.conversions.slice(from).map((c) => c.options.pageRange);
  const settledFile = (id: string) =>
    until<Record<string, unknown>>(env.proctor, id, (f) => f.status === "ready" || f.status === "failed");

  test("45 pages: the first page alone (it says how many there are), then 20 at a time, joined in order", async () => {
    expect(CONVERT_BATCH_PAGES).toBe(20);
    const from = batches.conversions.length;
    const res = await upload(env.proctor, pdf("%MOCK:pages=45"), "filename=book.pdf");
    const file = await settledFile(res.json().file.id);
    expect(file).toMatchObject({ status: "ready", pageCount: 45, pagesConverted: 45 });
    expect(ranges(from)).toEqual(["1", "2-21", "22-41", "42-45"]);
    const md = (await env.proctor.get(`${API}/sources/files/${file.id}`)).json().file.markdown as string;
    const order = [...md.matchAll(/^## Pages (.+)$/gm)].map((m) => m[1]);
    expect(order).toEqual(["1", "2-21", "22-41", "42-45"]);
  });

  test("a page range is batched within itself", async () => {
    const from = batches.conversions.length;
    const res = await upload(env.proctor, pdf("%MOCK:pages=100"), "filename=chapter.pdf&pageRange=30-55,60");
    const file = await settledFile(res.json().file.id);
    expect(file).toMatchObject({ status: "ready", pageCount: 100, pagesConverted: 27 });
    expect(ranges(from)).toEqual(["30", "31-50", "51-55,60"]);
  });

  test("a failure loses one batch: the retry goes on from the last one done, and nothing is read twice", async () => {
    const from = batches.conversions.length;
    failNext = (range) => range === "22-41";
    const res = await upload(env.proctor, pdf("%MOCK:pages=45"), "filename=flaky.pdf");
    const failed = await settledFile(res.json().file.id);
    expect(failed).toMatchObject({ status: "failed", errorCode: "convert_timeout", pagesConverted: 21, pageCount: 45 });
    // Half-read text isn't shown: the Markdown appears once it's finished and cleaned.
    expect((await env.proctor.get(`${API}/sources/files/${failed.id}`)).json().file.markdown).toBeNull();
    failNext = null;
    expect((await env.proctor.post(`${API}/sources/files/${failed.id}/retry`)).statusCode).toBe(200);
    const file = await settledFile(failed.id as string);
    expect(file).toMatchObject({ status: "ready", pagesConverted: 45 });
    expect(ranges(from)).toEqual(["1", "2-21", "22-41", "22-41", "42-45"]);
    const md = (await env.proctor.get(`${API}/sources/files/${file.id}`)).json().file.markdown as string;
    expect([...md.matchAll(/^## Pages (.+)$/gm)].map((m) => m[1])).toEqual(["1", "2-21", "22-41", "42-45"]);
  });

  test("a batch of blank pages adds nothing and doesn't fail the book", async () => {
    failNext = null;
    const from = batches.conversions.length;
    const blank = new Set(["2-21"]);
    batches.options.failWhen = (options) => (blank.has(options.pageRange ?? "") ? "empty" : undefined);
    const res = await upload(env.proctor, pdf("%MOCK:pages=30"), "filename=blanks.pdf");
    const file = await settledFile(res.json().file.id);
    expect(file).toMatchObject({ status: "ready", pagesConverted: 30 });
    expect(ranges(from)).toEqual(["1", "2-21", "22-30"]);
    const md = (await env.proctor.get(`${API}/sources/files/${file.id}`)).json().file.markdown as string;
    expect([...md.matchAll(/^## Pages (.+)$/gm)].map((m) => m[1])).toEqual(["1", "22-30"]);
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
  // Paths as Surya builds them from SURYA_INFERENCE_URL=…/internal/vlm/v1: health one level up, the rest under /v1.
  const call = (path: string, init: { secret?: string | null; body?: unknown } = {}) =>
    env.t.app.inject({
      method: init.body === undefined ? "GET" : "POST",
      url: `/internal/vlm${path}`,
      headers: {
        ...(init.secret === null ? {} : { authorization: `Bearer ${init.secret ?? SECRET}` }),
        "content-type": "application/json",
      },
      ...(init.body === undefined ? {} : { payload: init.body as object }),
    });

  test("it answers health and the model list where Surya asks, with no key, as Surya sends none there", async () => {
    expect((await call("/health", { secret: null })).json()).toEqual({ ok: true });
    expect((await call("/v1/models", { secret: null })).json().data[0].id).toBe("datalab-to/surya-ocr-2.5");
  });

  test("a page read without the secret, or with a wrong one, is refused and reaches no endpoint", async () => {
    expect((await call("/v1/chat/completions", { secret: null, body: { messages: [] } })).statusCode).toBe(401);
    const res = await call("/v1/chat/completions", { secret: "wrong", body: { messages: [] } });
    expect(res.statusCode).toBe(401);
    expect(env.mock.chatRequests().length).toBe(0);
  });

  test("a chat call goes to the assigned endpoint and model, and is logged as document.ocr", async () => {
    env.setReply(() => "page text");
    const res = await call("/v1/chat/completions", {
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
    const both = await Promise.all([1, 2].map(() => call("/v1/chat/completions", { body: { messages: [] } })));
    expect(both.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(env.mock.maxInFlight).toBe(1);
  });

  test("an unassigned role is a refusal with a reason, and while local-only a cloud endpoint is blocked", async () => {
    await env.t.db.execute(`delete from role_assignment where role = 'document.ocr'` as never);
    expect((await call("/v1/chat/completions", { body: { messages: [] } })).json().code).toBe("llm_role_unassigned");
    await assign(env.t.db, "document.ocr", { url: env.mock.url, location: "cloud" });
    await setLocalOnly(env.t.db, true);
    expect((await call("/v1/chat/completions", { body: { messages: [] } })).json().code).toBe("llm_cloud_blocked");
    await setLocalOnly(env.t.db, false);
  });
});
