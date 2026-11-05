// bun run live:pdf: P2.2 M27 and M10b, live, against a running Compose stack with the `convert` profile (the API, its
// workers, the converter, and the models on the box in LLM_DEV_*). It works as a client would, over HTTP, and reads the
// call log from the stack's database for timings. On a stack of its own (it adds an endpoint, roles and a proctor):
//
//   M27  the text PDF and the scan uploaded, converted, scored, saved as sources, embedded; questions authored from
//        an equation-bearing section, with their quotes checked by L2.
//   M10b with a 10-page conversion running, GET /health, a practice route and an authoring session read, against the
//        same idle (p95); an objectives call against one made idle, from the call log; page reads one at a time.
//
// Settings (environment): LIVE_API (default http://127.0.0.1:3300), LIVE_DATABASE_URL (gem_app on the stack's
// Postgres), LIVE_ADMIN_EMAIL, LIVE_ADMIN_PASSWORD; LLM_DEV_* from .env. The report goes to
// ~/.cache/live-pdf-report.json.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { loadConfig } from "../apps/api/src/config.ts";
import { devAssignments } from "../apps/api/src/llm-seed.ts";
import { type Expected, scoreConversion, textSimilarity } from "../packages/convert/src/index.ts";

const ROOT = join(import.meta.dir, "..");
const FIXTURES = join(ROOT, "apps", "convert", "tests", "fixtures");
const BASE = `${process.env.LIVE_API ?? "http://127.0.0.1:3300"}/api/v1`;
const REPORT = join(homedir(), ".cache", "live-pdf-report.json");
const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};
const db = new pg.Pool({ connectionString: need("LIVE_DATABASE_URL"), max: 2 });
const dev = loadConfig(process.env, process.env.ENV_FILE ?? join(ROOT, ".env"));
const expected = JSON.parse(readFileSync(join(FIXTURES, "linear-algebra.expected.json"), "utf8")) as Expected & {
  source: string;
};
const sourceText = readFileSync(join(ROOT, expected.source), "utf8");

const t0 = Date.now();
const log = (line: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}`);
const round = (n: number, d = 1) => Number(n.toFixed(d));
const report: Record<string, unknown> = { started: new Date().toISOString(), api: BASE };

// ── a client with a session ─────────────────────────────────────────

class Client {
  private cookie = "";
  async req(method: string, path: string, body?: unknown, raw?: { bytes: Uint8Array; type: string }) {
    const headers: Record<string, string> = {};
    if (this.cookie) headers.cookie = this.cookie;
    let payload: string | Uint8Array | undefined;
    if (raw) {
      headers["content-type"] = raw.type;
      payload = raw.bytes;
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
    const set = res.headers.getSetCookie();
    if (set.length > 0) this.cookie = set.map((c) => c.split(";")[0]).join("; ");
    const text = await res.text();
    // Untyped on purpose: a live script reads what the stack answers, and fails loudly where it isn't there.
    let json = JSON.parse("{}");
    try {
      json = text ? JSON.parse(text) : {};
    } catch {}
    return { status: res.status, json, text };
  }
  async ok(method: string, path: string, body?: unknown, raw?: { bytes: Uint8Array; type: string }) {
    const r = await this.req(method, path, body, raw);
    if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${r.text.slice(0, 400)}`);
    return r.json;
  }
}

async function until<T>(what: string, read: () => Promise<T | undefined>, ms = 30 * 60_000, every = 1000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== undefined) return v;
    await Bun.sleep(every);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const p95 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? Number.NaN : (s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] as number);
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? Number.NaN : (s[Math.floor(s.length / 2)] as number);
};

/** One timed GET of each interactive route, `rounds` times, interleaved. */
async function sampleRoutes(c: Client, routes: Record<string, string>, keepGoing: () => boolean, max = 200) {
  const ms: Record<string, number[]> = Object.fromEntries(Object.keys(routes).map((k) => [k, []]));
  for (let i = 0; i < max && keepGoing(); i++) {
    for (const [name, path] of Object.entries(routes)) {
      const s = performance.now();
      const r = await c.req("GET", path);
      if (r.status >= 300) throw new Error(`GET ${path}: ${r.status}`);
      ms[name]?.push(performance.now() - s);
    }
    await Bun.sleep(150);
  }
  return Object.fromEntries(
    Object.entries(ms).map(([k, v]) => [k, { n: v.length, p50: round(median(v)), p95: round(p95(v)) }]),
  ) as Record<string, { n: number; p50: number; p95: number }>;
}

// ── setup: the models, as an admin would assign them ────────────────

const admin = new Client();
await admin.ok("POST", "/auth/login", { email: need("LIVE_ADMIN_EMAIL"), password: need("LIVE_ADMIN_PASSWORD") });
const assignments = devAssignments(dev);
if (assignments.length === 0) throw new Error("LLM_DEV_* is not set: nothing to run against");
const endpoints = new Map<string, string>();
// A second run on the same stack reuses what the first made.
const existing = (await admin.ok("GET", "/admin/llm/endpoints")).endpoints as { id: string; label: string }[];
for (const a of assignments) {
  const key = a.endpoint.baseUrl ?? a.endpoint.label;
  const same = existing.find((e) => e.label === a.endpoint.label);
  if (same && !endpoints.has(key)) endpoints.set(key, same.id);
  if (!endpoints.has(key)) {
    const { endpoint } = await admin.ok("POST", "/admin/llm/endpoints", {
      label: a.endpoint.label,
      provider: a.endpoint.provider,
      baseUrl: a.endpoint.baseUrl,
      location: a.endpoint.location,
      server: a.endpoint.server ?? undefined,
      concurrency: a.endpoint.concurrency,
      timeoutMs: a.endpoint.timeoutMs,
    });
    endpoints.set(key, endpoint.id);
  }
  await admin.ok("PUT", `/admin/llm/roles/${a.role}`, {
    endpointId: endpoints.get(key),
    model: a.model,
    capabilities: a.capabilities,
    ...(a.embedding ? { embedding: a.embedding } : {}),
    ...(a.params ? { params: a.params } : {}),
  });
}
// The vision model: the same endpoint as generation, so one queue serves both (P2.2.md §5 "One queue").
const chat = assignments.find((a) => a.role === "authoring.generate") ?? assignments[0];
const ocrEndpoint = endpoints.get(chat?.endpoint.baseUrl ?? "") as string;
await admin.ok("PUT", "/admin/llm/roles/document.ocr", {
  endpointId: ocrEndpoint,
  model: "datalab-to/surya-ocr-2.5:latest",
  capabilities: { structuredOutput: "native_schema", contextWindow: 16384, maxOutputTokens: 12288 },
});
report.roles = [...assignments.map((a) => `${a.role}=${a.model}`), "document.ocr=datalab-to/surya-ocr-2.5:latest"];
const settings = (await admin.ok("GET", "/admin/settings")).settings;
await admin.ok("PUT", "/admin/settings", { ...settings, selfRegistration: true });

const proctor = new Client();
const proctorEmail = `live-pdf-${Date.now()}@example.com`;
const reg = await proctor.ok("POST", "/auth/register", {
  email: proctorEmail,
  password: "live pdf password 123",
  displayName: "Live Proctor",
});
await admin.ok("PUT", `/admin/users/${reg.user.id}/roles`, { role: "proctor" });
await proctor.ok("POST", "/auth/login", { email: proctorEmail, password: "live pdf password 123" });
log(`set up: ${(report.roles as string[]).join(", ")}`);

// ── helpers on the stack ────────────────────────────────────────────

type FileView = {
  id: string;
  status: string;
  errorCode: string | null;
  pageCount: number | null;
  pagesConverted: number | null;
  markdown?: string;
  warnings: { code: string }[];
  startedAt: string | null;
  finishedAt: string | null;
};
const fileOf = async (id: string) => (await proctor.ok("GET", `/sources/files/${id}`)).file as FileView;
async function upload(name: string, bytes: Uint8Array, query = "") {
  const { file } = await proctor.ok("POST", `/sources/files?filename=${encodeURIComponent(name)}${query}`, undefined, {
    bytes,
    type: "application/pdf",
  });
  return file as FileView;
}
const finished = (id: string) =>
  until(`file ${id} to convert`, async () => {
    const f = await fileOf(id);
    return f.status === "ready" || f.status === "failed" ? f : undefined;
  });
async function ocrCalls(since: Date) {
  const r = await db.query(
    `select latency_ms, queued_ms, outcome, at from llm_call_log where role = 'document.ocr' and at >= $1 order by at`,
    [since],
  );
  return r.rows as { latency_ms: number; queued_ms: number; outcome: string; at: Date }[];
}
async function sectionId(sourceId: string, title: string) {
  const r = await db.query(
    `select s.id from source_section s join source_revision r on r.id = s.revision_id
      where r.source_id = $1 and lower(s.title) = lower($2) order by r.created_at desc limit 1`,
    [sourceId, title],
  );
  return r.rows[0]?.id as string | undefined;
}
async function newSession(title: string, sourceId: string, sectionIds?: string[]) {
  const { session } = await proctor.ok("POST", "/authoring/sessions", {
    title,
    testType: "chapter_quiz",
    sources: [{ sourceId, ...(sectionIds ? { sectionIds } : {}) }],
  });
  return session.id as string;
}
/** One objectives call, timed by the call log: what an interactive model call waits and takes. */
async function proposeTimed(sessionId: string) {
  const since = new Date();
  const s = performance.now();
  const res = await proctor.req("POST", `/authoring/sessions/${sessionId}/objectives:propose`);
  const wall = performance.now() - s;
  const calls = (
    await db.query(
      `select queued_ms, latency_ms, outcome from llm_call_log where role = 'authoring.objectives' and at >= $1`,
      [since],
    )
  ).rows as { queued_ms: number; latency_ms: number; outcome: string }[];
  return {
    status: res.status,
    objectives: res.json.objectives?.length ?? 0,
    wallMs: Math.round(wall),
    calls: calls.length,
    queuedMs: calls.reduce((n, c) => n + c.queued_ms, 0),
    latencyMs: calls.reduce((n, c) => n + c.latency_ms, 0),
  };
}

let failed = false;
const work = mkdtempSync(join(tmpdir(), "gem-live-pdf-"));
try {
  // ── M27: the two fixtures, end to end ─────────────────────────────

  const conversions: Record<string, unknown>[] = [];
  const sources: Record<string, string> = {};
  for (const [name, title] of [
    ["linear-algebra.pdf", "Vectors and matrices (text PDF)"],
    ["linear-algebra-scan.pdf", "Vectors and matrices (scan)"],
  ] as const) {
    const since = new Date();
    const s = performance.now();
    const f0 = await upload(name, readFileSync(join(FIXTURES, name)));
    const f = await finished(f0.id);
    const seconds = (performance.now() - s) / 1000;
    const calls = await ocrCalls(since);
    if (f.status !== "ready") {
      conversions.push({ file: name, status: f.status, errorCode: f.errorCode, seconds: round(seconds) });
      log(`${name}: ${f.status} ${f.errorCode}`);
      failed = true;
      continue;
    }
    const detail = await fileOf(f.id);
    const score = scoreConversion(detail.markdown ?? "", expected);
    const similarity = textSimilarity(detail.markdown ?? "", sourceText);
    const row = {
      file: name,
      status: f.status,
      seconds: round(seconds),
      secondsPerPage: round(seconds / (f.pagesConverted ?? 1)),
      pages: `${f.pagesConverted}/${f.pageCount}`,
      formulas: `${score.formulasMatched}/${score.formulasExpected}`,
      headings: `${score.headingsFound}/${score.headingsExpected}`,
      similarity: round(similarity, 3),
      warnings: detail.warnings.map((w) => w.code),
      missed: score.missed,
      pageReads: calls.length,
      pageReadMs: { p50: median(calls.map((c) => c.latency_ms)), max: Math.max(...calls.map((c) => c.latency_ms)) },
      pageReadsFailed: calls.filter((c) => c.outcome !== "ok").length,
    };
    conversions.push(row);
    log(`${name}: ${JSON.stringify(row)}`);
    // The preview as the creator saves it: the converted Markdown, unedited.
    const { source } = await proctor.ok("POST", "/sources", {
      title,
      citationLabel: name.includes("scan") ? "LA-scan" : "LA-text",
      text: detail.markdown,
      fileId: f.id,
    });
    await until(`${title} to embed`, async () => {
      const latest = (await proctor.ok("GET", `/sources/${source.id}`)).source.latest;
      if (latest.embedStatus === "failed") throw new Error(`embedding failed: ${JSON.stringify(latest.embedError)}`);
      return latest.embedStatus === "ready" ? latest : undefined;
    });
    const linked = await db.query(
      `select count(*)::int as n from source_revision where source_id = $1 and source_file_id = $2`,
      [source.id, f.id],
    );
    log(`${title}: saved and embedded; revision points at its file: ${linked.rows[0]?.n === 1}`);
    sources[name] = source.id;
  }
  report.conversions = conversions;

  // ── M10b: interactive speed during a conversion ───────────────────

  const sourceId = sources["linear-algebra-scan.pdf"] ?? sources["linear-algebra.pdf"];
  if (!sourceId) throw new Error("no source was saved: nothing to measure against");
  const section = await sectionId(sourceId, "Inner product");
  if (!section) throw new Error("the converted source has no 'Inner product' section");
  const readSession = await newSession("Live read target", sourceId, [section]);
  const routes = {
    health: "/health",
    practice: "/practice/attempts",
    authoring: `/authoring/sessions/${readSession}`,
  };
  const idle = await sampleRoutes(proctor, routes, () => true, 60);
  log(`idle: ${JSON.stringify(idle)}`);
  const idleGen = await proposeTimed(await newSession("Live idle call", sourceId, [section]));
  log(`idle objectives call: ${JSON.stringify(idleGen)}`);

  // Ten pages: the scan five times over, so the conversion outlasts the measurements.
  const long = join(work, "long-scan.pdf");
  const united = spawnSync("pdfunite", [...Array(5).fill(join(FIXTURES, "linear-algebra-scan.pdf")), long]);
  if (united.status !== 0) throw new Error(`pdfunite: ${united.stderr}`);
  const since = new Date();
  const longFile = await upload("long-scan.pdf", readFileSync(long));
  await until(
    "the long conversion's first page read",
    async () => ((await ocrCalls(since)).length > 0 ? 1 : undefined),
    5 * 60_000,
    250,
  );
  let converting = true;
  const genDuring = proposeTimed(await newSession("Live call during a conversion", sourceId, [section]));
  const busy = sampleRoutes(proctor, routes, () => converting, 400);
  const longDone = await finished(longFile.id);
  converting = false;
  const [during, gen] = await Promise.all([busy, genDuring]);
  const reads = await ocrCalls(since);
  const maxRead = Math.max(...reads.map((c) => c.latency_ms));
  const overlap = await db.query(
    `select count(*)::int as n from llm_call_log a join llm_call_log b
       on a.endpoint_id = b.endpoint_id and a.id < b.id
      where a.at >= $1 and b.at >= $1
        -- 50 ms of slack: a row's \`at\` is written just after its slot is released, so the next call starts
        -- a millisecond or so "before" the one it followed ended.
        and (a.at - make_interval(secs => a.latency_ms / 1000.0)) < b.at - interval '50 milliseconds'
        and (b.at - make_interval(secs => b.latency_ms / 1000.0)) < a.at - interval '50 milliseconds'`,
    [since],
  );
  const ratio = Object.fromEntries(
    Object.keys(routes).map((k) => [k, round((during[k]?.p95 ?? 0) / (idle[k]?.p95 ?? 1), 2)]),
  );
  const m10b = {
    conversion: {
      status: longDone.status,
      errorCode: longDone.errorCode,
      pages: longDone.pagesConverted,
      pageReads: reads.length,
      pageReadMs: { p50: median(reads.map((c) => c.latency_ms)), max: maxRead },
    },
    idle,
    during,
    p95Ratio: ratio,
    routesWithin2x: Object.values(ratio).every((r) => r <= 2),
    objectivesIdle: idleGen,
    objectivesDuring: gen,
    // What a conversion can add to a model call is the wait for the endpoint's slot: at most the page read in flight.
    // The call's own time is the model's (the same prompt took 58 s and 106 s idle on two runs), so it is recorded,
    // not compared.
    generationWaitMs: gen.queuedMs,
    generationWithinOnePageRead: gen.queuedMs <= maxRead,
    callsOverlappingOnTheEndpoint: overlap.rows[0]?.n,
  };
  report.m10b = m10b;
  log(`M10b: ${JSON.stringify(m10b)}`);
  if (!m10b.routesWithin2x || !m10b.generationWithinOnePageRead || longDone.status !== "ready") failed = true;

  // ── M27: questions from an equation-bearing passage ────────────────

  const authoring = await newSession("Live PDF quiz", sourceId, [section]);
  const proposed = await proctor.ok("POST", `/authoring/sessions/${authoring}/objectives:propose`);
  // One question per objective, and the mix and per-objective counts must each add up to the total.
  const objectives = (proposed.objectives ?? []) as { id: string }[];
  if (objectives.length === 0) throw new Error(`no objectives were proposed: ${JSON.stringify(proposed)}`);
  const count = objectives.length;
  const bp = await proctor.req("PUT", `/authoring/sessions/${authoring}/blueprint`, {
    testType: "chapter_quiz",
    questionCount: count,
    mix: count === 1 ? { single_choice: 1 } : { single_choice: count - 1, short_answer: 1 },
    perObjective: objectives.map((o) => ({ objectiveId: o.id, count: 1 })),
  });
  if (bp.status !== 200) throw new Error(`blueprint: ${bp.status} ${bp.text}`);
  const genStart = performance.now();
  await proctor.ok("POST", `/authoring/sessions/${authoring}/generate`);
  const settled = await until("the session to settle", async () => {
    const d = await proctor.ok("GET", `/authoring/sessions/${authoring}`);
    return d.session.status !== "generating" && d.progress.pending === 0 ? d : undefined;
  });
  const questions = settled.questions as {
    id: string;
    content: { type: string; evidence?: { chunkId: string; quote: string }[] };
    validations: { layer: string; outcome: string; issues: { code: string }[] }[];
  }[];
  const rows = [];
  for (const q of questions) {
    const l2 = q.validations.find((v) => v.layer === "L2");
    const evidence = q.content.evidence ?? [];
    const chunks = (
      await db.query(`select id, text from source_chunk where id = any($1::uuid[])`, [evidence.map((e) => e.chunkId)])
    ).rows as { id: string; text: string }[];
    rows.push({
      type: q.content.type,
      L2: l2?.outcome ?? "none",
      L2issues: l2?.issues.map((i) => i.code) ?? [],
      quoteHasMath: evidence.some((e) => e.quote.includes("$")),
      passageHasMath: chunks.some((c) => /\$[^$\n]+\$/.test(c.text)),
      quotes: evidence.map((e) => e.quote.slice(0, 160)),
    });
  }
  const fromEquations = rows.filter((r) => r.passageHasMath && r.L2 === "pass").length;
  report.authoring = {
    objectives: proposed.objectives?.length ?? 0,
    generateSeconds: round((performance.now() - genStart) / 1000),
    batches: settled.progress.batches.map((b: { status: string; errorCode: string | null }) => b.status),
    questions: rows,
    passingL2FromEquationPassages: fromEquations,
    quotingAnEquationAndPassingL2: rows.filter((r) => r.quoteHasMath && r.L2 === "pass").length,
  };
  log(`authoring: ${JSON.stringify(report.authoring)}`);
  if (fromEquations === 0) failed = true;
} catch (err) {
  failed = true;
  report.error = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
  console.error(err);
} finally {
  rmSync(work, { recursive: true, force: true });
  report.ok = !failed;
  report.totalSeconds = round((Date.now() - t0) / 1000);
  mkdirSync(join(homedir(), ".cache"), { recursive: true });
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nreport: ${REPORT}`);
  await db.end();
  process.exit(failed ? 1 : 0);
}
