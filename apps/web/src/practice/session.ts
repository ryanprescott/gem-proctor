import type { PracticeAnswer } from "@gem/shared/contracts";

/**
 * Answers typed but not yet checked live in sessionStorage, per attempt and question, so a refresh
 * restores them (P1.md §5). Checked answers are on the server.
 */
const key = (attemptId: string, questionId: number) => `gem.practice.${attemptId}.${questionId}`;

export function loadDraft(attemptId: string, questionId: number): PracticeAnswer | null {
  try {
    const raw = window.sessionStorage.getItem(key(attemptId, questionId));
    if (raw === null) return null;
    const v: unknown = JSON.parse(raw);
    if (typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string"))) return v;
  } catch {}
  return null;
}

export function saveDraft(attemptId: string, questionId: number, answer: PracticeAnswer | null) {
  try {
    if (answer === null || !hasAnswer(answer)) window.sessionStorage.removeItem(key(attemptId, questionId));
    else window.sessionStorage.setItem(key(attemptId, questionId), JSON.stringify(answer));
  } catch {}
}

export function hasAnswer(answer: PracticeAnswer | null | undefined): answer is PracticeAnswer {
  if (answer === null || answer === undefined) return false;
  return Array.isArray(answer) ? answer.length > 0 : answer.trim() !== "";
}

/**
 * Time per question (P1.md §5): counted while the question is displayed and the document is visible.
 * `cumulative()` is what the client sends; the server keeps the maximum.
 */
export class QuestionClock {
  private questionId: number | null = null;
  private base = 0;
  private since: number | null = null;

  constructor(private readonly now: () => number = () => performance.now()) {}

  start(questionId: number, base: number) {
    this.questionId = questionId;
    this.base = base;
    this.since = document.visibilityState === "visible" ? this.now() : null;
  }

  get current(): number | null {
    return this.questionId;
  }

  cumulative(): number {
    return Math.round(this.base + (this.since === null ? 0 : this.now() - this.since));
  }

  visibilityChanged(visible: boolean) {
    if (visible && this.since === null) this.since = this.now();
    if (!visible && this.since !== null) {
      this.base += this.now() - this.since;
      this.since = null;
    }
  }
}
