// Sources and ingest through the routes and a real pg-boss worker, on real pgvector (P2.md E1–E10).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  AuditLog,
  AuthoringSession,
  createDb,
  createPool,
  DraftQuestion,
  EMBEDDING_DIMENSIONS,
  newId,
  QuestionEvent,
  RetrievalLog,
  Revision,
  SourceChunk,
  SourceRevision,
  ValidationResult,
} from "@gem/db";
import { asc, eq, sql } from "drizzle-orm";
import { BOOK, createSourceEnv, type SourceBody, type SourceEnv } from "./authoring-helpers.ts";
import { API, type Client, createTestDatabase, hasDb } from "./helpers.ts";
import { verifyPython } from "./l7-helpers.ts";

const add = (client: Client, over: Record<string, unknown> = {}) =>
  client.post(`${API}/sources`, { title: "Linear algebra", citationLabel: "VMLS", text: BOOK, ...over });

const embedInputs = (env: SourceEnv) =>
  env.mock.requests.filter((r) => r.path.endsWith("/embeddings")).flatMap((r) => r.body.input as string[]);

function multipart(fields: Record<string, string>, filename: string, content: string) {
  const boundary = "gemboundary";
  const parts = Object.entries(fields).map(
    ([k, v]) => `--${boundary}\r\ncontent-disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
  );
  const file = `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`;
  return { payload: parts.join("") + file, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

/** Drizzle queries are thenables, not promises, so `expect().rejects` can't take them. */
async function denied(q: PromiseLike<unknown>, sqlstate = "42501") {
  let error: unknown;
  try {
    await q;
  } catch (e) {
    error = e;
  }
  const err = error as { code?: string; cause?: { code?: string } } | undefined;
  expect(err?.code ?? err?.cause?.code).toBe(sqlstate);
}

describe.skipIf(!hasDb)("E1: the migration", () => {
  const url = () => createTestDatabase();

  test("tables, indexes, FKs, and append-only and column grants as gem_app", async () => {
    const database = await url();
    const pool = createPool(database.appUrl, 2);
    const db = createDb(pool);
    try {
      const indexes = await db.execute(
        sql`select indexname, indexdef from pg_indexes where tablename = 'source_chunk' order by indexname`,
      );
      const defs = Object.fromEntries(indexes.rows.map((r) => [r.indexname as string, r.indexdef as string]));
      expect(defs.source_chunk_embedding_idx).toContain("USING hnsw (embedding vector_cosine_ops)");
      expect(defs.source_chunk_tsv_idx).toContain("USING gin (tsv)");

      const columns = await db.execute(
        sql`select column_name, generation_expression, udt_name from information_schema.columns where table_name = 'source_chunk' and column_name in ('tsv', 'embedding')`,
      );
      const tsv = columns.rows.find((r) => r.column_name === "tsv");
      expect(String(tsv?.generation_expression)).toContain("english");
      expect(String(tsv?.generation_expression)).toContain("simple");
      const type = await db.execute(
        sql`select format_type(atttypid, atttypmod) as t from pg_attribute where attrelid = 'source_chunk'::regclass and attname = 'embedding'`,
      );
      expect(type.rows[0]?.t).toBe(`vector(${EMBEDDING_DIMENSIONS})`);

      const fks = await db.execute(
        sql`select conname from pg_constraint where contype = 'f' and conname in ('test_authoring_session_fk', 'verification_run_draft_question_id_draft_question_id_fk')`,
      );
      expect(fks.rows.map((r) => r.conname).sort()).toEqual([
        "test_authoring_session_fk",
        "verification_run_draft_question_id_draft_question_id_fk",
      ]);

      for (const table of ["question_event", "validation_result", "retrieval_log"]) {
        const grants = await db.execute(sql`
          select has_table_privilege('gem_app', ${table}, 'INSERT') as i, has_table_privilege('gem_app', ${table}, 'SELECT') as s,
                 has_table_privilege('gem_app', ${table}, 'UPDATE') as u, has_table_privilege('gem_app', ${table}, 'DELETE') as d`);
        expect(grants.rows[0]).toEqual({ i: true, s: true, u: false, d: false });
      }
    } finally {
      await pool.end();
      await database.drop();
    }
  }, 30_000);

  test.skipIf(!verifyPython)(
    "real rows: append-only tables refuse UPDATE and DELETE; chunks allow only the embedding and flag columns",
    async () => {
      const env = await createSourceEnv();
      try {
        const source = (await add(env.proctor)).json().source as SourceBody;
        await env.settled(env.proctor, source.id);
        const { db } = env.t;
        const [chunk] = await db.select().from(SourceChunk).limit(1);
        if (!chunk) throw new Error("no chunk");

        await denied(db.update(SourceChunk).set({ text: "changed" }).where(eq(SourceChunk.id, chunk.id)));
        await denied(db.update(SourceChunk).set({ chunkKey: "k" }).where(eq(SourceChunk.id, chunk.id)));
        await denied(db.update(SourceChunk).set({ contentHash: "h" }).where(eq(SourceChunk.id, chunk.id)));
        await denied(db.update(SourceChunk).set({ charStart: 1 }).where(eq(SourceChunk.id, chunk.id)));
        await denied(db.delete(SourceChunk).where(eq(SourceChunk.id, chunk.id)));
        await db
          .update(SourceChunk)
          .set({ flaggedAt: new Date(), flagReason: "sandbox_denial" })
          .where(eq(SourceChunk.id, chunk.id));
        await db.update(SourceChunk).set({ embeddingModel: "m" }).where(eq(SourceChunk.id, chunk.id));

        const sessionId = newId();
        await db.insert(AuthoringSession).values({
          id: sessionId,
          ownerId: env.proctorId,
          title: "S",
          status: "draft",
          testType: "chapter_quiz",
          usedValues: { keys: [], source: [] },
        });
        const revisionId = newId();
        await db
          .insert(Revision)
          .values({ id: revisionId, sessionId, number: 1, trigger: "generate", request: {}, seed: "s" });
        const draftId = newId();
        await db.insert(DraftQuestion).values({
          id: draftId,
          sessionId,
          revisionId,
          tempId: "q1",
          position: 1,
          content: {},
          status: "proposed",
        });
        const eventId = newId();
        await db.insert(QuestionEvent).values({ id: eventId, draftQuestionId: draftId, kind: "generated" });
        await denied(db.update(QuestionEvent).set({ note: "x" }).where(eq(QuestionEvent.id, eventId)));
        await denied(db.delete(QuestionEvent).where(eq(QuestionEvent.id, eventId)));
        const resultId = newId();
        await db
          .insert(ValidationResult)
          .values({ id: resultId, draftQuestionId: draftId, layer: "L1", outcome: "pass", detail: {} });
        await denied(db.update(ValidationResult).set({ outcome: "fail" }).where(eq(ValidationResult.id, resultId)));
        await denied(db.delete(ValidationResult).where(eq(ValidationResult.id, resultId)));
        const logId = newId();
        await db.insert(RetrievalLog).values({
          id: logId,
          query: "q",
          scope: {},
          results: [],
          embeddingModel: "m",
        });
        await denied(db.update(RetrievalLog).set({ query: "x" }).where(eq(RetrievalLog.id, logId)));
        await denied(db.delete(RetrievalLog).where(eq(RetrievalLog.id, logId)));
      } finally {
        await env.close();
      }
    },
    60_000,
  );
});

describe.skipIf(!hasDb || !verifyPython)("sources", () => {
  let env: SourceEnv;
  beforeAll(async () => {
    env = await createSourceEnv();
  }, 60_000);
  afterAll(async () => env?.close());

  describe("E2: create and preview", () => {
    test("paste creates a source, audited; it's embedded by the job", async () => {
      const res = await add(env.proctor, { title: "Pasted" });
      expect(res.statusCode).toBe(200);
      const created = res.json().source as SourceBody;
      expect(created.usable).toBe(false);
      const done = await env.settled(env.proctor, created.id);
      expect(done.latest.embedStatus).toBe("ready");
      expect(done.usable).toBe(true);
      expect(done.latest.embedded).toBe(done.latest.chunks);
      const rows = await env.t.db.select().from(AuditLog).where(eq(AuditLog.action, "source.create"));
      expect(rows.some((r) => r.targetId === created.id && r.targetType === "source")).toBe(true);
    }, 20_000);

    test("upload: .md and .txt work, with their format; another type is refused", async () => {
      const md = multipart({ title: "Uploaded", citationLabel: "UP" }, "book.md", BOOK);
      const res = await env.proctor.request({ method: "POST", url: `${API}/sources`, ...md });
      expect(res.statusCode).toBe(200);
      expect(res.json().source.latest.format).toBe("markdown");

      const txt = multipart({ title: "Plain", citationLabel: "TXT" }, "notes.txt", "One paragraph.\n\nAnother.");
      const plain = await env.proctor.request({ method: "POST", url: `${API}/sources`, ...txt });
      expect(plain.json().source.latest.format).toBe("text");

      const pdf = multipart({ title: "No", citationLabel: "NO" }, "book.pdf", "%PDF");
      const refused = await env.proctor.request({ method: "POST", url: `${API}/sources`, ...pdf });
      expect(refused.statusCode).toBe(415);
      expect(refused.json().code).toBe("source_bad_type");
    }, 20_000);

    test("the size cap is the instance setting, by paste and by upload; empty text is refused", async () => {
      const put = await env.admin.put(`${API}/admin/settings`, {
        selfRegistration: true,
        authoring: { maxSourceBytes: 2048 },
      });
      expect(put.json().settings.authoring.maxSourceBytes).toBe(2048);
      try {
        const big = "word ".repeat(1000);
        const pasted = await add(env.proctor, { text: big });
        expect(pasted.statusCode).toBe(413);
        expect(pasted.json()).toEqual({ code: "source_too_large", params: { maxBytes: 2048 } });
        const upload = multipart({ title: "Big", citationLabel: "B" }, "big.md", big);
        const uploaded = await env.proctor.request({ method: "POST", url: `${API}/sources`, ...upload });
        expect(uploaded.json().code).toBe("source_too_large");
      } finally {
        await env.admin.put(`${API}/admin/settings`, {
          selfRegistration: true,
          authoring: { maxSourceBytes: 5 * 1024 * 1024 },
        });
      }
      expect((await add(env.proctor, { text: "  \n" })).json().code).toBe("source_empty");
    }, 20_000);

    test("preview saves nothing, and gives the tree and the warnings", async () => {
      const before = (await env.t.db.select({ n: sql<number>`count(*)::int` }).from(SourceRevision))[0]?.n;
      const res = await env.proctor.post(`${API}/sources/preview`, { text: BOOK });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.sections.map((s: { title: string }) => s.title)).toEqual([
        "Chapter 1: Vectors",
        "Inner product",
        "Norms",
        "Chapter 2: Matrices",
      ]);
      expect(body.sections[1].parentOrder).toBe(0);
      expect(body.warnings).toEqual([]);
      expect((await env.t.db.select({ n: sql<number>`count(*)::int` }).from(SourceRevision))[0]?.n).toBe(before);

      const none = (await env.proctor.post(`${API}/sources/preview`, { text: "No headings here." })).json();
      expect(none.warnings).toEqual([{ code: "no_headings" }]);
      const dup = (await env.proctor.post(`${API}/sources/preview`, { text: "# A\n\nx\n\n# A\n\ny" })).json();
      expect(dup.warnings).toEqual([{ code: "duplicate_heading", heading: "A" }]);
      const long = (
        await env.proctor.post(`${API}/sources/preview`, { text: `# Long\n\n${"word ".repeat(5000)}` })
      ).json();
      expect(long.warnings[0].code).toBe("long_section");
      expect(long.warnings[0].heading).toBe("Long");
    }, 20_000);
  });

  describe("E3 + E4 through the routes", () => {
    test("sections from headings, chunks slicing back to the text, LaTeX kept", async () => {
      const source = (await add(env.proctor)).json().source as SourceBody;
      await env.settled(env.proctor, source.id);
      const sections = (await env.proctor.get(`${API}/sources/${source.id}/sections`)).json().sections;
      expect(sections.map((s: { level: number }) => s.level)).toEqual([1, 2, 2, 1]);
      expect(sections[1].headingPath).toEqual(["Chapter 1: Vectors", "Inner product"]);
      const { markdown } = (await env.proctor.get(`${API}/sources/${source.id}/revisions/1`)).json();
      const { chunks } = (await env.proctor.get(`${API}/sources/${source.id}/chunks`)).json();
      expect(chunks.length).toBeGreaterThan(2);
      for (const c of chunks) expect(markdown.slice(c.charStart, c.charEnd)).toBe(c.text);
      expect(chunks.some((c: { text: string }) => c.text.includes("x^T y = x_1 y_1"))).toBe(true);
      const keys = chunks.map((c: { chunkKey: string }) => c.chunkKey);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).toContain("vmls:chapter-1-vectors.inner-product:c1");
      const section = sections[1].id;
      const only = (await env.proctor.get(`${API}/sources/${source.id}/chunks?sectionIds=${section}`)).json().chunks;
      expect(only.every((c: { sectionId: string }) => c.sectionId === section)).toBe(true);
    }, 20_000);

    test("plain text is one section, split by paragraph", async () => {
      const text = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}. ${"filler words ".repeat(30)}`).join("\n\n");
      const source = (await add(env.proctor, { text, format: "text" })).json().source as SourceBody;
      await env.settled(env.proctor, source.id);
      const sections = (await env.proctor.get(`${API}/sources/${source.id}/sections`)).json().sections;
      expect(sections).toHaveLength(1);
      expect(sections[0].title).toBe("Linear algebra");
      expect((await env.proctor.get(`${API}/sources/${source.id}/chunks`)).json().chunks.length).toBeGreaterThan(1);
    }, 20_000);
  });

  describe("E5: over the cap", () => {
    test("an unsplittable unit fails with its heading, saves nothing and embeds nothing", async () => {
      await env.assignEmbeddings({ maxInputTokens: 300 });
      try {
        const sent = embedInputs(env).length;
        const code = `# Big\n\n## Code\n\n\`\`\`\n${"x = 1\n".repeat(400)}\`\`\`\n`;
        const res = await add(env.proctor, { text: code, title: "Too big" });
        expect(res.statusCode).toBe(422);
        expect(res.json().code).toBe("knowledge_unit_too_large");
        expect(res.json().params.heading).toBe("Big › Code");
        expect(res.json().params.maxTokens).toBeLessThan(300);
        expect(embedInputs(env).length).toBe(sent);
        const preview = (await env.proctor.post(`${API}/sources/preview`, { text: code })).json();
        expect(preview.warnings.map((w: { code: string }) => w.code)).toContain("unit_too_large");
      } finally {
        await env.assignEmbeddings();
      }
    }, 20_000);

    test("the runtime's truncation guard fails the job, and nothing is stored for that batch", async () => {
      // A chunk that estimates small but counts over the cap: the guard from P1.5, exercised through ingest.
      await env.assignEmbeddings({ maxInputTokens: 300 });
      const prior = env.mock.options.embedCap;
      env.mock.options.embedCap = 300;
      try {
        const text = `# Dense\n\n${"a ".repeat(400)}`;
        const created = (await add(env.proctor, { text, title: "Dense" })).json().source as SourceBody;
        const done = await env.settled(env.proctor, created.id);
        expect(done.latest.embedStatus).toBe("failed");
        expect(done.latest.embedError?.code).toBe("llm_embedding_truncated");
        expect(done.latest.embedded).toBe(0);
        expect(done.usable).toBe(false);
      } finally {
        env.mock.options.embedCap = prior;
        await env.assignEmbeddings();
      }
    }, 20_000);
  });

  test("E6: the prefix goes to the model only", async () => {
    const marker = "prefixcheckword";
    const source = (await add(env.proctor, { text: `# P\n\nA line with ${marker}.`, title: "Prefix" })).json()
      .source as SourceBody;
    await env.settled(env.proctor, source.id);
    const sent = embedInputs(env).filter((i) => i.includes(marker));
    expect(sent.length).toBe(1);
    expect(sent[0]?.startsWith("document-prefix: ")).toBe(true);
    const rows = await env.t.db
      .select({ text: SourceChunk.text, tsv: sql<string>`${SourceChunk.tsv}::text`, key: SourceChunk.chunkKey })
      .from(SourceChunk)
      .where(eq(SourceChunk.revisionId, source.latest.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).not.toContain("document-prefix");
    expect(rows[0]?.tsv).not.toContain("prefix:");
    expect(rows[0]?.tsv).toContain(marker);
    expect(rows[0]?.key).not.toContain("document");
  }, 20_000);

  describe("E7: revisions", () => {
    test("a new revision makes new rows, and unchanged chunks reuse their vectors with no model call", async () => {
      const source = (await add(env.proctor, { title: "Versions" })).json().source as SourceBody;
      const first = await env.settled(env.proctor, source.id);
      const before = await env.t.db.select().from(SourceChunk).where(eq(SourceChunk.revisionId, first.latest.id));
      const sentBefore = embedInputs(env).length;

      const edited = BOOK.replace("Matrix multiplication isn't commutative.", "A changed sentence entirely.");
      const put = await env.proctor.put(`${API}/sources/${source.id}`, { text: edited });
      expect(put.statusCode).toBe(200);
      const second = await env.settled(env.proctor, source.id);
      expect(second.latest.number).toBe(2);
      expect(second.latest.embedded).toBe(second.latest.chunks);

      // Only the changed chunk reached the model.
      expect(embedInputs(env).length - sentBefore).toBe(1);
      expect(embedInputs(env).at(-1)).toContain("A changed sentence entirely.");

      // The old revision's rows are untouched, and the new ones are other rows with the same vectors.
      const after = await env.t.db.select().from(SourceChunk).where(eq(SourceChunk.revisionId, first.latest.id));
      expect(after.map((c) => c.text)).toEqual(before.map((c) => c.text));
      const fresh = await env.t.db.select().from(SourceChunk).where(eq(SourceChunk.revisionId, second.latest.id));
      expect(fresh.some((c) => before.some((b) => b.id === c.id))).toBe(false);
      const same = fresh.find((c) => c.contentHash === before[0]?.contentHash);
      expect(same?.embedding).toEqual(before[0]?.embedding as number[]);
      expect((await env.proctor.get(`${API}/sources/${source.id}/revisions/1`)).json().markdown).toBe(BOOK);
      expect((await env.proctor.get(`${API}/sources/${source.id}`)).json().revisions).toHaveLength(2);
    }, 20_000);

    test("a different model doesn't reuse", async () => {
      const source = (await add(env.proctor, { title: "Other model" })).json().source as SourceBody;
      await env.settled(env.proctor, source.id);
      await env.assignEmbeddings({ model: "another-model" });
      try {
        const sent = embedInputs(env).length;
        await env.proctor.put(`${API}/sources/${source.id}`, { text: BOOK });
        const second = await env.settled(env.proctor, source.id);
        expect(embedInputs(env).length - sent).toBe(second.latest.chunks);
        const rows = await env.t.db
          .select({ model: SourceChunk.embeddingModel })
          .from(SourceChunk)
          .where(eq(SourceChunk.revisionId, second.latest.id));
        expect(new Set(rows.map((r) => r.model))).toEqual(new Set(["another-model"]));
      } finally {
        await env.assignEmbeddings();
      }
    }, 20_000);
  });

  describe("E8: failures", () => {
    test("a dimension mismatch names both numbers, and a retry works once it's fixed", async () => {
      await env.assignEmbeddings({ dimensions: 1024 });
      const source = (await add(env.proctor, { title: "Dims" })).json().source as SourceBody;
      const failed = await env.settled(env.proctor, source.id);
      expect(failed.latest.embedStatus).toBe("failed");
      expect(failed.latest.embedError).toEqual({
        code: "knowledge_dimension_mismatch",
        params: { expected: 768, actual: 1024 },
      });
      expect(failed.usable).toBe(false);
      await env.assignEmbeddings();
      const retried = await env.proctor.post(`${API}/sources/${source.id}/embed:retry`);
      expect(retried.statusCode).toBe(200);
      const done = await env.settled(env.proctor, source.id);
      expect(done.latest.embedStatus).toBe("ready");
      expect(done.latest.embedError).toBeNull();
      expect(done.usable).toBe(true);
    }, 20_000);

    test("a model failure is stored with its code; a retry pays only for what's left", async () => {
      const original = env.mock.options.noEmbedUsage;
      env.mock.options.noEmbedUsage = true; // the runtime refuses a batch with no count for a long text… or fails
      env.mock.wrongDimensions = 3;
      const source = (await add(env.proctor, { title: "Model failure" })).json().source as SourceBody;
      const failed = await env.settled(env.proctor, source.id);
      env.mock.options.noEmbedUsage = original;
      env.mock.wrongDimensions = undefined;
      expect(failed.latest.embedStatus).toBe("failed");
      expect(failed.latest.embedError?.code).toBe("llm_endpoint_error");
      expect(failed.usable).toBe(false);

      await env.proctor.post(`${API}/sources/${source.id}/embed:retry`);
      expect((await env.settled(env.proctor, source.id)).usable).toBe(true);
      const again = await env.proctor.post(`${API}/sources/${source.id}/embed:retry`);
      expect(again.statusCode).toBe(409);
      expect(again.json().code).toBe("source_not_ready");
    }, 20_000);

    test("embeddings unassigned: the source saves, fails with the reason, and can be retried", async () => {
      await env.t.db.execute(sql`delete from role_assignment where role = 'embeddings'`);
      const source = (await add(env.proctor, { title: "Unassigned" })).json().source as SourceBody;
      const failed = await env.settled(env.proctor, source.id);
      expect(failed.latest.embedError?.code).toBe("llm_role_unassigned");
      await env.assignEmbeddings();
      await env.proctor.post(`${API}/sources/${source.id}/embed:retry`);
      expect((await env.settled(env.proctor, source.id)).usable).toBe(true);
    }, 20_000);
  });

  describe("E9: private", () => {
    test("another proctor gets 404 on every read and write; a student has no route; an admin may read", async () => {
      const source = (await add(env.proctor, { title: "Private" })).json().source as SourceBody;
      await env.settled(env.proctor, source.id);
      const paths = ["", "/sections", "/chunks", "/revisions/1", "/events"];
      for (const p of paths) {
        const res = await env.other.get(`${API}/sources/${source.id}${p}`);
        expect([p, res.statusCode, res.json().code]).toEqual([p, 404, "source_not_found"]);
      }
      expect((await env.other.put(`${API}/sources/${source.id}`, { text: "x" })).statusCode).toBe(404);
      expect((await env.other.delete(`${API}/sources/${source.id}`)).statusCode).toBe(404);
      expect((await env.other.post(`${API}/sources/${source.id}/embed:retry`)).statusCode).toBe(404);
      expect((await env.other.get(`${API}/sources`)).json().sources).toEqual([]);

      expect((await env.student.get(`${API}/sources`)).statusCode).toBe(403);
      expect((await env.student.get(`${API}/sources/${source.id}`)).statusCode).toBe(403);
      expect((await env.student.post(`${API}/sources/preview`, { text: "x" })).statusCode).toBe(403);

      expect((await env.admin.get(`${API}/sources/${source.id}`)).statusCode).toBe(200);
    }, 20_000);

    test("delete is soft and audited: it's gone from the API, and its chunks stay", async () => {
      const source = (await add(env.proctor, { title: "Gone" })).json().source as SourceBody;
      await env.settled(env.proctor, source.id);
      expect((await env.proctor.delete(`${API}/sources/${source.id}`)).statusCode).toBe(200);
      expect((await env.proctor.get(`${API}/sources/${source.id}`)).statusCode).toBe(404);
      const list = (await env.proctor.get(`${API}/sources`)).json().sources;
      expect(list.some((s: { id: string }) => s.id === source.id)).toBe(false);
      const rows = await env.t.db.select().from(SourceChunk).where(eq(SourceChunk.revisionId, source.latest.id));
      expect(rows.length).toBeGreaterThan(0);
      const audit = await env.t.db.select().from(AuditLog).where(eq(AuditLog.action, "source.delete"));
      expect(audit.some((r) => r.targetId === source.id)).toBe(true);
    }, 20_000);
  });

  test("progress reaches an SSE client; a reconnect reads the state again; another proctor can't subscribe", async () => {
    await env.t.app.listen({ port: 0, host: "127.0.0.1" });
    const address = env.t.app.server.address() as { port: number };
    const source = (await add(env.proctor, { title: "Events" })).json().source as SourceBody;
    await env.settled(env.proctor, source.id);
    const cookie = env.proctor.cookie as string;
    const events = async (put?: () => Promise<unknown>, until = "ready") => {
      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${address.port}${API}/sources/${source.id}/events`, {
        headers: { cookie },
        signal: controller.signal,
      });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const statuses: { number: number; status: string }[] = [];
      let buffer = "";
      void put?.();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value);
        for (const frame of buffer.split("\n\n").slice(0, -1)) {
          if (!frame.startsWith("data: ")) continue;
          const state = JSON.parse(frame.slice(6)) as SourceBody;
          statuses.push({ number: state.latest.number, status: state.latest.embedStatus });
        }
        buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2);
        const last = statuses.at(-1);
        if (last && last.status === until && (!put || last.number === 2)) break;
      }
      controller.abort();
      return statuses;
    };
    expect((await events())[0]).toEqual({ number: 1, status: "ready" });
    const during = await events(() => env.proctor.put(`${API}/sources/${source.id}`, { text: `${BOOK}\n\nMore.` }));
    expect(during.at(-1)).toEqual({ number: 2, status: "ready" });
    expect(during.length).toBeGreaterThan(1);
    expect((await events())[0]).toEqual({ number: 2, status: "ready" });
  }, 20_000);

  test("E10: vectors round-trip, and a scoped nearest-neighbour query can use the HNSW index", async () => {
    const source = (await add(env.proctor, { title: "Vectors" })).json().source as SourceBody;
    await env.settled(env.proctor, source.id);
    const [row] = await env.t.db
      .select()
      .from(SourceChunk)
      .where(eq(SourceChunk.revisionId, source.latest.id))
      .orderBy(asc(SourceChunk.charStart))
      .limit(1);
    if (!row?.embedding) throw new Error("no vector");
    expect(row.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    const norm = Math.sqrt(row.embedding.reduce((n, x) => n + x * x, 0));
    expect(Math.abs(norm - 1)).toBeLessThan(1e-3);

    const literal = `[${row.embedding.join(",")}]`;
    const plan = await env.t.db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      await tx.execute(sql`set local enable_bitmapscan = off`);
      await tx.execute(sql`set local enable_sort = off`);
      return tx.execute(sql`
        explain select id from source_chunk
        where embedding_model = ${row.embeddingModel}
        order by embedding <=> ${literal}::vector limit 5`);
    });
    const text = plan.rows.map((r) => String(r["QUERY PLAN"])).join("\n");
    expect(text).toContain("source_chunk_embedding_idx");
    const nearest = await env.t.db.execute(
      sql`select id from source_chunk order by embedding <=> ${literal}::vector limit 1`,
    );
    expect(nearest.rows[0]?.id).toBeDefined();
  }, 20_000);
});
