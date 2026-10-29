import { type PracticeAttemptSummary, practiceDiscard, practiceList } from "@gem/shared/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client.ts";
import { formatDateTime, formatDuration, formatNumber, formatPercent, formatPoints } from "../format.ts";
import { historyKey, useStartAttempt } from "../practice/useStartAttempt.ts";
import { ConfirmDialog } from "../ui/ConfirmDialog.tsx";
import { Button, Card, ErrorMessage, errorText } from "../ui/controls.tsx";
import { useLive } from "../ui/live.tsx";
import styles from "./Practice.module.css";

export function scoreText(t: (k: string, o?: Record<string, unknown>) => string, a: PracticeAttemptSummary): string {
  if (a.score === null) return t("practice:history.inProgress");
  return t("practice:history.scoreValue", {
    score: formatPoints(a.score),
    max: formatPoints(a.maxScore),
    percent: formatPercent(a.maxScore === 0 ? 0 : (a.score / a.maxScore) * 100),
  });
}

/** Retake missed: enabled only when the most recent submitted attempt missed something (P1.md §5). */
export function RetakeMissedButton({
  testId,
  missedCount,
  isDisabled,
}: {
  testId: string;
  missedCount: number | null | undefined;
  isDisabled?: boolean;
}) {
  const { t } = useTranslation();
  const start = useStartAttempt(testId);
  const none = !missedCount;
  return (
    <>
      <Button
        variant="secondary"
        onPress={() => start.mutate("retake_missed")}
        isDisabled={none || isDisabled || start.isPending}
      >
        {missedCount
          ? t("practice:retake.missed", { count: missedCount, n: formatNumber(missedCount) })
          : t("practice:retake.missedNone")}
      </Button>
      <ErrorMessage error={start.error} />
    </>
  );
}

function HistoryTable({ attempts }: { attempts: PracticeAttemptSummary[] }) {
  const { t } = useTranslation();
  return (
    <div className={styles.tableWrap}>
      <table>
        <caption className={styles.caption}>{t("practice:history.caption", { count: attempts.length })}</caption>
        <thead>
          <tr>
            <th scope="col">{t("practice:history.colDate")}</th>
            <th scope="col">{t("practice:history.colKind")}</th>
            <th scope="col">{t("practice:history.colScore")}</th>
            <th scope="col">{t("practice:history.colDuration")}</th>
            <th scope="col">{t("practice:history.colActions")}</th>
          </tr>
        </thead>
        <tbody>
          {attempts.map((a) => (
            <tr key={a.id}>
              <td>{formatDateTime(a.startedAt)}</td>
              <td>
                {t(`practice:kind.${a.kind}`)}
                {a.kind === "retake_missed"
                  ? ` ${t("practice:history.questionCount", { count: a.questionCount, n: formatNumber(a.questionCount) })}`
                  : ""}
              </td>
              <td>{scoreText(t, a)}</td>
              <td>{a.durationMs === null ? "—" : formatDuration(a.durationMs)}</td>
              <td>
                {a.status === "submitted" ? (
                  <Link to="/practice/attempts/$attemptId/results" params={{ attemptId: a.id }}>
                    {t("practice:history.viewResults", { date: formatDateTime(a.startedAt) })}
                  </Link>
                ) : (
                  <Link to="/practice/attempts/$attemptId" params={{ attemptId: a.id }}>
                    {t("practice:history.resume", { date: formatDateTime(a.startedAt) })}
                  </Link>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The test detail page's Practice section (P1.md §6): take, retake missed, resume / discard, history. */
export function PracticeSection({ testId, archived }: { testId: string; archived: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { announce } = useLive();
  const [discardOpen, setDiscardOpen] = useState(false);
  const history = useQuery({
    queryKey: historyKey(testId),
    queryFn: () => api.call(practiceList, { query: { testId } }),
  });
  const start = useStartAttempt(testId);
  const inProgress = history.data?.attempts.find((a) => a.status === "in_progress");

  const discard = useMutation({
    mutationFn: (id: string) => api.call(practiceDiscard, { params: { id } }),
    onSuccess: async () => {
      setDiscardOpen(false);
      start.reset();
      await qc.invalidateQueries({ queryKey: ["practice"] });
      announce(t("practice:section.discarded"));
    },
    onError: (e) => announce(errorText(t, e)),
  });

  return (
    <Card title={t("practice:section.title")}>
      {archived ? <p>{t("practice:section.archived")}</p> : null}
      <ErrorMessage error={history.error} />
      {inProgress ? (
        <div className={styles.inProgress}>
          <p>{t("practice:section.inProgress", { date: formatDateTime(inProgress.startedAt) })}</p>
          <div className={styles.sectionActions}>
            <Link
              className={styles.linkButton}
              to="/practice/attempts/$attemptId"
              params={{ attemptId: inProgress.id }}
            >
              {t("practice:section.resume")}
            </Link>
            <Button variant="danger" onPress={() => setDiscardOpen(true)}>
              {t("practice:section.discard")}
            </Button>
          </div>
          <ConfirmDialog
            isOpen={discardOpen}
            onOpenChange={setDiscardOpen}
            title={t("practice:section.discardTitle")}
            confirmLabel={t("practice:section.discardConfirm")}
            cancelLabel={t("common:cancel")}
            variant="danger"
            onConfirm={() => discard.mutate(inProgress.id)}
            isPending={discard.isPending}
          >
            <p>{t("practice:section.discardBody")}</p>
            <ErrorMessage error={discard.error} />
          </ConfirmDialog>
        </div>
      ) : null}
      <div className={styles.sectionActions}>
        <Button
          variant={inProgress ? "secondary" : "primary"}
          onPress={() => start.mutate("full")}
          isDisabled={archived || start.isPending}
        >
          {t("practice:section.take")}
        </Button>
        <RetakeMissedButton testId={testId} missedCount={history.data?.missedCount} isDisabled={archived} />
      </div>
      <ErrorMessage error={start.error} />

      <h3 className={styles.historyTitle}>{t("practice:history.title")}</h3>
      {history.data && history.data.attempts.length === 0 ? <p>{t("practice:history.empty")}</p> : null}
      {history.data && history.data.attempts.length > 0 ? <HistoryTable attempts={history.data.attempts} /> : null}
    </Card>
  );
}
