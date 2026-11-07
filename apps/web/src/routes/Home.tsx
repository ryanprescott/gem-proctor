import { practiceList } from "@gem/shared/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link, Navigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api } from "../api/client.ts";
import { atLeast, useMe } from "../auth.tsx";
import { formatDateTime } from "../format.ts";
import { ButtonLink, Card, ErrorMessage } from "../ui/controls.tsx";
import { useDocumentTitle } from "../ui/live.tsx";
import styles from "./Home.module.css";
import { scoreText } from "./PracticeSection.tsx";

/** The five most recent practice attempts, across tests (P1.md §6). */
function RecentAttempts() {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["practice", "recent"],
    queryFn: () => api.call(practiceList, { query: { limit: 5 } }),
  });
  return (
    <Card title={t("common:home.recentTitle")}>
      <ErrorMessage error={query.error} />
      {query.data && query.data.attempts.length === 0 ? <p>{t("common:home.recentEmpty")}</p> : null}
      {query.data && query.data.attempts.length > 0 ? (
        <ul>
          {query.data.attempts.map((a) => (
            <li key={a.id}>
              {a.status === "submitted" ? (
                <Link to="/practice/attempts/$attemptId/results" params={{ attemptId: a.id }}>
                  {a.testTitle}
                </Link>
              ) : (
                <Link to="/practice/attempts/$attemptId" params={{ attemptId: a.id }}>
                  {a.testTitle}
                </Link>
              )}{" "}
              {t("common:home.recentItem", { date: formatDateTime(a.startedAt), score: scoreText(t, a) })}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

export function HomePage() {
  const { t } = useTranslation();
  useDocumentTitle(t("common:home.title"));
  const { data: user, isPending } = useMe();
  if (isPending) return <p>{t("common:loading")}</p>;
  if (!user) return <Navigate to="/sign-in" />;
  const isProctor = atLeast(user, "proctor");
  const isAdmin = atLeast(user, "admin");
  return (
    <>
      <h1>{t("common:home.welcome", { name: user.displayName })}</h1>
      <p>{t("common:home.role", { role: t(`common:roles.${user.role}`) })}</p>
      {isProctor ? (
        <Card title={t("common:home.proctorTitle")}>
          <p>{t("common:home.proctorBody")}</p>
          <div className={styles.actions}>
            <ButtonLink href="/tests" size="small">
              {t("common:home.testsLink")}
            </ButtonLink>
            <ButtonLink href="/import" size="small">
              {t("common:home.importLink")}
            </ButtonLink>
          </div>
        </Card>
      ) : null}
      {isProctor ? (
        <RecentAttempts />
      ) : (
        <Card title={t("common:home.studentTitle")}>
          <p>{t("common:home.studentBody")}</p>
        </Card>
      )}
      {isAdmin ? (
        <Card title={t("common:home.adminTitle")}>
          <div className={styles.actions}>
            <ButtonLink href="/admin/users" size="small">
              {t("common:nav.users")}
            </ButtonLink>
            <ButtonLink href="/admin/settings" size="small">
              {t("common:nav.settings")}
            </ButtonLink>
            <ButtonLink href="/admin/llm" size="small">
              {t("common:nav.llm")}
            </ButtonLink>
            <ButtonLink href="/admin/audit-log" size="small">
              {t("common:nav.auditLog")}
            </ButtonLink>
          </div>
        </Card>
      ) : null}
    </>
  );
}

export function NotFoundPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("common:notFound.title"));
  return (
    <>
      <h1>{t("common:notFound.title")}</h1>
      <p>{t("common:notFound.body")}</p>
      <Link to="/">{t("common:notFound.home")}</Link>
    </>
  );
}
