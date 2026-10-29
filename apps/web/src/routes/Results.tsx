import { effectiveType, type Question, topicBreakdown } from "@gem/shared";
import { type PracticeResponse, practiceExport, practiceGet, practiceList } from "@gem/shared/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link, Navigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api, contractUrl } from "../api/client.ts";
import { RequireRole } from "../auth.tsx";
import { formatDateTime, formatDuration, formatNumber, formatPercent, formatPoints } from "../format.ts";
import { historyKey, useStartAttempt } from "../practice/useStartAttempt.ts";
import { Button, Card, ErrorMessage } from "../ui/controls.tsx";
import { useDocumentTitle } from "../ui/live.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import { practiceKey } from "./Attempt.tsx";
import { Feedback } from "./Feedback.tsx";
import styles from "./Practice.module.css";
import { RetakeMissedButton } from "./PracticeSection.tsx";

function YourAnswer({ question, response }: { question: Question; response: PracticeResponse }) {
  const { t } = useTranslation();
  const answer = response.answer;
  const given = Array.isArray(answer) ? answer : answer && answer.trim() !== "" ? [answer] : [];
  if (given.length === 0) {
    return (
      <p>
        <span className={styles.feedbackLabel}>{t("practice:review.yourAnswer")}</span>{" "}
        {t("practice:review.notAnswered")}
      </p>
    );
  }
  if (effectiveType(question) === "multi_choice") {
    return (
      <div>
        <p className={styles.feedbackLabel}>{t("practice:review.yourAnswers")}</p>
        <ul>
          {given.map((a) => (
            <li key={a}>
              <Markdown inline>{a}</Markdown>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <p>
      <span className={styles.feedbackLabel}>{t("practice:review.yourAnswer")}</span>{" "}
      <Markdown inline>{given[0] ?? ""}</Markdown>
    </p>
  );
}

function Results({ attemptId }: { attemptId: string }) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: practiceKey(attemptId),
    queryFn: () => api.call(practiceGet, { params: { id: attemptId } }),
  });
  const detail = query.data;
  const testId = detail?.attempt.testId ?? "";
  const history = useQuery({
    queryKey: historyKey(testId),
    queryFn: () => api.call(practiceList, { query: { testId } }),
    enabled: testId !== "",
  });
  const start = useStartAttempt(testId);
  useDocumentTitle(
    detail ? t("practice:results.documentTitle", { title: detail.quiz.title }) : t("practice:results.title"),
  );
  if (query.isPending) return <p>{t("common:loading")}</p>;
  if (query.error || !detail) return <ErrorMessage error={query.error} />;
  const { attempt } = detail;
  if (attempt.status !== "submitted") {
    return <Navigate to="/practice/attempts/$attemptId" params={{ attemptId }} />;
  }

  const score = attempt.score ?? 0;
  const percent = attempt.maxScore === 0 ? 0 : (score / attempt.maxScore) * 100;
  // The review and the breakdown follow the test's own order, like the export.
  const byId = new Map(detail.questions.map((q) => [q.id, q]));
  const questions = detail.quizOrder.map((id) => byId.get(id)).filter((q): q is Question => !!q);
  const responses = new Map(detail.responses.map((r) => [r.questionId, r]));
  const topics = topicBreakdown(questions, new Map(detail.responses.map((r) => [r.questionId, r.pointsAwarded])));

  return (
    <>
      <h1>{t("practice:results.heading", { title: detail.quiz.title })}</h1>
      <dl className={styles.summary}>
        <dt>{t("practice:results.score")}</dt>
        <dd data-testid="results-score">
          {t("practice:results.scoreValue", {
            score: formatPoints(score),
            max: formatPoints(attempt.maxScore),
            percent: formatPercent(percent),
          })}
        </dd>
        <dt>{t("practice:results.time")}</dt>
        <dd>{formatDuration(attempt.durationMs ?? 0)}</dd>
        <dt>{t("practice:results.kind")}</dt>
        <dd>{t(`practice:kind.${attempt.kind}`)}</dd>
        <dt>{t("practice:results.submitted")}</dt>
        <dd>{formatDateTime(attempt.submittedAt)}</dd>
      </dl>

      <div className={styles.sectionActions}>
        <Button onPress={() => start.mutate("full")} isDisabled={start.isPending}>
          {t("practice:retake.full")}
        </Button>
        <RetakeMissedButton testId={testId} missedCount={history.data?.missedCount} />
        <a className={styles.linkButton} href={contractUrl(practiceExport, { params: { id: attemptId } })} download>
          {t("practice:results.export")}
        </a>
      </div>
      <ErrorMessage error={start.error} />
      <p>
        <Link to="/tests/$testId" params={{ testId }}>
          {t("practice:results.backToTest")}
        </Link>
      </p>

      <Card title={t("practice:topics.title")}>
        {detail.quiz.topicsCovered.length > 0 ? (
          <>
            <p className={styles.feedbackLabel}>{t("practice:topics.covered")}</p>
            <ul>
              {detail.quiz.topicsCovered.map((topic) => (
                <li key={topic}>{topic}</li>
              ))}
            </ul>
          </>
        ) : null}
        <div className={styles.tableWrap}>
          <table>
            <caption className={styles.caption}>{t("practice:topics.caption")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("practice:topics.colTopic")}</th>
                <th scope="col">{t("practice:topics.colCorrect")}</th>
                <th scope="col">{t("practice:topics.colPoints")}</th>
              </tr>
            </thead>
            <tbody>
              {topics.map((row) => (
                <tr key={row.topic}>
                  <th scope="row">{row.topic}</th>
                  <td>
                    {t("practice:topics.correctValue", {
                      correct: formatNumber(row.correct),
                      total: formatNumber(row.total),
                    })}
                  </td>
                  <td>
                    {t("practice:topics.pointsValue", {
                      points: formatPoints(row.points),
                      max: formatPoints(row.maxPoints),
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <h2>{t("practice:review.title")}</h2>
      <ol className={styles.review}>
        {questions.map((q, i) => {
          const r = responses.get(q.id);
          if (!r) return null;
          const quotes = (q.evidence ?? []).map((e) => e.quote).filter((x) => x.trim() !== "");
          return (
            <li key={q.id} className={styles.questionCard}>
              <h3 className={styles.questionHeading}>
                {t("practice:review.heading", { n: formatNumber(i + 1), total: formatNumber(questions.length) })}
              </h3>
              <p className={styles.questionMeta}>
                {t("practice:attempt.meta", { topic: q.topic, type: t(`tests:types.${effectiveType(q)}`) })}
              </p>
              <div className={styles.prompt}>
                <Markdown>{q.question}</Markdown>
              </div>
              <YourAnswer question={q} response={r} />
              <Feedback attemptId={attemptId} question={q} response={r} editable />
              {quotes.length > 0 ? (
                <div>
                  <p className={styles.feedbackLabel}>{t("practice:review.evidence")}</p>
                  {quotes.map((quote) => (
                    <blockquote key={quote} className={styles.quote}>
                      <Markdown>{quote}</Markdown>
                    </blockquote>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </>
  );
}

export function ResultsPage({ attemptId }: { attemptId: string }) {
  return <RequireRole minRole="proctor">{() => <Results attemptId={attemptId} />}</RequireRole>;
}
