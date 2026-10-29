import { readFileSync } from "node:fs";
import { join } from "node:path";

export const FIXTURE_PATH = join(import.meta.dir, "..", "..", "..", "tests", "engr108_chapter1_new_20q_quiz.json");
export const fixtureText = (): string => readFileSync(FIXTURE_PATH, "utf8");
export const fixture = (): Record<string, unknown> & { questions: Record<string, unknown>[] } =>
  JSON.parse(fixtureText());

/** The fixture with Q7's answer corrected to "-1" (SPEC §2.4). */
export function fixedFixture() {
  const f = fixture();
  const q7 = f.questions.find((q) => q.id === 7);
  if (!q7) throw new Error("fixture has no Q7");
  q7.correctAnswer = "-1";
  return f;
}
