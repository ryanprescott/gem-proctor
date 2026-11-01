import type { DraftContent, Question, Quiz, TestType } from "@gem/shared";

/**
 * Generation schema → extended quiz schema (SPEC §3A.2): a deterministic mapper, so what the model fills in and what's
 * stored can change apart. The draft holds the model's fields and L7's results; this picks what a quiz carries.
 */

/** A draft that has reached publishing has an answer: anything else is a bug, not a state to carry on from. */
function required<T>(value: T | null | undefined, what: string, tempId: string): T {
  if (value === null || value === undefined) throw new Error(`draft ${tempId}: no ${what}`);
  return value;
}

export function toQuizQuestion(draft: DraftContent, id: number, tempId = String(id)): Question {
  const correctAnswer = required(draft.correctAnswer, "answer", tempId);
  const multiple = draft.type === "multi_choice" ? (draft.correctAnswers ?? [correctAnswer]) : undefined;
  return {
    id,
    topic: draft.topic,
    question: draft.question ?? draft.template,
    ...(draft.options ? { options: draft.options.map((o) => o.text) } : {}),
    correctAnswer: multiple ? (multiple[0] as string) : correctAnswer,
    type: draft.type,
    ...(multiple ? { correctAnswers: multiple } : {}),
    ...(draft.type === "short_answer" && draft.acceptedAnswers?.length
      ? { acceptedAnswers: draft.acceptedAnswers }
      : {}),
    ...(draft.type === "numeric" && draft.numericTolerance !== null
      ? { numericTolerance: draft.numericTolerance }
      : {}),
    ...(draft.explanation ? { explanation: draft.explanation } : {}),
    objectiveIds: draft.objectiveIds,
    evidence: draft.evidence.map((e) => ({ sourceId: e.sourceId, chunkId: e.chunkId, quote: e.quote })),
    provenance: draft.provenance,
    computable: draft.computable,
    ...(draft.verification ? { verification: draft.verification } : {}),
  };
}

export interface QuizMeta {
  title: string;
  course?: string | undefined;
  testType: TestType;
  /** The objectives in scope, in order: they become `topics_covered` (SPEC §2.3). */
  objectiveLabels: string[];
  chapter?: number | undefined;
}

/** Ids run 1..n in the order given. `total_questions` is the count, as it's recomputed everywhere else. */
export function toQuiz(drafts: { content: DraftContent; tempId: string }[], meta: QuizMeta): Quiz {
  return {
    quiz_title: meta.title,
    ...(meta.course ? { course: meta.course } : {}),
    ...(meta.chapter === undefined ? {} : { chapter: meta.chapter }),
    total_questions: drafts.length,
    topics_covered: meta.objectiveLabels,
    questions: drafts.map((d, i) => toQuizQuestion(d.content, i + 1, d.tempId)),
    testType: meta.testType,
    formatVersion: 1,
  };
}
