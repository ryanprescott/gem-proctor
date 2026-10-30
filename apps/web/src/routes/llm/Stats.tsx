import { MODEL_ROLES, type ModelRole, type StatsRow } from "@gem/shared";
import { adminLlmStats } from "@gem/shared/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client.ts";
import { formatNumber, formatPercent, formatSeconds } from "../../format.ts";
import { Card, ErrorMessage, TextField } from "../../ui/controls.tsx";
import { dayStart } from "../Admin.tsx";
import { ScrollTable, STATS_KEY, useRoleName } from "./shared.tsx";

function Failures({ row }: { row: StatsRow }) {
  const { t } = useTranslation();
  const entries = Object.entries(row.failures);
  if (entries.length === 0) return <>{formatNumber(0)}</>;
  return (
    <ul>
      {entries.map(([code, n]) => (
        <li key={code}>{t("admin:llm.stats.failure", { code, count: formatNumber(n) })}</li>
      ))}
    </ul>
  );
}

export function StatsCard() {
  const { t } = useTranslation();
  const roleName = useRoleName();
  const [from, setFrom] = useState("");
  const since = dayStart(from);
  const query = useQuery({
    queryKey: [...STATS_KEY, since],
    queryFn: () => api.call(adminLlmStats, { query: { since } }),
  });
  const known = (role: string | null): role is ModelRole => MODEL_ROLES.some((r) => r === role);
  return (
    <Card title={t("admin:llm.stats.title")}>
      <TextField label={t("admin:llm.stats.since")} inputType="date" value={from} onChange={setFrom} />
      <ErrorMessage error={query.error} />
      {query.data?.rows.length === 0 ? <p>{t("admin:llm.stats.empty")}</p> : null}
      {query.data && query.data.rows.length > 0 ? (
        <ScrollTable label={t("admin:llm.stats.title")}>
          <table>
            <thead>
              <tr>
                <th scope="col">{t("admin:llm.stats.colRole")}</th>
                <th scope="col">{t("admin:llm.roles.colEndpoint")}</th>
                <th scope="col">{t("admin:llm.roles.colModel")}</th>
                <th scope="col">{t("admin:llm.stats.colCalls")}</th>
                <th scope="col">{t("admin:llm.stats.colFailures")}</th>
                <th scope="col">{t("admin:llm.stats.colRepair")}</th>
                <th scope="col">{t("admin:llm.stats.colSalvage")}</th>
                <th scope="col">{t("admin:llm.stats.colP50")}</th>
                <th scope="col">{t("admin:llm.stats.colP95")}</th>
                <th scope="col">{t("admin:llm.stats.colQueue")}</th>
                <th scope="col">{t("admin:llm.stats.colTokensIn")}</th>
                <th scope="col">{t("admin:llm.stats.colTokensOut")}</th>
              </tr>
            </thead>
            <tbody>
              {query.data.rows.map((r) => (
                <tr key={`${r.role}/${r.endpointId}/${r.model}`}>
                  <th scope="row">{known(r.role) ? roleName(r.role) : t("admin:llm.stats.noRole")}</th>
                  <td>{r.endpointLabel}</td>
                  <td>{r.model}</td>
                  <td>{formatNumber(r.calls)}</td>
                  <td>
                    <Failures row={r} />
                  </td>
                  <td>{formatPercent(r.repairRate * 100)}</td>
                  <td>{formatPercent(r.salvageRate * 100)}</td>
                  <td>{formatSeconds(r.latencyP50Ms)}</td>
                  <td>{formatSeconds(r.latencyP95Ms)}</td>
                  <td>{formatSeconds(r.queueP95Ms)}</td>
                  <td>{formatNumber(r.tokensIn)}</td>
                  <td>{formatNumber(r.tokensOut)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollTable>
      ) : null}
    </Card>
  );
}
