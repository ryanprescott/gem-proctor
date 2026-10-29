import { practiceGet } from "@gem/shared/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link, Navigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api } from "../api/client.ts";
import { RequireRole } from "../auth.tsx";
import { formatDuration, formatPercent, formatPoints } from "../format.ts";
import { ErrorMessage } from "../ui/controls.tsx";
import { useDocumentTitle } from "../ui/live.tsx";
import { practiceKey } from "./Attempt.tsx";
import styles from "./Practice.module.css";

function Results({ attemptId }: { attemptId: string }) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: practiceKey(attemptId),
    queryFn: () => api.call(practiceGet, { params: { id: attemptId } }),
  });
  const detail = query.data;
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
  return (
    <>
      <h1>{t("practice:results.heading", { title: detail.quiz.title })}</h1>
      <dl className={styles.summary}>
        <dt>{t("practice:results.score")}</dt>
        <dd>
          {t("practice:results.scoreValue", {
            score: formatPoints(score),
            max: formatPoints(attempt.maxScore),
            percent: formatPercent(percent),
          })}
        </dd>
        <dt>{t("practice:results.time")}</dt>
        <dd>{formatDuration(attempt.durationMs ?? 0)}</dd>
      </dl>
      <p>
        <Link to="/tests/$testId" params={{ testId: attempt.testId }}>
          {t("practice:results.backToTest")}
        </Link>
      </p>
    </>
  );
}

export function ResultsPage({ attemptId }: { attemptId: string }) {
  return <RequireRole minRole="proctor">{() => <Results attemptId={attemptId} />}</RequireRole>;
}
