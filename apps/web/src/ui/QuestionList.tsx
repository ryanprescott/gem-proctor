import { effectiveType, type VerificationStatus } from "@gem/shared";
import { useTranslation } from "react-i18next";
import { uniqueKeys } from "./keys.ts";
import { Markdown } from "./Markdown.tsx";
import styles from "./QuestionList.module.css";

export interface DisplayQuestion {
  id: number;
  topic?: string;
  question: string;
  options?: string[];
  correctAnswer?: string;
  type?: string;
  explanation?: string;
  computable?: boolean;
  verification?: { status: VerificationStatus };
}

/** Read-only question list: Markdown + KaTeX (with MathML). The answer is labelled in text, not by color alone. */
export function QuestionList({
  questions,
  showAnswers = true,
}: {
  questions: DisplayQuestion[];
  showAnswers?: boolean;
}) {
  const { t } = useTranslation();
  const keys = uniqueKeys(questions.map((q) => `${q.id}:${q.question}`));
  return (
    <ol className={styles.list}>
      {questions.map((q, i) => {
        const type = effectiveType({ type: q.type as never, options: q.options });
        return (
          <li key={keys[i]} className={styles.question}>
            <h3 className={styles.heading}>
              {t("tests:question.heading", { id: q.id })}
              {q.topic ? <span className={styles.topic}>{t("tests:question.topic", { topic: q.topic })}</span> : null}
            </h3>
            <p className={styles.type}>{t(`tests:types.${type}`)}</p>
            {q.verification ? (
              <p className={styles.type}>
                {t("tests:verification.label")} {t(`tests:verification.status.${q.verification.status}`)}
              </p>
            ) : null}
            <div className={styles.text}>
              <Markdown>{q.question}</Markdown>
            </div>
            {q.options ? (
              <ul className={styles.options} aria-label={t("tests:question.options", { id: q.id })}>
                {uniqueKeys(q.options).map((key, j) => {
                  const o = q.options?.[j] ?? "";
                  const correct = showAnswers && o === q.correctAnswer;
                  return (
                    <li key={key} className={correct ? styles.correct : styles.option}>
                      <Markdown inline>{o}</Markdown>
                      {correct ? <strong className={styles.badge}>{t("tests:question.correct")}</strong> : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {showAnswers && q.correctAnswer !== undefined && !q.options?.includes(q.correctAnswer) ? (
              <p className={q.options ? styles.mismatch : styles.answer}>
                <strong>{t(q.options ? "tests:question.answerNotInOptions" : "tests:question.answer")}</strong>{" "}
                <Markdown inline>{q.correctAnswer}</Markdown>
              </p>
            ) : null}
            {q.explanation ? (
              <div className={styles.explanation}>
                <Markdown>{q.explanation}</Markdown>
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
