import { EVAL_METRICS, type EvalMetric, type EvalRunSummary, type EvalStatus } from "@gem/shared";
import { adminLlmEvalsGet, adminLlmEvalsList, adminLlmEvalsRun } from "@gem/shared/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Form } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client.ts";
import { formatDateTime, formatDuration, formatNumber, formatPercent, formatSeconds } from "../../format.ts";
import { Button, Card, ErrorMessage, Select, TextField } from "../../ui/controls.tsx";
import styles from "../Admin.module.css";
import { EVALS_KEY, ScrollTable, STATS_KEY, useFeedback, useRoleName } from "./shared.tsx";

const POLL_MS = 1000;
const ACTIVE: EvalStatus[] = ["queued", "running"];
const isActive = (run: EvalRunSummary) => ACTIVE.includes(run.status);

const RATES: EvalMetric[] = ["validFirstTry", "validAfterRepairs", "evidenceVerbatim", "top1", "top1NoPrefix"];

function metricValue(name: EvalMetric, value: number): string {
  if (name === "secondsPerQuestion") return formatSeconds(value * 1000);
  return RATES.includes(name) ? formatPercent(value * 100) : formatNumber(value);
}

function EvalReport({ run }: { run: EvalRunSummary }) {
  const { t } = useTranslation();
  const detail = useQuery({
    queryKey: [...EVALS_KEY, run.id, run.status],
    queryFn: () => api.call(adminLlmEvalsGet, { params: { id: run.id } }),
  });
  const summary = Object.entries(run.summary ?? {}).filter((e): e is [EvalMetric, number | null] =>
    EVAL_METRICS.some((m) => m === e[0]),
  );
  return (
    <section>
      <h3>{t("admin:llm.evals.reportTitle", { evalSet: run.evalSet, model: run.model })}</h3>
      <p>{t("admin:llm.evals.reportLine", { endpoint: run.endpointLabel, prompt: run.promptVersion })}</p>
      {run.errorCode ? <p className={styles.warning}>{t(`errors:${run.errorCode}`)}</p> : null}
      {summary.length > 0 ? (
        <ScrollTable label={t("admin:llm.evals.reportTitle", { evalSet: run.evalSet, model: run.model })}>
          <table>
            <thead>
              <tr>
                <th scope="col">{t("admin:llm.evals.colMetric")}</th>
                <th scope="col">{t("admin:llm.evals.colValue")}</th>
              </tr>
            </thead>
            <tbody>
              {summary.map(([name, value]) => (
                <tr key={name}>
                  <th scope="row">{t(`admin:llm.evals.metrics.${name}`)}</th>
                  <td>{value === null ? t("admin:llm.evals.noValue") : metricValue(name, value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollTable>
      ) : null}
      <ErrorMessage error={detail.error} />
      {detail.data?.run.items?.length ? (
        <details className={styles.items}>
          <summary>{t("admin:llm.evals.items", { count: detail.data.run.items.length })}</summary>
          <ul>
            {detail.data.run.items.map((item) => (
              <li key={JSON.stringify(item)}>
                <code className={styles.change}>{JSON.stringify(item)}</code>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function runDuration(run: EvalRunSummary): string {
  if (!run.startedAt || !run.finishedAt) return "";
  return formatDuration(new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime());
}

export function EvalsCard() {
  const { t } = useTranslation();
  const feedback = useFeedback();
  const roleName = useRoleName();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: EVALS_KEY,
    queryFn: () => api.call(adminLlmEvalsList, { query: {} }),
    refetchInterval: (q) => (q.state.data?.runs.some(isActive) ? POLL_MS : false),
  });
  const runs = query.data?.runs;
  const [evalSet, setEvalSet] = useState("");
  const [trials, setTrials] = useState("");
  const [shownId, setShownId] = useState<string | null>(null);
  const chosenSet = evalSet || (query.data?.evalSets[0] ?? "");
  const start = useMutation({
    mutationFn: () =>
      api.call(adminLlmEvalsRun, {
        body: { evalSet: chosenSet, ...(trials ? { trials: Number(trials) } : {}) },
      }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: EVALS_KEY });
      setShownId(r.run.id);
      feedback.done(t("admin:llm.evals.started", { evalSet: r.run.evalSet }));
    },
    onError: feedback.failed,
  });

  // A run that was active on the last poll and isn't any more has just finished.
  const active = useRef(new Set<string>());
  const { done } = feedback;
  useEffect(() => {
    if (!runs) return;
    const finished = runs.filter((r) => active.current.has(r.id) && !isActive(r));
    active.current = new Set(runs.filter(isActive).map((r) => r.id));
    for (const r of finished) {
      done(t("admin:llm.evals.finished", { evalSet: r.evalSet, status: t(`admin:llm.evals.statuses.${r.status}`) }));
    }
    if (finished.length > 0) void qc.invalidateQueries({ queryKey: STATS_KEY });
  }, [runs, qc, t, done]);

  const shown = runs?.find((r) => r.id === shownId);
  return (
    <Card title={t("admin:llm.evals.title")}>
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          start.mutate();
        }}
      >
        <div className={styles.fieldRow}>
          <Select
            label={t("admin:llm.evals.set")}
            selectedKey={chosenSet}
            onSelectionChange={setEvalSet}
            options={(query.data?.evalSets ?? []).map((s) => ({ id: s, label: s }))}
          />
          <TextField
            label={t("admin:llm.evals.trials")}
            description={t("admin:llm.evals.trialsHelp")}
            inputType="number"
            value={trials}
            onChange={setTrials}
          />
        </div>
        <Button type="submit" isDisabled={start.isPending || !chosenSet}>
          {t("admin:llm.evals.start")}
        </Button>
      </Form>
      <ErrorMessage error={start.error ?? query.error} />
      {runs?.length === 0 ? <p>{t("admin:llm.evals.empty")}</p> : null}
      {runs && runs.length > 0 ? (
        <ScrollTable label={t("admin:llm.evals.title")}>
          <table>
            <thead>
              <tr>
                <th scope="col">{t("admin:llm.evals.set")}</th>
                <th scope="col">{t("admin:llm.evals.colRole")}</th>
                <th scope="col">{t("admin:llm.roles.colModel")}</th>
                <th scope="col">{t("admin:llm.evals.colStatus")}</th>
                <th scope="col">{t("admin:llm.evals.colQueued")}</th>
                <th scope="col">{t("admin:llm.evals.colDuration")}</th>
                <th scope="col">{t("admin:llm.evals.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <th scope="row">{r.evalSet}</th>
                  <td>{roleName(r.role)}</td>
                  <td>{r.model}</td>
                  <td>{t(`admin:llm.evals.statuses.${r.status}`)}</td>
                  <td>{formatDateTime(r.createdAt)}</td>
                  <td>{runDuration(r)}</td>
                  <td>
                    <Button
                      variant="secondary"
                      aria-label={t("admin:llm.evals.viewFor", {
                        evalSet: r.evalSet,
                        date: formatDateTime(r.createdAt),
                      })}
                      onPress={() => setShownId(r.id)}
                    >
                      {t("admin:llm.evals.view")}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollTable>
      ) : null}
      {shown ? <EvalReport run={shown} /> : null}
    </Card>
  );
}
