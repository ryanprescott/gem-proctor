import { runL7Eval } from "@gem/authoring";
import { type Db, Endpoint, LlmEvalRun, newId } from "@gem/db";
import {
  type EvalReport,
  type EvalRunOptions,
  evalPromptVersion,
  LlmError,
  type LlmRuntime,
  loadEvalSet,
  runEval,
} from "@gem/llm";
import {
  AppError,
  DEFAULT_VERIFY_SETTINGS,
  type ErrorCode,
  type EvalRunDetail,
  type EvalRunSummary,
  type EvalSummary,
  type VerifyClient,
} from "@gem/shared";
import { desc, eq } from "drizzle-orm";
import type { AppContext } from "./context.ts";

/** Eval runs (P1.5.md §5): a row per run, a pg-boss job for the work, one run at a time per role. */

/** `l7` sets need the sandbox. What they run isn't a question's check, so no `VerificationRun` rows. */
export function l7Runner(ctx: { llm: LlmRuntime; verify: VerifyClient }): EvalRunOptions["l7"] {
  return (set, opts) =>
    runL7Eval(
      {
        llm: ctx.llm,
        verify: ctx.verify,
        settings: DEFAULT_VERIFY_SETTINGS,
        recorder: { run: async () => "eval", denial: async () => {} },
      },
      set,
      opts,
    );
}

export const EVAL_QUEUE = "llm.eval";

const UNIQUE_VIOLATION = "23505";

type RunRow = typeof LlmEvalRun.$inferSelect;

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return (e.cause?.code ?? e.code) === UNIQUE_VIOLATION;
}

export async function createEvalRun(
  ctx: Pick<AppContext, "db" | "llm">,
  input: { evalSet: string; trials?: number; startedBy: string | null },
): Promise<RunRow> {
  const set = loadEvalSet(input.evalSet);
  const target = await ctx.llm.resolve(set.role);
  try {
    const [run] = await ctx.db
      .insert(LlmEvalRun)
      .values({
        id: newId(),
        evalSet: set.name,
        role: set.role,
        endpointId: target.endpoint.id,
        model: target.model,
        promptVersion: evalPromptVersion(set),
        status: "queued",
        trials: input.trials ?? set.defaultTrials,
        startedBy: input.startedBy,
      })
      .returning();
    return run as RunRow;
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError("llm_eval_running", { role: set.role });
    throw err;
  }
}

/** Runs a queued eval to the end. Never throws: every outcome is on the row. */
export async function processEvalRun(
  ctx: Pick<AppContext, "db" | "llm" | "verify">,
  runId: string,
): Promise<EvalReport | null> {
  const [run] = await ctx.db.select().from(LlmEvalRun).where(eq(LlmEvalRun.id, runId));
  if (!run) return null;
  await ctx.db.update(LlmEvalRun).set({ status: "running", startedAt: new Date() }).where(eq(LlmEvalRun.id, runId));
  try {
    const set = loadEvalSet(run.evalSet);
    const report = await runEval(ctx.llm, set, { trials: run.trials, evalRunId: run.id, l7: l7Runner(ctx) });
    await ctx.db
      .update(LlmEvalRun)
      .set({ status: "done", summary: report.summary, items: report.items, finishedAt: new Date() })
      .where(eq(LlmEvalRun.id, runId));
    return report;
  } catch (err) {
    const errorCode: ErrorCode = err instanceof LlmError ? err.code : "internal";
    await ctx.db
      .update(LlmEvalRun)
      .set({ status: "failed", errorCode, finishedAt: new Date() })
      .where(eq(LlmEvalRun.id, runId));
    return null;
  }
}

/** A run left `running` by a stopped API can't finish; single instance, so nothing else owns it (SPEC §5.3). */
async function failOrphanedRuns(db: Db) {
  await db
    .update(LlmEvalRun)
    .set({ status: "failed", errorCode: "service_unavailable", finishedAt: new Date() })
    .where(eq(LlmEvalRun.status, "running"));
}

export async function startEvalWorker(ctx: AppContext) {
  await failOrphanedRuns(ctx.db);
  await ctx.queue?.workOne<{ runId: string }>(EVAL_QUEUE, async ({ runId }) => {
    await processEvalRun(ctx, runId);
  });
}

function toSummary(row: RunRow, endpointLabel: string): EvalRunSummary {
  return {
    id: row.id,
    evalSet: row.evalSet,
    role: row.role as EvalRunSummary["role"],
    endpointId: row.endpointId,
    endpointLabel,
    model: row.model,
    promptVersion: row.promptVersion,
    status: row.status,
    trials: row.trials,
    summary: (row.summary ?? null) as EvalSummary | null,
    errorCode: (row.errorCode ?? null) as ErrorCode | null,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

const RUNS_LISTED = 100;

export async function evalRuns(ctx: Pick<AppContext, "db">, role?: string): Promise<EvalRunSummary[]> {
  const rows = await ctx.db
    .select({ run: LlmEvalRun, label: Endpoint.label })
    .from(LlmEvalRun)
    .innerJoin(Endpoint, eq(Endpoint.id, LlmEvalRun.endpointId))
    .where(role ? eq(LlmEvalRun.role, role) : undefined)
    .orderBy(desc(LlmEvalRun.createdAt), desc(LlmEvalRun.id))
    .limit(RUNS_LISTED);
  return rows.map((r) => toSummary(r.run, r.label));
}

async function loadRun(ctx: Pick<AppContext, "db">, id: string) {
  const rows = await ctx.db
    .select({ run: LlmEvalRun, label: Endpoint.label })
    .from(LlmEvalRun)
    .innerJoin(Endpoint, eq(Endpoint.id, LlmEvalRun.endpointId))
    .where(eq(LlmEvalRun.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) throw new AppError("not_found");
  return row;
}

export async function evalSummary(ctx: Pick<AppContext, "db">, id: string): Promise<EvalRunSummary> {
  const { run, label } = await loadRun(ctx, id);
  return toSummary(run, label);
}

export async function evalDetail(ctx: Pick<AppContext, "db">, id: string): Promise<EvalRunDetail> {
  const { run, label } = await loadRun(ctx, id);
  return { ...toSummary(run, label), items: (run.items ?? null) as EvalRunDetail["items"] };
}
