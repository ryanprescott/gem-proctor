import { checkForm, longestAlwaysCorrect } from "@gem/authoring";
import { type Db, DraftQuestion, newId, QuestionEvent, Revision, SourceChunk, ValidationResult } from "@gem/db";
import {
  AppError,
  type DraftContent,
  type DraftStatus,
  type LayerResult,
  layerResult,
  type QuestionEventKind,
  type ValidationLayer,
} from "@gem/shared";
import type { DraftView } from "@gem/shared/contracts";
import { asc, desc, eq, inArray } from "drizzle-orm";
import type { AppContext } from "../context.ts";

/** Draft questions: reading them, their events and their validation results (SPEC §3A.3, §10). */

export type DraftRow = typeof DraftQuestion.$inferSelect;
type Writer = Pick<Db, "insert">;

export const contentOf = (row: DraftRow) => row.content as DraftContent;

export async function loadDraft(ctx: Pick<AppContext, "db">, id: string): Promise<DraftRow> {
  const [row] = await ctx.db.select().from(DraftQuestion).where(eq(DraftQuestion.id, id));
  if (!row) throw new AppError("authoring_question_not_found");
  return row;
}

export async function addEvent(
  db: Writer,
  event: {
    draftQuestionId: string;
    kind: QuestionEventKind;
    actorId?: string | null;
    revisionId?: string | null;
    before?: unknown;
    after?: unknown;
    note?: string | null;
  },
) {
  await db.insert(QuestionEvent).values({
    id: newId(),
    draftQuestionId: event.draftQuestionId,
    kind: event.kind,
    actorId: event.actorId ?? null,
    revisionId: event.revisionId ?? null,
    before: event.before ?? null,
    after: event.after ?? null,
    note: event.note ?? null,
  });
}

/** Results are appended, per question per revision, so the creator can see what changed between rounds. */
export async function recordResults(db: Writer, draftId: string, revisionId: string | null, results: LayerResult[]) {
  for (const r of results) {
    await db.insert(ValidationResult).values({
      id: newId(),
      draftQuestionId: draftId,
      revisionId,
      layer: r.layer,
      outcome: r.outcome,
      detail: { issues: r.issues, ...(r.reason ? { reason: r.reason } : {}) },
    });
  }
}

interface StoredDetail {
  issues: LayerResult["issues"];
  reason?: LayerResult["reason"];
}

const ORDER: ValidationLayer[] = ["L1", "L2", "L3", "L7"];

/** The newest result per layer, for each question. */
export async function latestResults(db: Pick<Db, "select">, ids: string[]): Promise<Map<string, LayerResult[]>> {
  const out = new Map<string, LayerResult[]>();
  if (ids.length === 0) return out;
  const rows = await db
    .select()
    .from(ValidationResult)
    .where(inArray(ValidationResult.draftQuestionId, ids))
    .orderBy(desc(ValidationResult.at), desc(ValidationResult.id));
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.draftQuestionId}:${r.layer}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const detail = r.detail as StoredDetail;
    const list = out.get(r.draftQuestionId) ?? [];
    list.push({
      layer: r.layer,
      outcome: r.outcome,
      issues: detail.issues,
      ...(detail.reason ? { reason: detail.reason } : {}),
    });
    out.set(r.draftQuestionId, list);
  }
  for (const list of out.values()) list.sort((a, b) => ORDER.indexOf(a.layer) - ORDER.indexOf(b.layer));
  return out;
}

/** The accept rule (P2.md §5). L7 still running counts: its result could be a fail. */
export function isBlocked(content: DraftContent, results: LayerResult[]): boolean {
  if (content.l7Pending) return true;
  if (results.some((r) => r.outcome === "fail")) return true;
  return content.correctAnswer === null;
}

/** The current questions: a regenerated one's new version stands for it, and the old one is in its history. */
export async function currentDrafts(ctx: Pick<AppContext, "db">, sessionId: string): Promise<DraftRow[]> {
  const rows = await ctx.db
    .select()
    .from(DraftQuestion)
    .where(eq(DraftQuestion.sessionId, sessionId))
    .orderBy(asc(DraftQuestion.position));
  const superseded = new Set(rows.flatMap((r) => (r.supersedesId ? [r.supersedesId] : [])));
  return rows.filter((r) => !superseded.has(r.id));
}

export async function draftViews(ctx: Pick<AppContext, "db">, rows: DraftRow[]): Promise<DraftView[]> {
  const results = await latestResults(
    ctx.db,
    rows.map((r) => r.id),
  );
  const revisions = await ctx.db
    .select({ id: Revision.id, number: Revision.number })
    .from(Revision)
    .where(
      inArray(
        Revision.id,
        rows.length > 0 ? [...new Set(rows.map((r) => r.revisionId))] : ["00000000-0000-0000-0000-000000000000"],
      ),
    );
  const numbers = new Map(revisions.map((r) => [r.id, r.number]));
  return rows.map((r) => {
    const validations = results.get(r.id) ?? [];
    return {
      id: r.id,
      revision: numbers.get(r.revisionId) ?? 0,
      position: r.position,
      tempId: r.tempId,
      status: r.status as DraftStatus,
      content: contentOf(r),
      validations,
      blocked: isBlocked(contentOf(r), validations),
      creatorNote: r.creatorNote,
      supersedesId: r.supersedesId,
      editedAt: r.editedAt?.toISOString() ?? null,
    };
  });
}

/** The cited chunks' text, by chunk id: L2's reference, and what a blind program reads. */
export async function chunkTexts(ctx: Pick<AppContext, "db">, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await ctx.db
    .select({ id: SourceChunk.id, text: SourceChunk.text })
    .from(SourceChunk)
    .where(inArray(SourceChunk.id, ids));
  return new Map(rows.map((r) => [r.id, r.text]));
}

/** L3 on the text a student sees. `longest` says the set-wide check named this question. */
export function formResult(content: DraftContent, passages: string[], longest: boolean): LayerResult {
  const result = checkForm({
    question: content.question ?? content.template,
    options: content.options,
    correctAnswer: content.correctAnswer,
    explanation: content.explanation,
    passages,
    computable: content.computable,
  });
  return longest
    ? layerResult("L3", [...result.issues, { code: "longest_always_correct", severity: "warn", params: {} }])
    : result;
}

export const longestIds = (rows: DraftRow[]) =>
  new Set(
    longestAlwaysCorrect(
      rows.map((r) => ({ id: r.id, options: contentOf(r).options, computable: contentOf(r).computable })),
    ),
  );
