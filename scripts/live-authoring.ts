// bun run live:authoring [--keep]: P2.md E52. The whole authoring journey against the reference model server in
// LLM_DEV_*: a source from the repo goes in, objectives are proposed, a chapter quiz is generated, checked by L1 to L3 and
// L7, revised once for what failed, published, and taken in practice. It runs on a throwaway database with the real
// pg-boss workers and a local sandbox parent, so it is for a trusted dev model only (the sandbox is not isolated here).
// Pass rates, seconds per question and failures are printed and written to ~/.cache/live-authoring-report.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RoleAssignment } from "@gem/db";
import { adminUrl, startLocalPg } from "./pg-local.ts";

const ROOT = join(import.meta.dir, "..");
if (!process.env.TEST_PG_ADMIN_URL) {
  await startLocalPg();
  process.env.TEST_PG_ADMIN_URL = adminUrl();
}
process.env.REQUIRE_DB_TESTS = "1";

// The test helpers read the database URL when they load.
const { createSourceEnv } = await import("../apps/api/test/authoring-helpers.ts");
const { API } = await import("../apps/api/test/helpers.ts");
const { loadConfig } = await import("../apps/api/src/config.ts");
const { seedDevLlm } = await import("../apps/api/src/llm-seed.ts");

const FIXTURE = join(ROOT, "packages", "authoring", "test", "fixtures", "linear-algebra.md");
const REPORT = join(homedir(), ".cache", "live-authoring-report.json");
const QUESTIONS = 10;

const env = await createSourceEnv();
const dev = loadConfig(process.env, process.env.ENV_FILE ?? join(ROOT, ".env"));
if (!dev.LLM_DEV_BASE_URL) throw new Error("LLM_DEV_* is not set: nothing to run against");
// The mock the environment started is replaced by the real server, for every role the dev seed assigns.
await env.t.db.delete(RoleAssignment);
await seedDevLlm(
  { config: { ...dev, ENDPOINT_SECRET_KEY: env.t.ctx.config.ENDPOINT_SECRET_KEY }, db: env.t.db },
  console.log,
);

const t0 = Date.now();
const seconds = () => Number(((Date.now() - t0) / 1000).toFixed(1));
const log = (line: string) => console.log(`[${seconds()}s] ${line}`);
const report: Record<string, unknown> = {
  model: dev.LLM_DEV_MODEL,
  embed: dev.LLM_DEV_EMBED_MODEL,
  started: new Date().toISOString(),
};

type Detail = {
  session: { id: string; status: string };
  objectives: { id: string; label: string }[];
  blueprint: { questionCount: number } | null;
  progress: {
    batches: { status: string; errorCode: string | null; written: number; size: number; failedItems: unknown[] }[];
    pending: number;
  };
  questions: {
    id: string;
    status: string;
    blocked: boolean;
    content: {
      type: string;
      computable: boolean;
      correctAnswer: string | null;
      options: { text: string; isCorrect: boolean }[] | null;
    };
    validations: { layer: string; outcome: string; issues: { code: string }[]; reason?: string }[];
  }[];
};

async function until<T>(what: string, read: () => Promise<T | undefined>, ms = 30 * 60_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== undefined) return v;
    await Bun.sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const detail = async (id: string) => (await env.proctor.get(`${API}/authoring/sessions/${id}`)).json() as Detail;
const settled = (id: string) =>
  until("the session to settle", async () => {
    const d = await detail(id);
    return d.session.status !== "generating" && d.progress.pending === 0 ? d : undefined;
  });

try {
  // 1. The source.
  const added = await env.proctor.post(`${API}/sources`, {
    title: "Vectors and matrices",
    citationLabel: "LA",
    text: readFileSync(FIXTURE, "utf8"),
  });
  const sourceId = added.json().source.id as string;
  const ingestStart = Date.now();
  await until("the source to embed", async () => {
    const s = (await env.proctor.get(`${API}/sources/${sourceId}`)).json().source.latest;
    if (s.embedStatus === "failed") throw new Error(`embedding failed: ${JSON.stringify(s.embedError)}`);
    return s.embedStatus === "ready" ? s : undefined;
  });
  report.ingestSeconds = Number(((Date.now() - ingestStart) / 1000).toFixed(1));
  log(`source ready (${report.ingestSeconds}s)`);

  // 2. The session and its objectives.
  const created = (
    await env.proctor.post(`${API}/authoring/sessions`, {
      title: "Live chapter quiz",
      testType: "chapter_quiz",
      sources: [{ sourceId }],
    })
  ).json() as Detail;
  const id = created.session.id;
  const proposeStart = Date.now();
  const proposed = (await env.proctor.post(`${API}/authoring/sessions/${id}/objectives:propose`)).json();
  report.objectives = {
    seconds: Number(((Date.now() - proposeStart) / 1000).toFixed(1)),
    count: proposed.objectives?.length,
    rejectedCitations: proposed.rejected,
    failedSections: proposed.failedSections,
    notice: proposed.notice,
    labels: (proposed.objectives ?? []).map((o: { label: string }) => o.label),
  };
  log(`objectives: ${JSON.stringify(report.objectives)}`);

  // 3. The blueprint: the test type's defaults, for as many questions as the preset gives.
  const bp = await env.proctor.put(`${API}/authoring/sessions/${id}/blueprint`, { testType: "chapter_quiz" });
  if (bp.statusCode !== 200) throw new Error(`blueprint: ${bp.body}`);
  report.blueprint = bp.json().blueprint;

  // 4. Generation, with L1 to L3 on arrival and L7 after.
  const genStart = Date.now();
  const gen = await env.proctor.post(`${API}/authoring/sessions/${id}/generate`);
  if (gen.statusCode !== 200) throw new Error(`generate: ${gen.body}`);
  let d = await settled(id);
  const genSeconds = (Date.now() - genStart) / 1000;
  log(
    `generated ${d.questions.length} questions in ${genSeconds.toFixed(0)}s; batches ${JSON.stringify(d.progress.batches.map((b) => `${b.status}${b.errorCode ? `:${b.errorCode}` : ""} ${b.written}/${b.size}`))}`,
  );

  const rates = (list: Detail["questions"]) => {
    const layer = (name: string) => {
      const rows = list.map((q) => q.validations.find((v) => v.layer === name)).filter((v) => v !== undefined);
      return {
        checked: rows.length,
        pass: rows.filter((v) => v.outcome === "pass").length,
        warn: rows.filter((v) => v.outcome === "warn").length,
        fail: rows.filter((v) => v.outcome === "fail").length,
        failCodes: Object.entries(
          rows
            .filter((v) => v.outcome === "fail")
            .flatMap((v) => (v.issues.length > 0 ? v.issues.map((i) => i.code) : [v.reason ?? "?"]))
            .reduce<Record<string, number>>((m, c) => ({ ...m, [c]: (m[c] ?? 0) + 1 }), {}),
        ),
      };
    };
    return { L1: layer("L1"), L2: layer("L2"), L3: layer("L3"), L7: layer("L7") };
  };
  report.firstRound = {
    questions: d.questions.length,
    secondsTotal: Number(genSeconds.toFixed(1)),
    secondsPerQuestion: d.questions.length === 0 ? null : Number((genSeconds / d.questions.length).toFixed(1)),
    types: d.questions.reduce<Record<string, number>>(
      (m, q) => ({ ...m, [q.content.type]: (m[q.content.type] ?? 0) + 1 }),
      {},
    ),
    computable: d.questions.filter((q) => q.content.computable).length,
    batches: d.progress.batches.map((b) => ({
      status: b.status,
      errorCode: b.errorCode,
      written: b.written,
      size: b.size,
      dropped: b.failedItems.length,
    })),
    layers: rates(d.questions),
    blocked: d.questions.filter((q) => q.blocked).length,
  };

  // 5. One revise round for what is blocked, then accept what can be.
  const blocked = d.questions.filter((q) => q.blocked);
  if (blocked.length > 0 && d.session.status === "review") {
    const reviseStart = Date.now();
    const res = await env.proctor.post(`${API}/authoring/sessions/${id}/revise`, {
      questions: blocked.map((q) => ({ id: q.id, note: "fix the failed checks" })),
    });
    if (res.statusCode === 200) {
      d = await settled(id);
      report.reviseRound = {
        sent: blocked.length,
        seconds: Number(((Date.now() - reviseStart) / 1000).toFixed(1)),
        stillBlocked: d.questions.filter((q) => q.blocked).length,
      };
      log(`revise: ${JSON.stringify(report.reviseRound)}`);
    }
  }
  for (const q of d.questions) {
    if (!q.blocked) await env.proctor.patch(`${API}/authoring/questions/${q.id}`, { status: "accepted" });
  }
  d = await detail(id);
  const accepted = d.questions.filter((q) => q.status === "accepted");
  report.final = {
    questions: d.questions.length,
    accepted: accepted.length,
    layers: rates(d.questions),
    reachedTarget: accepted.length >= QUESTIONS,
  };
  log(`accepted ${accepted.length} of ${d.questions.length}`);

  // 6. Publish, and take it in practice.
  const pub = await env.proctor.post(`${API}/authoring/sessions/${id}/publish`, { title: "Live chapter quiz" });
  if (pub.statusCode !== 200) throw new Error(`publish: ${pub.statusCode} ${pub.body}`);
  const { testId, versionId, proctorReady } = pub.json();
  report.published = { testId, versionId, proctorReady, questions: accepted.length };
  const start = await env.proctor.post(`${API}/practice/attempts`, { testId, kind: "full" });
  const attemptId = start.json().attempt.id as string;
  const attempt = (await env.proctor.get(`${API}/practice/attempts/${attemptId}`)).json();
  // Answer each question with the key the test carries: the score says the published test is graded as it was written.
  let answered = 0;
  for (const q of attempt.questions as {
    id: number;
    correctAnswer: string;
    correctAnswers?: string[];
    type?: string;
  }[]) {
    const answer = q.type === "multi_choice" ? (q.correctAnswers ?? [q.correctAnswer]) : q.correctAnswer;
    const put = await env.proctor.put(`${API}/practice/attempts/${attemptId}/responses/${q.id}`, { answer });
    if (put.statusCode === 200) answered += 1;
  }
  const submit = await env.proctor.post(`${API}/practice/attempts/${attemptId}/submit`);
  const result = submit.json().attempt as { score: number | null; maxScore: number };
  const exported = JSON.parse((await env.proctor.get(`${API}/practice/attempts/${attemptId}/export`)).body);
  report.practice = {
    submitStatus: submit.statusCode,
    questions: exported.questions?.length,
    answered,
    score: result.score,
    maxScore: result.maxScore,
  };
  log(`practice: ${answered} answered with the key, score ${result.score} of ${result.maxScore}`);
  report.totalSeconds = seconds();
  report.ok = true;
} catch (err) {
  report.ok = false;
  report.error = String(err);
  console.error(err);
} finally {
  mkdirSync(join(homedir(), ".cache"), { recursive: true });
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nreport: ${REPORT}\n${JSON.stringify(report, null, 2)}`);
  if (!process.argv.includes("--keep")) await env.close();
  process.exit(report.ok ? 0 : 1);
}
