import type { RunRecorder, RunRef } from "@gem/authoring";
import { type Db, newId, VerificationRun } from "@gem/db";
import { writeAudit } from "./audit.ts";

/** L7's record: one `VerificationRun` per program run; a denial also goes to the audit log (P2.1.md §5). */
export function dbRecorder(db: Db): RunRecorder {
  return {
    async run(record) {
      const id = newId();
      await db.insert(VerificationRun).values({
        id,
        jobId: record.jobId ?? null,
        testVersionId: record.testVersionId ?? null,
        questionId: record.questionId,
        programKind: record.programKind,
        program: record.program,
        status: record.status,
        result: record.result,
        matchedOption: record.matchedOption,
        durationMs: record.durationMs,
        sandboxVersion: record.sandboxVersion,
      });
      return id;
    },
    /** No actor: the sandbox noticed it. The row holds the run's id, never the program. */
    async denial(ref: RunRef, runId: string) {
      await writeAudit(db, {
        actorId: null,
        action: "verify.sandbox_denial",
        targetType: ref.jobId ? "verification_job" : "question",
        targetId: ref.jobId ?? ref.draftQuestionId ?? String(ref.questionId),
        after: { runId, questionId: ref.questionId },
      });
    },
  };
}
