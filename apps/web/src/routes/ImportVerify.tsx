import type { VerificationItem } from "@gem/shared";
import { importVerifyGet, importVerifyStart, llmRoles } from "@gem/shared/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client.ts";
import { formatNumber } from "../format.ts";
import { Button, Card, ErrorMessage, errorText } from "../ui/controls.tsx";
import { useLive } from "../ui/live.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import styles from "./Import.module.css";

const POLL_MS = 1000;

const ICONS: Record<VerificationItem["outcome"], string> = {
  verified: "✓",
  wrong_answer: "✕",
  no_match: "✕",
  ambiguous: "✕",
  couldnt_check: "?",
  not_computable: "–",
  denied: "✕",
};

const TONES: Record<VerificationItem["outcome"], string | undefined> = {
  verified: styles.badgeGood,
  wrong_answer: styles.badgeBad,
  no_match: styles.badgeBad,
  ambiguous: styles.badgeBad,
  couldnt_check: styles.badgeWarn,
  not_computable: styles.badgePlain,
  denied: styles.badgeBad,
};

export interface FixChoices {
  /** Question id → the fix the creator confirmed. */
  accepted: Record<number, string>;
  /** Question ids where they kept their own answer. */
  kept: Record<number, boolean>;
}

function ResultDetails({ item }: { item: VerificationItem }) {
  const { t } = useTranslation();
  const { blind } = item;
  if (!blind) return null;
  return (
    <details className={styles.fixDetails}>
      <summary>{t("import:verify.details", { id: item.questionId })}</summary>
      <h3>{t("import:verify.program")}</h3>
      <pre className={styles.program}>
        <code>{blind.program}</code>
      </pre>
      <h3>{t("import:verify.result")}</h3>
      {/* Text from a program: rendered by KaTeX with `trust: false`, never evaluated (SPEC §3A.3.1). */}
      {blind.result ? <Markdown inline>{blind.result.text}</Markdown> : <p>{blind.error}</p>}
      {blind.repaired ? <p className={styles.hint}>{t("import:verify.repaired")}</p> : null}
    </details>
  );
}

function ItemRow({
  item,
  choices,
  onAccept,
  onKeep,
}: {
  item: VerificationItem;
  choices: FixChoices;
  onAccept: (id: number, fix: string) => void;
  onKeep: (id: number) => void;
}) {
  const { t } = useTranslation();
  const id = item.questionId;
  const fix = item.suggestedFix;
  const accepted = choices.accepted[id] !== undefined;
  const kept = choices.kept[id] === true;
  return (
    <li className={styles.verifyItem}>
      <strong>{t("tests:question.heading", { id })}</strong>{" "}
      <span className={TONES[item.outcome]}>
        <span aria-hidden="true">{ICONS[item.outcome]} </span>
        {t(`import:verify.outcomes.${item.outcome}`)}
      </span>
      {item.reason !== "ok" ? <p className={styles.hint}>{t(`import:verify.reasons.${item.reason}`)}</p> : null}
      {fix !== null ? (
        <div className={styles.fix}>
          <p>
            {t("import:verify.suggested")} <Markdown inline>{fix}</Markdown>
          </p>
          {accepted ? <p className={styles.ok}>{t("import:verify.accepted")}</p> : null}
          {kept ? <p className={styles.blocked}>{t("import:verify.kept")}</p> : null}
          <div className={styles.row}>
            <Button variant="secondary" onPress={() => onAccept(id, fix)} isDisabled={accepted}>
              {t("import:verify.accept", { id })}
            </Button>
            <Button variant="secondary" onPress={() => onKeep(id)} isDisabled={kept}>
              {t("import:verify.keep", { id })}
            </Button>
          </div>
        </div>
      ) : null}
      <ResultDetails item={item} />
    </li>
  );
}

export function VerifyPanel({
  value,
  jobId,
  onJob,
  onItems,
  choices,
  onAccept,
  onKeep,
}: {
  /** The normalized value, or null when no JSON could be recovered. */
  value: Record<string, unknown> | null;
  jobId: string | null;
  onJob: (id: string) => void;
  onItems: (items: VerificationItem[], done: boolean) => void;
  choices: FixChoices;
  onAccept: (id: number, fix: string) => void;
  onKeep: (id: number) => void;
}) {
  const { t } = useTranslation();
  const { announce } = useLive();
  const roles = useQuery({ queryKey: ["llm", "roles"], queryFn: () => api.call(llmRoles) });
  const assigned = roles.data?.roles.find((r) => r.role === "verify.solve")?.assigned ?? false;

  const start = useMutation({
    mutationFn: () => api.call(importVerifyStart, { body: { value: value as { questions: unknown[] } } }),
    onSuccess: ({ job }) => {
      onJob(job.id);
      announce(t("import:verify.started"));
    },
    onError: (e) => announce(errorText(t, e)),
  });

  const job = useQuery({
    queryKey: ["verify-job", jobId],
    queryFn: () => api.call(importVerifyGet, { params: { id: jobId as string } }),
    enabled: jobId !== null,
    refetchInterval: (q) => {
      const status = q.state.data?.job.status;
      return status === "done" || status === "failed" ? false : POLL_MS;
    },
  });

  const current = job.data?.job;
  const summary = current?.summary ?? null;
  const finished = current?.status === "done" || current?.status === "failed";
  const announced = useRef(-1);
  useEffect(() => {
    if (!current) return;
    onItems(current.items, current.status === "done");
    if (!summary || announced.current === summary.done) return;
    announced.current = summary.done;
    if (!finished) {
      announce(t("import:verify.progress", { done: summary.done, total: summary.total }));
    }
  }, [current, summary, finished, announce, onItems, t]);

  useEffect(() => {
    if (current?.status === "done" && summary) {
      const wrong = current.items.filter((i) => i.outcome === "wrong_answer").length;
      announce(t("import:verify.finished", { total: summary.total, count: wrong }));
    }
    if (current?.status === "failed") announce(t(`errors:${current.errorCode ?? "internal"}`));
  }, [current?.status, current?.items, current?.errorCode, summary, announce, t]);

  return (
    <Card title={t("import:verify.title")}>
      <p>{t("import:verify.help")}</p>
      {assigned ? null : <p className={styles.hint}>{t("import:verify.unassigned")}</p>}
      <Button
        onPress={() => start.mutate()}
        isDisabled={!assigned || value === null || start.isPending || (jobId !== null && !finished)}
      >
        {t("import:verify.run")}
      </Button>
      <ErrorMessage error={start.error ?? job.error} />
      {summary ? (
        <p>
          {t("import:verify.progress", {
            done: formatNumber(summary.done),
            total: formatNumber(summary.total),
          })}
        </p>
      ) : null}
      {current?.status === "failed" ? (
        <p className={styles.blocked}>{t(`errors:${current.errorCode ?? "internal"}`)}</p>
      ) : null}
      {current && current.items.length > 0 ? (
        <ul className={styles.verifyList}>
          {current.items.map((item) => (
            <ItemRow key={item.questionId} item={item} choices={choices} onAccept={onAccept} onKeep={onKeep} />
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
