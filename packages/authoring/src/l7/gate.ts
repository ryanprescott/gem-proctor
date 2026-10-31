import type { ProctorBlocker, Question } from "@gem/shared";

/**
 * The proctored publish gate (SPEC §3A.3.1, §13 Q12). Assignments arrive in P3, which calls this on creation; until
 * then it's `proctorReady` and `blockers` on the version. A computable question must be `computed`. So must one
 * nobody has classified: with no `verification` it's counted as not verified, whatever the file says.
 */
export function checkProctorReady(
  content: { questions: readonly Pick<Question, "id" | "computable" | "verification">[] },
  gate = true,
): { proctorReady: boolean; blockers: ProctorBlocker[] } {
  if (!gate) return { proctorReady: true, blockers: [] };
  const blockers: ProctorBlocker[] = [];
  for (const q of content.questions) {
    const status = q.verification?.status;
    if (status === "computed") continue;
    if (status === undefined) {
      blockers.push({ questionId: q.id, reason: "not_verified" });
    } else if (q.computable) {
      blockers.push({ questionId: q.id, reason: status });
    }
  }
  return { proctorReady: blockers.length === 0, blockers };
}
