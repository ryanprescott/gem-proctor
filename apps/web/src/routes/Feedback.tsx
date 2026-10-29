import { effectiveType, type Question } from "@gem/shared";
import { type PracticeAttemptDetail, type PracticeResponse, practiceSelfGrade } from "@gem/shared/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Ref } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client.ts";
import { formatPoints } from "../format.ts";
import { Button, ErrorMessage, errorText } from "../ui/controls.tsx";
import { useLive } from "../ui/live.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import styles from "./Practice.module.css";

const ICON = { correct: "✓", partial: "◐", incorrect: "✗" } as const;

/** Whether "I was right" applies: a short answer that was given and graded incorrect (P1.md §5). */
export function canSelfGrade(question: Question, response: PracticeResponse): boolean {
  return (
    effectiveType(question) === "short_answer" &&
    response.autoResult === "incorrect" &&
    typeof response.answer === "string" &&
    response.answer.trim() !== ""
  );
}

/**
 * The server's grade for one answer: outcome in text and icon (not color alone), points, the correct
 * answer, the explanation, and "I was right" on an incorrect short answer (SPEC §6, §7.2).
 */
export function Feedback({
  attemptId,
  question,
  response,
  editable,
  ref,
}: {
  attemptId: string;
  question: Question;
  response: PracticeResponse;
  /** Self-grading is possible (during the attempt after the check, or on the results screen). */
  editable: boolean;
  ref?: Ref<HTMLDivElement>;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { announce } = useLive();
  const outcome = response.selfGraded ? "correct" : (response.autoResult ?? "incorrect");
  const type = effectiveType(question);
  const correctAnswers = type === "multi_choice" ? (question.correctAnswers ?? [question.correctAnswer]) : null;

  const selfGrade = useMutation({
    mutationFn: (right: boolean) =>
      api.call(practiceSelfGrade, { params: { id: attemptId, questionId: question.id }, body: { right } }),
    onSuccess: (res, right) => {
      qc.setQueryData<PracticeAttemptDetail>(["practice", "attempt", attemptId], (d) =>
        d
          ? {
              ...d,
              attempt: res.attempt,
              responses: d.responses.map((x) => (x.questionId === res.response.questionId ? res.response : x)),
            }
          : d,
      );
      void qc.invalidateQueries({ queryKey: ["practice", "history"] });
      const score =
        res.attempt.score === null
          ? ""
          : t("practice:selfGrade.score", {
              score: formatPoints(res.attempt.score),
              max: formatPoints(res.attempt.maxScore),
            });
      announce([right ? t("practice:selfGrade.marked") : t("practice:selfGrade.undone"), score].join(" ").trim());
    },
    onError: (e) => announce(errorText(t, e)),
  });

  return (
    <div ref={ref} tabIndex={-1} className={`${styles.feedback} ${styles[`feedback_${outcome}`]}`}>
      <p className={styles.outcome}>
        <span aria-hidden="true" className={styles.outcomeIcon}>
          {ICON[outcome]}
        </span>{" "}
        <strong>{t(`practice:outcome.${outcome}`)}</strong>{" "}
        <span>
          {t("practice:feedback.points", {
            points: formatPoints(response.pointsAwarded),
            max: formatPoints(response.maxPoints),
          })}
        </span>
      </p>
      {response.selfGraded ? <p className={styles.selfGraded}>{t("practice:feedback.selfGraded")}</p> : null}
      {correctAnswers ? (
        <div>
          <p className={styles.feedbackLabel}>{t("practice:feedback.correctAnswers")}</p>
          <ul>
            {correctAnswers.map((a) => (
              <li key={a}>
                <Markdown inline>{a}</Markdown>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p>
          <span className={styles.feedbackLabel}>{t("practice:feedback.correctAnswer")}</span>{" "}
          <Markdown inline>{question.correctAnswer}</Markdown>
        </p>
      )}
      {question.explanation ? (
        <div>
          <p className={styles.feedbackLabel}>{t("practice:feedback.explanation")}</p>
          <Markdown>{question.explanation}</Markdown>
        </div>
      ) : null}
      {editable && canSelfGrade(question, response) ? (
        <div className={styles.selfGradeRow}>
          {response.selfGraded ? (
            <Button variant="secondary" onPress={() => selfGrade.mutate(false)} isDisabled={selfGrade.isPending}>
              {t("practice:selfGrade.undo")}
            </Button>
          ) : (
            <Button variant="secondary" onPress={() => selfGrade.mutate(true)} isDisabled={selfGrade.isPending}>
              {t("practice:selfGrade.right")}
            </Button>
          )}
          <ErrorMessage error={selfGrade.error} />
        </div>
      ) : null}
    </div>
  );
}
