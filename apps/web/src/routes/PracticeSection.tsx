import { type PracticeKind, practiceDiscard, practiceList, practiceStart } from "@gem/shared/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiClientError, api } from "../api/client.ts";
import { formatDateTime } from "../format.ts";
import { ConfirmDialog } from "../ui/ConfirmDialog.tsx";
import { Button, Card, ErrorMessage, errorText } from "../ui/controls.tsx";
import { useLive } from "../ui/live.tsx";
import styles from "./Practice.module.css";

export const historyKey = (testId: string) => ["practice", "history", testId] as const;

/** The test detail page's Practice section (P1.md §6): take the test, resume or discard an attempt. */
export function PracticeSection({ testId, archived }: { testId: string; archived: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { announce } = useLive();
  const [discardOpen, setDiscardOpen] = useState(false);
  const history = useQuery({
    queryKey: historyKey(testId),
    queryFn: () => api.call(practiceList, { query: { testId } }),
  });
  const inProgress = history.data?.attempts.find((a) => a.status === "in_progress");

  const start = useMutation({
    mutationFn: (kind: PracticeKind) => api.call(practiceStart, { body: { testId, kind } }),
    onSuccess: async ({ attempt }) => {
      await qc.invalidateQueries({ queryKey: ["practice"] });
      await navigate({ to: "/practice/attempts/$attemptId", params: { attemptId: attempt.id } });
    },
    onError: async (e) => {
      announce(errorText(t, e));
      if (e instanceof ApiClientError && e.code === "practice_attempt_in_progress") {
        await qc.invalidateQueries({ queryKey: historyKey(testId) });
      }
    },
  });

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
      </div>
      <ErrorMessage error={start.error} />
    </Card>
  );
}
